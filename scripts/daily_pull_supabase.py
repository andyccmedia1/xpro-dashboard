#!/usr/bin/env python3
"""
Daily Amazon data pull → Supabase.

Fetches yesterday's SP-API revenue + per-ASIN traffic and Advertising API
PPC spend, then upserts only the Amazon columns into Supabase — CSV-loaded
channels (Shopify, TikTok, Meta) are never touched.

Usage:
    python scripts/daily_pull_supabase.py               # yesterday
    python scripts/daily_pull_supabase.py --date 2026-05-20
    python scripts/daily_pull_supabase.py --brand myco

Required env vars:
    AMAZON_SP_CLIENT_ID, AMAZON_SP_CLIENT_SECRET, AMAZON_SP_REFRESH_TOKEN
    AMAZON_MARKETPLACE_ID          (default: ATVPDKIKX0DER = US)
    AMAZON_ADS_CLIENT_ID, AMAZON_ADS_CLIENT_SECRET
    AMAZON_ADS_REFRESH_TOKEN, AMAZON_ADS_PROFILE_ID
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
    ACTIVE_BRAND                   (default: xpro)
"""

import argparse
import gzip
import json
import logging
import os
import sys
import time
from datetime import date, timedelta

import requests
from dotenv import load_dotenv
from sp_api.api import Reports
from sp_api.base import Marketplaces

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)


# ── Config ─────────────────────────────────────────────────────────────────────

def _require(name: str) -> str:
    val = os.getenv(name)
    if not val:
        sys.exit(f"ERROR: env var {name} is not set")
    return val


SP_CREDS = {
    "lwa_app_id":        _require("AMAZON_SP_CLIENT_ID"),
    "lwa_client_secret": _require("AMAZON_SP_CLIENT_SECRET"),
    "refresh_token":     _require("AMAZON_SP_REFRESH_TOKEN"),
}
SP_MARKETPLACE_ID = os.getenv("AMAZON_MARKETPLACE_ID", "ATVPDKIKX0DER")

ADS_CLIENT_ID     = _require("AMAZON_ADS_CLIENT_ID")
ADS_CLIENT_SECRET = _require("AMAZON_ADS_CLIENT_SECRET")
ADS_REFRESH_TOKEN = _require("AMAZON_ADS_REFRESH_TOKEN")
ADS_PROFILE_ID    = _require("AMAZON_ADS_PROFILE_ID")

SUPABASE_URL = _require("SUPABASE_URL").rstrip("/")
SERVICE_KEY  = _require("SUPABASE_SERVICE_ROLE_KEY")
ACTIVE_BRAND = os.getenv("ACTIVE_BRAND", "xpro")

_ADS_TOKEN_URL = "https://api.amazon.com/auth/o2/token"
_ADS_BASE_URL  = "https://advertising-api.amazon.com"

# SP/SB/SD — summed per day
_AD_TYPES = [
    {"adProduct": "SPONSORED_PRODUCTS", "reportTypeId": "spCampaigns", "label": "SP"},
    {"adProduct": "SPONSORED_BRANDS",   "reportTypeId": "sbCampaigns", "label": "SB"},
    {"adProduct": "SPONSORED_DISPLAY",  "reportTypeId": "sdCampaigns", "label": "SD"},
]
# SB and SD reports retain ~59 days; skip if target is older
_SB_SD_RETENTION_DAYS = 59
# Short pause between ad-type report requests to avoid 429s
_AD_TYPE_PAUSE_SECONDS = 30


# ── SP-API ─────────────────────────────────────────────────────────────────────

def sp_pull(target: date) -> tuple[dict[str, float], dict[str, dict]]:
    """
    Returns:
        daily_revenue  — {'YYYY-MM-DD': ordered_product_sales}
        asin_traffic   — {child_asin: {sessions, units_ordered, …}}
    """
    api = Reports(credentials=SP_CREDS, marketplace=Marketplaces.US)

    log.info(f"Requesting SP-API GET_SALES_AND_TRAFFIC_REPORT for {target}…")
    resp = api.create_report(
        reportType="GET_SALES_AND_TRAFFIC_REPORT",
        dataStartTime=target.strftime("%Y-%m-%dT00:00:00Z"),
        dataEndTime=target.strftime("%Y-%m-%dT23:59:59Z"),
        reportOptions={"dateGranularity": "DAY", "asinGranularity": "CHILD"},
        marketplaceIds=[SP_MARKETPLACE_ID],
    )
    report_id = resp.payload["reportId"]
    log.info(f"Report requested: {report_id} — polling every 30s…")

    doc_id  = _sp_wait(api, report_id)
    content = _sp_download(api, doc_id)

    daily_revenue = _sp_parse_daily(content)
    asin_traffic  = _sp_parse_asin(content)
    return daily_revenue, asin_traffic


def _sp_wait(api: Reports, report_id: str, timeout: int = 900, interval: int = 30) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r      = api.get_report(reportId=report_id)
        status = r.payload["processingStatus"]
        log.debug(f"  SP report status: {status}")
        if status == "DONE":
            return r.payload["reportDocumentId"]
        if status in ("FATAL", "CANCELLED"):
            raise RuntimeError(f"SP-API report {report_id} ended with status: {status}")
        time.sleep(interval)
    raise RuntimeError(f"SP-API report {report_id} did not finish within {timeout}s")


def _sp_download(api: Reports, doc_id: str) -> str:
    doc = api.get_report_document(reportDocumentId=doc_id).payload
    raw = requests.get(doc["url"], timeout=120).content
    if doc.get("compressionAlgorithm") == "GZIP":
        return gzip.decompress(raw).decode("utf-8")
    return raw.decode("utf-8")


def _sp_parse_daily(content: str) -> dict[str, float]:
    data: dict = json.loads(content)
    out: dict[str, float] = {}
    for entry in data.get("salesAndTrafficByDate", []):
        day = entry.get("date", "").strip()
        if not day:
            continue
        amount = (
            entry.get("salesByDate", {})
                 .get("orderedProductSales", {})
                 .get("amount", 0) or 0
        )
        out[day] = out.get(day, 0.0) + float(amount)
    return out


def _sp_parse_asin(content: str) -> dict[str, dict]:
    """
    Parse per-child-ASIN metrics.
    Percentages (unitSessionPercentage, buyBoxPercentage) arrive as 0–100 values;
    we store them as 0–1 decimals to match the dashboard's display logic.
    """
    data: dict = json.loads(content)
    out: dict[str, dict] = {}
    for entry in data.get("salesAndTrafficByAsin", []):
        child = entry.get("childAsin", "").strip()
        if not child:
            continue
        traffic = entry.get("trafficByAsin", {})
        sales   = entry.get("salesByAsin",   {})
        pct_raw = traffic.get("unitSessionPercentage")
        bb_raw  = traffic.get("buyBoxPercentage")
        out[child] = {
            "parent_asin":           (entry.get("parentAsin") or "").strip() or None,
            "sessions":              _to_int(traffic.get("sessions")),
            "page_views":            _to_int(traffic.get("pageViews")),
            "units_ordered":         _to_int(sales.get("unitsOrdered")),
            "ordered_product_sales": _to_float(
                sales.get("orderedProductSales", {}).get("amount")
            ),
            # Divide by 100: Amazon sends e.g. 12.5 meaning 12.5% → store 0.125
            "unit_session_pct": round(_to_float(pct_raw) / 100, 6) if pct_raw is not None else None,
            "buy_box_pct":      round(_to_float(bb_raw)  / 100, 6) if bb_raw  is not None else None,
        }
    return out


# ── Ads API ────────────────────────────────────────────────────────────────────

def ads_pull(target: date) -> dict[str, float]:
    """Return {'YYYY-MM-DD': total_spend} summed across SP + SB + SD."""
    token   = _ads_token()
    headers = _ads_headers(token)
    daily: dict[str, float] = {}
    retention_cutoff = date.today() - timedelta(days=_SB_SD_RETENTION_DAYS)

    for i, ad_type in enumerate(_AD_TYPES):
        if i > 0:
            log.info(f"Pausing {_AD_TYPE_PAUSE_SECONDS}s before {ad_type['label']} request…")
            time.sleep(_AD_TYPE_PAUSE_SECONDS)

        if ad_type["label"] in ("SB", "SD") and target < retention_cutoff:
            log.info(f"Skipping {ad_type['label']}: {target} is outside the {_SB_SD_RETENTION_DAYS}-day retention window")
            continue

        log.info(f"Requesting {ad_type['label']} Ads report for {target}…")
        try:
            report_id = _ads_request_report(headers, target, ad_type)
            url       = _ads_wait(headers, report_id)
            chunk     = _ads_parse(url)
            for day, spend in chunk.items():
                daily[day] = daily.get(day, 0.0) + spend
            log.info(f"  {ad_type['label']} done: {chunk}")
        except Exception as exc:
            log.warning(f"  {ad_type['label']} report failed (skipping): {exc}")

    return daily


def _ads_token() -> str:
    resp = requests.post(
        _ADS_TOKEN_URL,
        data={
            "grant_type":    "refresh_token",
            "client_id":     ADS_CLIENT_ID,
            "client_secret": ADS_CLIENT_SECRET,
            "refresh_token": ADS_REFRESH_TOKEN,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def _ads_headers(token: str) -> dict:
    return {
        "Authorization":                    f"Bearer {token}",
        "Amazon-Advertising-API-ClientId":  ADS_CLIENT_ID,
        "Amazon-Advertising-API-Scope":     str(ADS_PROFILE_ID),
        "Content-Type":                     "application/json",
        "Accept":                           "application/json",
    }


def _ads_request_report(headers: dict, target: date, ad_type: dict) -> str:
    ds = target.strftime("%Y-%m-%d")
    resp = requests.post(
        f"{_ADS_BASE_URL}/reporting/reports",
        headers=headers,
        json={
            "name":      f"Daily {ad_type['label']} {ds}",
            "startDate": ds,
            "endDate":   ds,
            "configuration": {
                "adProduct":    ad_type["adProduct"],
                "groupBy":      ["campaign"],
                "columns":      ["date", "cost"],
                "reportTypeId": ad_type["reportTypeId"],
                "timeUnit":     "DAILY",
                "format":       "GZIP_JSON",
            },
        },
        timeout=30,
    )
    if not resp.ok:
        log.error(f"Ads report request failed {resp.status_code}: {resp.text[:300]}")
    resp.raise_for_status()
    return resp.json()["reportId"]


def _ads_wait(headers: dict, report_id: str, timeout: int = 600, interval: int = 20) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = requests.get(
            f"{_ADS_BASE_URL}/reporting/reports/{report_id}",
            headers=headers,
            timeout=30,
        )
        resp.raise_for_status()
        data   = resp.json()
        status = data.get("status")
        log.debug(f"  Ads report {report_id} status: {status}")
        if status == "COMPLETED":
            return data["url"]
        if status in ("FAILURE", "CANCELLED"):
            raise RuntimeError(f"Ads report {report_id}: {status} — {data.get('statusDetails', '')}")
        time.sleep(interval)
    raise RuntimeError(f"Ads report {report_id} timed out after {timeout}s")


def _ads_parse(url: str) -> dict[str, float]:
    raw     = requests.get(url, timeout=120).content
    records = json.loads(gzip.decompress(raw).decode("utf-8"))
    daily: dict[str, float] = {}
    for rec in records:
        day  = rec.get("date", "").strip()
        cost = float(rec.get("cost", 0) or 0)
        if day:
            daily[day] = daily.get(day, 0.0) + cost
    return daily


# ── Supabase ───────────────────────────────────────────────────────────────────

def _sb_headers() -> dict:
    return {
        "apikey":        SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type":  "application/json",
        # merge-duplicates: only updates columns present in the payload —
        # CSV-loaded channels (shopify, tiktok, meta) are never overwritten.
        "Prefer":        "resolution=merge-duplicates",
    }


def supabase_upsert(table: str, rows: list[dict]) -> None:
    if not rows:
        return
    url  = f"{SUPABASE_URL}/rest/v1/{table}"
    resp = requests.post(
        url,
        headers=_sb_headers(),
        data=json.dumps(rows, default=str),
        timeout=60,
    )
    if not resp.ok:
        log.error(f"Supabase {table} {resp.status_code}: {resp.text[:400]}")
        resp.raise_for_status()
    log.info(f"✓ Upserted {len(rows)} row(s) → {table}")


# ── Helpers ────────────────────────────────────────────────────────────────────

def _to_int(v) -> int | None:
    try:
        return int(v) if v is not None else None
    except (ValueError, TypeError):
        return None


def _to_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (ValueError, TypeError):
        return None


# ── Orchestration ──────────────────────────────────────────────────────────────

def pull_day(target: date, brand: str) -> None:
    log.info(f"{'='*60}")
    log.info(f"Pulling Amazon data for {target}  (brand: {brand})")
    log.info(f"{'='*60}")

    # ── 1. SP-API ──────────────────────────────────────────────
    revenue: float | None = None
    asin_traffic: dict[str, dict] = {}
    try:
        daily_rev, asin_traffic = sp_pull(target)
        revenue = daily_rev.get(target.strftime("%Y-%m-%d"))
        log.info(f"SP-API revenue for {target}: {revenue}")
    except Exception as exc:
        log.error(f"SP-API pull failed — skipping revenue/ASIN data: {exc}")

    # ── 2. Ads API ─────────────────────────────────────────────
    spend: float | None = None
    try:
        spend_map = ads_pull(target)
        spend = spend_map.get(target.strftime("%Y-%m-%d"))
        log.info(f"Ads API spend for {target}: {spend}")
    except Exception as exc:
        log.error(f"Ads API pull failed — skipping PPC spend: {exc}")

    # ── 3. Upsert daily_data (Amazon columns only) ─────────────
    # Omitting shopify_revenue, tiktok_shop_revenue, tiktok_ads_spend,
    # meta_ads_spend so merge-duplicates leaves existing CSV data intact.
    supabase_upsert("daily_data", [{
        "date":             target.strftime("%Y-%m-%d"),
        "brand":            brand,
        "amazon_revenue":   revenue,
        "amazon_ppc_spend": spend,
    }])

    # ── 4. Upsert asin_daily_data ──────────────────────────────
    if asin_traffic:
        asin_rows = [
            {
                "date":                  target.strftime("%Y-%m-%d"),
                "asin":                  asin,
                "brand":                 brand,
                "parent_asin":           m.get("parent_asin"),
                "sessions":              m.get("sessions"),
                "page_views":            m.get("page_views"),
                "units_ordered":         m.get("units_ordered"),
                "ordered_product_sales": m.get("ordered_product_sales"),
                "unit_session_pct":      m.get("unit_session_pct"),
                "buy_box_pct":           m.get("buy_box_pct"),
            }
            for asin, m in asin_traffic.items()
        ]
        supabase_upsert("asin_daily_data", asin_rows)

    # ── Summary ────────────────────────────────────────────────
    print()
    print(f"  Date:      {target}")
    print(f"  Revenue:   {'${:,.2f}'.format(revenue) if revenue is not None else 'FAILED / no data'}")
    print(f"  PPC Spend: {'${:,.2f}'.format(spend)   if spend   is not None else 'FAILED / no data'}")
    print(f"  ASINs:     {len(asin_traffic)}")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Pull yesterday's Amazon data into Supabase")
    parser.add_argument("--date",  help="YYYY-MM-DD (default: yesterday)")
    parser.add_argument("--brand", default=ACTIVE_BRAND, help=f"Brand slug (default: {ACTIVE_BRAND})")
    args = parser.parse_args()

    target = date.fromisoformat(args.date) if args.date else date.today() - timedelta(days=1)
    pull_day(target, args.brand)


if __name__ == "__main__":
    main()

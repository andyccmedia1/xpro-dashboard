#!/usr/bin/env python3
"""
Amazon data pull → Supabase.

DAILY MODE (default — runs via cron):
    Pulls yesterday's data including per-ASIN traffic. One SP-API report +
    three Ads API reports. Takes ~4–8 minutes.

BACKFILL MODE (--start / --end):
    Pulls a full date range efficiently by batching into multi-day reports
    instead of looping one day at a time. A 90-day backfill takes ~20–40 min
    instead of 18+ hours. ASIN per-day data is skipped in backfill mode
    (daily pulls going forward will populate it).

Usage:
    python scripts/daily_pull_supabase.py                            # yesterday
    python scripts/daily_pull_supabase.py --date 2026-05-20         # single day
    python scripts/daily_pull_supabase.py --start 2026-01-01 --end 2026-05-24  # backfill

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
_SP_CHUNK_DAYS = 30   # SP-API: request at most 30 days per report
_ADS_CHUNK_DAYS = 30  # Ads API: maximum 30 days per report
_SB_SD_RETENTION_DAYS = 59  # SB/SD data retention window

_AD_TYPES = [
    {"adProduct": "SPONSORED_PRODUCTS", "reportTypeId": "spCampaigns", "label": "SP"},
    {"adProduct": "SPONSORED_BRANDS",   "reportTypeId": "sbCampaigns", "label": "SB"},
    {"adProduct": "SPONSORED_DISPLAY",  "reportTypeId": "sdCampaigns", "label": "SD"},
]


# ── Utilities ──────────────────────────────────────────────────────────────────

def date_range(start: date, end: date):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def chunk_dates(start: date, end: date, chunk_size: int):
    """Yield (chunk_start, chunk_end) tuples of at most chunk_size days."""
    chunk_start = start
    while chunk_start <= end:
        chunk_end = min(chunk_start + timedelta(days=chunk_size - 1), end)
        yield chunk_start, chunk_end
        chunk_start = chunk_end + timedelta(days=1)


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


# ── SP-API ─────────────────────────────────────────────────────────────────────

def sp_pull_revenue_range(start: date, end: date) -> dict[str, float]:
    """
    Pull daily ordered product sales for [start, end] using batched reports.
    Returns {'YYYY-MM-DD': revenue}.
    Chunks into 30-day windows automatically.
    """
    all_revenue: dict[str, float] = {}
    chunks = list(chunk_dates(start, end, _SP_CHUNK_DAYS))
    log.info(f"SP-API revenue: {len(chunks)} chunk(s) to request ({start} → {end})")

    for i, (cs, ce) in enumerate(chunks, 1):
        log.info(f"  SP-API chunk {i}/{len(chunks)}: {cs} → {ce}")
        api = Reports(credentials=SP_CREDS, marketplace=Marketplaces.US)
        resp = api.create_report(
            reportType="GET_SALES_AND_TRAFFIC_REPORT",
            dataStartTime=cs.strftime("%Y-%m-%dT00:00:00Z"),
            dataEndTime=ce.strftime("%Y-%m-%dT23:59:59Z"),
            reportOptions={"dateGranularity": "DAY", "asinGranularity": "CHILD"},
            marketplaceIds=[SP_MARKETPLACE_ID],
        )
        report_id = resp.payload["reportId"]
        log.info(f"    Report ID: {report_id} — polling…")
        doc_id  = _sp_wait(api, report_id)
        content = _sp_download(api, doc_id)
        chunk_revenue = _sp_parse_daily(content)
        all_revenue.update(chunk_revenue)
        log.info(f"    Got {len(chunk_revenue)} day(s) of revenue")

    return all_revenue


def sp_pull_single_day(target: date) -> tuple[dict[str, float], dict[str, dict]]:
    """
    Pull one day of revenue + per-ASIN traffic from SP-API.
    Returns (daily_revenue, asin_traffic).
    """
    api = Reports(credentials=SP_CREDS, marketplace=Marketplaces.US)
    log.info(f"SP-API single-day report for {target}…")
    resp = api.create_report(
        reportType="GET_SALES_AND_TRAFFIC_REPORT",
        dataStartTime=target.strftime("%Y-%m-%dT00:00:00Z"),
        dataEndTime=target.strftime("%Y-%m-%dT23:59:59Z"),
        reportOptions={"dateGranularity": "DAY", "asinGranularity": "CHILD"},
        marketplaceIds=[SP_MARKETPLACE_ID],
    )
    report_id = resp.payload["reportId"]
    log.info(f"  Report ID: {report_id} — polling…")
    doc_id  = _sp_wait(api, report_id)
    content = _sp_download(api, doc_id)
    return _sp_parse_daily(content), _sp_parse_asin(content)


def _sp_wait(api: Reports, report_id: str, timeout: int = 900, interval: int = 30) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r      = api.get_report(reportId=report_id)
        status = r.payload["processingStatus"]
        if status == "DONE":
            return r.payload["reportDocumentId"]
        if status in ("FATAL", "CANCELLED"):
            raise RuntimeError(f"SP-API report {report_id} ended: {status}")
        log.debug(f"  SP status: {status}")
        time.sleep(interval)
    raise RuntimeError(f"SP-API report {report_id} timed out after {timeout}s")


def _sp_download(api: Reports, doc_id: str) -> str:
    doc = api.get_report_document(reportDocumentId=doc_id).payload
    raw = requests.get(doc["url"], timeout=120).content
    if doc.get("compressionAlgorithm") == "GZIP":
        return gzip.decompress(raw).decode("utf-8")
    return raw.decode("utf-8")


def _sp_parse_daily(content: str) -> dict[str, float]:
    data = json.loads(content)
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
    Percentages arrive as 0–100; stored as 0–1 decimals.
    """
    data = json.loads(content)
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
            "unit_session_pct": round(_to_float(pct_raw) / 100, 6) if pct_raw is not None else None,
            "buy_box_pct":      round(_to_float(bb_raw)  / 100, 6) if bb_raw  is not None else None,
        }
    return out


# ── Ads API ────────────────────────────────────────────────────────────────────

def ads_pull_range(start: date, end: date) -> dict[str, float]:
    """
    Pull daily PPC spend (SP + SB + SD) for [start, end].
    Batches into 30-day chunks — a 90-day range = 3 chunks × 3 ad types = 9 reports
    instead of 90 days × 3 types = 270 reports.
    Returns {'YYYY-MM-DD': total_spend}.
    """
    token   = _ads_token()
    headers = _ads_headers(token)
    daily: dict[str, float] = {}
    retention_cutoff = date.today() - timedelta(days=_SB_SD_RETENTION_DAYS)

    for i, ad_type in enumerate(_AD_TYPES):
        if i > 0:
            log.info(f"Pausing 60s before {ad_type['label']} batch…")
            time.sleep(60)

        chunks = list(chunk_dates(start, end, _ADS_CHUNK_DAYS))
        log.info(f"Ads API {ad_type['label']}: {len(chunks)} chunk(s)")

        for j, (cs, ce) in enumerate(chunks, 1):
            # SB/SD have limited retention — skip chunks before the window
            if ad_type["label"] in ("SB", "SD") and ce < retention_cutoff:
                log.info(f"  Skipping {ad_type['label']} chunk {j}: {cs}–{ce} outside retention")
                continue
            # Clamp start to retention window if partly out of range
            eff_start = max(cs, retention_cutoff) if ad_type["label"] in ("SB", "SD") else cs

            log.info(f"  {ad_type['label']} chunk {j}/{len(chunks)}: {eff_start} → {ce}")
            try:
                report_id = _ads_request_report(headers, eff_start, ce, ad_type)
                url       = _ads_wait(headers, report_id)
                chunk     = _ads_parse(url)
                for day, spend in chunk.items():
                    daily[day] = daily.get(day, 0.0) + spend
                log.info(f"    Got {len(chunk)} day(s) of {ad_type['label']} spend")
            except Exception as exc:
                log.warning(f"  {ad_type['label']} chunk {j} failed (skipping): {exc}")

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


def _ads_request_report(headers: dict, start: date, end: date, ad_type: dict) -> str:
    resp = requests.post(
        f"{_ADS_BASE_URL}/reporting/reports",
        headers=headers,
        json={
            "name":      f"Daily {ad_type['label']} {start} to {end}",
            "startDate": start.strftime("%Y-%m-%d"),
            "endDate":   end.strftime("%Y-%m-%d"),
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
        log.error(f"Ads report request {resp.status_code}: {resp.text[:300]}")
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
        if status == "COMPLETED":
            return data["url"]
        if status in ("FAILURE", "CANCELLED"):
            raise RuntimeError(f"Ads report {report_id}: {status} — {data.get('statusDetails', '')}")
        log.debug(f"  Ads status: {status}")
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
        "Prefer":        "resolution=merge-duplicates",
    }


def supabase_upsert(table: str, rows: list[dict]) -> None:
    if not rows:
        return
    # Send in batches of 500 to avoid request size limits
    for i in range(0, len(rows), 500):
        batch = rows[i:i + 500]
        resp  = requests.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=_sb_headers(),
            data=json.dumps(batch, default=str),
            timeout=60,
        )
        if not resp.ok:
            log.error(f"Supabase {table} {resp.status_code}: {resp.text[:400]}")
            resp.raise_for_status()
    log.info(f"✓ Upserted {len(rows)} row(s) → {table}")


# ── Orchestration ──────────────────────────────────────────────────────────────

def pull_day(target: date, brand: str) -> None:
    """Single day pull — revenue + ASIN traffic + PPC spend."""
    log.info(f"{'='*60}")
    log.info(f"DAILY PULL: {target}  (brand: {brand})")
    log.info(f"{'='*60}")

    # SP-API: revenue + ASIN traffic
    revenue: float | None = None
    asin_traffic: dict[str, dict] = {}
    try:
        daily_rev, asin_traffic = sp_pull_single_day(target)
        revenue = daily_rev.get(target.strftime("%Y-%m-%d"))
        log.info(f"Revenue: {revenue}  |  ASINs: {len(asin_traffic)}")
    except Exception as exc:
        log.error(f"SP-API failed: {exc}")

    # Ads API: PPC spend
    spend: float | None = None
    try:
        spend_map = ads_pull_range(target, target)
        spend = spend_map.get(target.strftime("%Y-%m-%d"))
        log.info(f"PPC spend: {spend}")
    except Exception as exc:
        log.error(f"Ads API failed: {exc}")

    # Upsert daily_data (Amazon columns only — CSV channels untouched)
    supabase_upsert("daily_data", [{
        "date":             target.strftime("%Y-%m-%d"),
        "brand":            brand,
        "amazon_revenue":   revenue,
        "amazon_ppc_spend": spend,
    }])

    # Upsert asin_daily_data
    if asin_traffic:
        supabase_upsert("asin_daily_data", [
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
        ])

    print(f"\n  ✓ {target}  Revenue: {'${:,.2f}'.format(revenue) if revenue is not None else 'n/a'}  "
          f"PPC: {'${:,.2f}'.format(spend) if spend is not None else 'n/a'}  "
          f"ASINs: {len(asin_traffic)}\n")


def backfill_range(start: date, end: date, brand: str) -> None:
    """
    Efficient multi-day backfill using batched reports.
    Pulls revenue + PPC spend for the full range with just a handful of API calls.
    ASIN per-day data is skipped (daily pulls going forward will populate it).
    """
    days = (end - start).days + 1
    log.info(f"{'='*60}")
    log.info(f"BACKFILL: {start} → {end}  ({days} days)  brand={brand}")
    log.info(f"{'='*60}")
    log.info("Note: ASIN per-day detail skipped in backfill mode.")

    # Pull full revenue range (batched SP-API reports)
    all_revenue: dict[str, float] = {}
    try:
        all_revenue = sp_pull_revenue_range(start, end)
        log.info(f"SP-API complete: {len(all_revenue)} days with revenue data")
    except Exception as exc:
        log.error(f"SP-API range pull failed: {exc}")

    # Pull full PPC spend range (batched Ads API reports)
    all_spend: dict[str, float] = {}
    try:
        all_spend = ads_pull_range(start, end)
        log.info(f"Ads API complete: {len(all_spend)} days with spend data")
    except Exception as exc:
        log.error(f"Ads API range pull failed: {exc}")

    # Build rows for every day in range and upsert in one batch
    rows = []
    for target in date_range(start, end):
        ds = target.strftime("%Y-%m-%d")
        rows.append({
            "date":             ds,
            "brand":            brand,
            "amazon_revenue":   all_revenue.get(ds),
            "amazon_ppc_spend": all_spend.get(ds),
        })

    supabase_upsert("daily_data", rows)

    # Summary
    got_rev   = sum(1 for r in rows if r["amazon_revenue"]   is not None)
    got_spend = sum(1 for r in rows if r["amazon_ppc_spend"] is not None)
    print(f"\n  ✓ Backfill complete: {days} days upserted")
    print(f"    Revenue populated:   {got_rev}/{days} days")
    print(f"    PPC spend populated: {got_spend}/{days} days\n")


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Pull Amazon data into Supabase")
    parser.add_argument("--date",  help="Single date YYYY-MM-DD (default: yesterday)")
    parser.add_argument("--start", help="Backfill start date YYYY-MM-DD")
    parser.add_argument("--end",   help="Backfill end date YYYY-MM-DD")
    parser.add_argument("--brand", default=ACTIVE_BRAND)
    args = parser.parse_args()

    if args.start and args.end:
        backfill_range(
            date.fromisoformat(args.start),
            date.fromisoformat(args.end),
            args.brand,
        )
    else:
        target = date.fromisoformat(args.date) if args.date else date.today() - timedelta(days=1)
        pull_day(target, args.brand)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Amazon data pull → Supabase.

DAILY MODE (default — runs via cron):
    Pulls yesterday's data including per-ASIN traffic. Also automatically
    scans the last 30 days for any gaps (e.g. days GitHub Actions skipped)
    and backfills them before pulling yesterday. One SP-API report +
    three Ads API reports. Takes ~4–8 minutes.

BACKFILL MODE (--start / --end):
    Pulls a full date range efficiently by batching into multi-day reports
    instead of looping one day at a time. A 90-day backfill takes ~20–40 min
    instead of 18+ hours. ASIN per-day data is skipped in backfill mode
    (daily pulls going forward will populate it).

ORDERS-ONLY MODE (--orders-only):
    Skips SP-API reports and Ads API completely — only pulls the Orders API
    to populate the hourly_sales heatmap table. Much faster (~1–5 min).
    Combine with --start/--end to backfill historical heatmap data, or with
    --date for a single day, or leave blank for yesterday.

Usage:
    python scripts/daily_pull_supabase.py                            # yesterday + auto-gap-fill
    python scripts/daily_pull_supabase.py --date 2026-05-20         # single day (no gap scan)
    python scripts/daily_pull_supabase.py --start 2026-01-01 --end 2026-05-24  # backfill
    python scripts/daily_pull_supabase.py --orders-only             # heatmap only, yesterday
    python scripts/daily_pull_supabase.py --orders-only --start 2026-03-01 --end 2026-05-31  # heatmap backfill

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
import traceback
from datetime import date, timedelta, datetime as _dt
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv
from sp_api.api import Reports, Orders as SpOrders, FulfillmentOutbound
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

# Seller's local timezone for hourly bucketing (Orders API timestamps are UTC)
_SELLER_TZ = ZoneInfo(os.getenv("SELLER_TIMEZONE", "America/New_York"))

_ADS_TOKEN_URL = "https://api.amazon.com/auth/o2/token"
_ADS_BASE_URL  = "https://advertising-api.amazon.com"
_SP_CHUNK_DAYS = 30   # SP-API: request at most 30 days per report
_ADS_CHUNK_DAYS = 30  # Ads API: maximum 30 days per report
_SB_SD_RETENTION_DAYS = 59  # SB/SD data retention window
_PPC_REFRESH_DAYS = 10  # trailing window re-pulled & overwritten each run (Ads can finalise up to ~1wk late)
_PPC_SUSPECT_THRESHOLD = 10.0  # spend below this is a broken partial (real spend ~$600-1000/day) → re-pull as a gap

# ── FBA Inventory Ledger (depletion forecasting) ───────────────────────────────
# Event-type values in GET_LEDGER_DETAIL_VIEW_DATA that represent true customer
# depletion of the FBA pool — Amazon-marketplace orders AND Shopify-via-MCF removals.
# The exact string differs by report version ("Shipments" vs "CustomerShipments"), so we
# match a normalised, CONFIGURABLE set (not a literal buried in logic) and log every
# distinct event type seen on each run (see fetch_inventory_ledger). Everything else
# (Receipts, CustomerReturns, Removals, Disposals, Adjustments, WarehouseTransfer, Found,
# …) is NOT demand and is excluded.
#
# TODO(first-run verification — do not assume, the logs will tell you):
#   1. EVENT TYPE: confirm which string actually appears (logged each run) and trim this set.
#   2. MCF RECONCILIATION: confirm a known Shopify-via-MCF order's units show up here under
#      customer shipments. This assumption is the whole basis of the feed — verify, then
#      document the result in this comment.
#   3. QUANTITY SIGN: shipments come through negative (depletion); we take abs(). Re-check
#      if a future report version changes sign conventions.
_LEDGER_SHIPMENT_EVENT_TYPES = {"Shipments", "CustomerShipments", "Customer Shipments"}
_LEDGER_SHIPMENT_NORM  = {e.lower().replace(" ", "") for e in _LEDGER_SHIPMENT_EVENT_TYPES}
_LEDGER_LOOKBACK_DAYS  = 95   # > 90 so the 90-day velocity window is always full
_LEDGER_OVERWRITE_DAYS = 5    # re-pull/overwrite trailing N days each run (ledger reconciles)

# ── Shopify (online-store MCF depletion) ───────────────────────────────────────
# All Shopify online-store orders are fulfilled via Amazon MCF, so they deplete the
# same FBA pool as Amazon orders — the MCF half the Sales & Traffic report can't see.
# TikTok orders flow into the same store but ship from a 3PL, so they're EXCLUDED by
# the "Shipped by TikTok" tag. Shopify SKU == Amazon MSKU for this catalog.
# Optional creds: if unset, the Shopify pull simply skips (won't break other pulls).
SHOPIFY_STORE_DOMAIN   = os.getenv("SHOPIFY_STORE_DOMAIN")   # e.g. xproaccessories.myshopify.com
SHOPIFY_ADMIN_TOKEN    = os.getenv("SHOPIFY_ADMIN_TOKEN")    # shpat_… (read_orders scope)
_SHOPIFY_API_VERSION   = "2024-10"
_SHOPIFY_EXCLUDE_TAG   = os.getenv("SHOPIFY_EXCLUDE_TAG", "Shipped by TikTok")
_SHOPIFY_LOOKBACK_DAYS = 30   # scheduled-run window (backfill covers the full 90d history)
_SHOPIFY_OVERWRITE_DAYS = 3   # re-pull/overwrite trailing N days each run for idempotency

# ── MCF orders (Fulfillment Outbound — the working MCF depletion source) ───────
# The FBA Inventory Ledger report is blocked (report-type-specific 403), but the
# Fulfillment Outbound API works with the same role. It lists MCF fulfillment orders
# (your Shopify orders fulfilled from FBA) with SKU + quantity. Only MCF orders appear
# here — TikTok-from-3PL never touches FBA, so there's nothing to filter out.
_MCF_LOOKBACK_DAYS  = 14   # scheduled-run window (backfill covers the full 90d history)
_MCF_OVERWRITE_DAYS = 5    # re-pull/overwrite trailing N days each run for idempotency

# ── Amazon marketplace units by SKU (the other half of FBA depletion) ──────────
# Sourced from the authoritative Detail Page Sales & Traffic report (units ordered by
# child ASIN), mapped ASIN→SKU via the listings report, stored as 7/14/30/60/90-day
# window totals in amazon_sku_windows. Combined with MCF in sku_velocity = total demand.

_AD_TYPES = [
    {"adProduct": "SPONSORED_PRODUCTS", "reportTypeId": "spCampaigns", "label": "SP"},
    {"adProduct": "SPONSORED_BRANDS",   "reportTypeId": "sbCampaigns", "label": "SB"},
    {"adProduct": "SPONSORED_DISPLAY",  "reportTypeId": "sdCampaigns", "label": "SD"},
]

# Per-campaign report columns. Metric names differ across SP / SB / SD, so each
# ad product gets its own column list to avoid "invalid column" report failures.
# Only SP reliably exposes campaignBudgetAmount — used to detect budget-capped
# campaigns. SB/SD store cost + sales (budget left null).
_CAMPAIGN_COLUMNS = {
    "SP": ["date", "campaignId", "campaignName", "campaignBudgetAmount",
           "impressions", "clicks", "cost", "purchases7d", "sales7d"],
    "SB": ["date", "campaignId", "campaignName",
           "impressions", "clicks", "cost", "purchases", "sales"],
    "SD": ["date", "campaignId", "campaignName",
           "impressions", "clicks", "cost", "purchases", "sales"],
}


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


def sp_pull_days_fanout(targets: list[date]) -> dict[str, tuple[float | None, dict[str, dict]]]:
    """
    Pull revenue + per-ASIN traffic for multiple days simultaneously (fan-out).
    Returns {date_str: (revenue_or_none, {asin: metrics})}.

    Amazon ASIN traffic data (sessions, CVR, Buy Box %) can take 2-4 days to be
    finalised after the trading day ends. By submitting reports for the last 3 days
    on every run we automatically pick up the delayed data once Amazon publishes it.
    All reports are submitted upfront and polled together — no sequential waiting.
    """
    api = Reports(credentials=SP_CREDS, marketplace=Marketplaces.US)
    pending: list[tuple[str, str]] = []   # (report_id, date_str)

    for i, target in enumerate(targets):
        if i > 0:
            time.sleep(5)   # small gap between submissions to avoid rate limits
        try:
            resp = api.create_report(
                reportType="GET_SALES_AND_TRAFFIC_REPORT",
                dataStartTime=target.strftime("%Y-%m-%dT00:00:00Z"),
                dataEndTime=target.strftime("%Y-%m-%dT23:59:59Z"),
                reportOptions={"dateGranularity": "DAY", "asinGranularity": "CHILD"},
                marketplaceIds=[SP_MARKETPLACE_ID],
            )
            report_id = resp.payload["reportId"]
            pending.append((report_id, target.strftime("%Y-%m-%d")))
            log.info(f"  Submitted SP report for {target}: {report_id}")
        except Exception as exc:
            log.warning(f"  Failed to submit SP report for {target}: {exc}")

    if not pending:
        return {}

    log.info(f"  Polling {len(pending)} SP report(s) together…")
    completed: list[tuple[str, str]] = []   # (doc_id, date_str)
    remaining = list(pending)
    deadline  = time.time() + 1800

    while remaining and time.time() < deadline:
        time.sleep(30)
        still_pending = []
        for report_id, date_str in remaining:
            try:
                r      = api.get_report(reportId=report_id)
                status = r.payload["processingStatus"]
                if status == "DONE":
                    completed.append((r.payload["reportDocumentId"], date_str))
                    log.info(f"  ✓ SP report {date_str} done")
                elif status in ("FATAL", "CANCELLED"):
                    log.warning(f"  ✗ SP report {date_str}: {status}")
                else:
                    still_pending.append((report_id, date_str))
            except Exception as exc:
                log.warning(f"  Poll error SP {date_str}: {exc}")
                still_pending.append((report_id, date_str))
        remaining = still_pending
        if remaining:
            log.info(f"  Still waiting on {len(remaining)} SP report(s)…")

    if remaining:
        log.warning(f"SP fan-out timed out — never completed: {[d for _, d in remaining]}")

    results: dict[str, tuple[float | None, dict[str, dict]]] = {}
    for doc_id, date_str in completed:
        try:
            content  = _sp_download(api, doc_id)
            daily_rev = _sp_parse_daily(content)
            asin_data = _sp_parse_asin(content)
            revenue   = daily_rev.get(date_str)
            results[date_str] = (revenue, asin_data)
            log.info(f"  Parsed {date_str}: revenue={revenue}, {len(asin_data)} ASINs")
        except Exception as exc:
            log.warning(f"  Failed to parse SP report {date_str}: {exc}")

    return results


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

    Fan-out strategy: submit ALL reports first (one per ad-type per 30-day chunk),
    then poll them all together. This means SP/SB/SD generation overlaps instead
    of being sequential — cuts wait time by ~3x vs the old serial approach.

    Returns {'YYYY-MM-DD': total_spend}.
    """
    token   = _ads_token()
    headers = _ads_headers(token)
    retention_cutoff = date.today() - timedelta(days=_SB_SD_RETENTION_DAYS)
    chunks  = list(chunk_dates(start, end, _ADS_CHUNK_DAYS))

    # ── Step 1: submit all reports upfront ─────────────────────
    # [(report_id, label, description), ...]
    pending: list[tuple[str, str, str]] = []

    for i, ad_type in enumerate(_AD_TYPES):
        if i > 0:
            # Small pause between ad-type submission bursts to avoid 429
            log.info(f"Pausing 15s before submitting {ad_type['label']} reports…")
            time.sleep(15)

        for j, (cs, ce) in enumerate(chunks, 1):
            if ad_type["label"] in ("SB", "SD") and ce < retention_cutoff:
                log.info(f"  Skipping {ad_type['label']} {cs}–{ce}: outside retention window")
                continue
            eff_start = max(cs, retention_cutoff) if ad_type["label"] in ("SB", "SD") else cs
            desc = f"{ad_type['label']} {eff_start}–{ce}"

            try:
                report_id = _ads_request_with_retry(headers, eff_start, ce, ad_type)
                pending.append((report_id, ad_type["label"], desc))
                log.info(f"  Submitted {desc}: {report_id}")
            except Exception as exc:
                log.warning(f"  Failed to submit {desc}: {exc}")

    if not pending:
        log.warning("No Ads API reports were submitted — returning empty spend data")
        return {}

    log.info(f"Submitted {len(pending)} report(s). Polling until all complete (30-min timeout)…")

    # ── Step 2: poll all reports together ──────────────────────
    completed: list[tuple[str, str]] = []   # [(url, label)]
    remaining = list(pending)
    deadline  = time.time() + 1800          # 30-minute total timeout

    while remaining and time.time() < deadline:
        time.sleep(30)
        still_pending = []
        for report_id, label, desc in remaining:
            try:
                resp = requests.get(
                    f"{_ADS_BASE_URL}/reporting/reports/{report_id}",
                    headers=headers,
                    timeout=30,
                )
                resp.raise_for_status()
                data   = resp.json()
                status = data.get("status")
                if status == "COMPLETED":
                    completed.append((data["url"], label))
                    log.info(f"  ✓ {desc} complete")
                elif status in ("FAILURE", "CANCELLED"):
                    log.warning(f"  ✗ {desc} failed: {status} — {data.get('statusDetails', '')}")
                else:
                    still_pending.append((report_id, label, desc))
                    log.debug(f"  {desc}: {status}")
            except Exception as exc:
                log.warning(f"  Poll error for {desc}: {exc}")
                still_pending.append((report_id, label, desc))

        remaining = still_pending
        if remaining:
            log.info(f"  Still waiting on {len(remaining)} report(s)…")

    if remaining:
        log.warning(f"Timed out — {len(remaining)} report(s) never completed: "
                    f"{[d for _, _, d in remaining]}")

    # ── Step 3: download and sum all completed reports ──────────
    daily: dict[str, float] = {}
    for url, label in completed:
        try:
            chunk = _ads_parse(url)
            for day, spend in chunk.items():
                daily[day] = daily.get(day, 0.0) + spend
            log.info(f"  Parsed {label}: {len(chunk)} day(s)")
        except Exception as exc:
            log.warning(f"  Failed to parse {label} result: {exc}")

    return daily


def _ads_request_with_retry(headers: dict, start: date, end: date, ad_type: dict,
                             max_retries: int = 4, submit_fn=None) -> str:
    """
    Submit an Ads API report request, retrying on 429 with exponential backoff.
    submit_fn lets callers choose which report shape to request (default = the
    daily-totals report; pass _ads_request_campaign_report for per-campaign data).
    """
    submit_fn = submit_fn or _ads_request_report
    backoff = [30, 60, 120, 240]
    for attempt in range(max_retries + 1):
        if attempt > 0:
            wait = backoff[min(attempt - 1, len(backoff) - 1)]
            log.info(f"  Retry {attempt}/{max_retries} for {ad_type['label']}, waiting {wait}s…")
            time.sleep(wait)
        try:
            return submit_fn(headers, start, end, ad_type)
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 429 and attempt < max_retries:
                log.warning(f"  429 on {ad_type['label']} submission — will retry")
                continue
            raise
    raise RuntimeError(f"Exhausted retries for {ad_type['label']}")


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


# ── Ads API: per-campaign performance (budget allocation) ──────────────────────

def _ads_request_campaign_report(headers: dict, start: date, end: date, ad_type: dict) -> str:
    """Submit a per-campaign report (richer columns than the daily-totals report)."""
    resp = requests.post(
        f"{_ADS_BASE_URL}/reporting/reports",
        headers=headers,
        json={
            "name":      f"Campaign {ad_type['label']} {start} to {end}",
            "startDate": start.strftime("%Y-%m-%d"),
            "endDate":   end.strftime("%Y-%m-%d"),
            "configuration": {
                "adProduct":    ad_type["adProduct"],
                "groupBy":      ["campaign"],
                "columns":      _CAMPAIGN_COLUMNS[ad_type["label"]],
                "reportTypeId": ad_type["reportTypeId"],
                "timeUnit":     "DAILY",
                "format":       "GZIP_JSON",
            },
        },
        timeout=30,
    )
    if not resp.ok:
        log.error(f"Campaign report request {resp.status_code}: {resp.text[:300]}")
    resp.raise_for_status()
    return resp.json()["reportId"]


def _ads_parse_campaigns(url: str, ad_label: str, brand: str) -> list[dict]:
    """Parse a per-campaign report into campaign_daily rows."""
    raw     = requests.get(url, timeout=120).content
    records = json.loads(gzip.decompress(raw).decode("utf-8"))
    out: list[dict] = []
    for rec in records:
        day = (rec.get("date") or "").strip()
        cid = rec.get("campaignId")
        if not day or cid is None:
            continue
        # SP uses 7-day attribution columns; SB/SD use undated ones
        sales  = rec.get("sales7d",     rec.get("sales"))
        orders = rec.get("purchases7d", rec.get("purchases"))
        out.append({
            "date":          day,
            "brand":         brand,
            "campaign_id":   str(cid),
            "ad_product":    ad_label,
            "campaign_name": rec.get("campaignName"),
            "budget":        _to_float(rec.get("campaignBudgetAmount")),
            "impressions":   _to_int(rec.get("impressions")),
            "clicks":        _to_int(rec.get("clicks")),
            "cost":          _to_float(rec.get("cost")),
            "orders":        _to_int(orders),
            "sales":         _to_float(sales),
        })
    return out


def ads_pull_campaigns_range(start: date, end: date, brand: str) -> None:
    """
    Pull PER-CAMPAIGN performance (spend, sales, orders, budget) for [start, end]
    across SP/SB/SD and upsert to campaign_daily. Powers the budget-allocation view.

    READ-ONLY: this only stores data for analysis. It does NOT modify any Amazon
    budgets or campaigns. Same fan-out submit-then-poll pattern as ads_pull_range.
    """
    token   = _ads_token()
    headers = _ads_headers(token)
    retention_cutoff = date.today() - timedelta(days=_SB_SD_RETENTION_DAYS)
    chunks  = list(chunk_dates(start, end, _ADS_CHUNK_DAYS))

    # ── Step 1: submit all per-campaign reports upfront ────────
    pending: list[tuple[str, str, str]] = []   # (report_id, label, desc)
    for i, ad_type in enumerate(_AD_TYPES):
        if i > 0:
            log.info(f"Pausing 15s before submitting {ad_type['label']} campaign reports…")
            time.sleep(15)
        for cs, ce in chunks:
            if ad_type["label"] in ("SB", "SD") and ce < retention_cutoff:
                continue
            eff_start = max(cs, retention_cutoff) if ad_type["label"] in ("SB", "SD") else cs
            desc = f"{ad_type['label']} campaigns {eff_start}–{ce}"
            try:
                report_id = _ads_request_with_retry(
                    headers, eff_start, ce, ad_type,
                    submit_fn=_ads_request_campaign_report,
                )
                pending.append((report_id, ad_type["label"], desc))
                log.info(f"  Submitted {desc}: {report_id}")
            except Exception as exc:
                log.warning(f"  Failed to submit {desc}: {exc}")

    if not pending:
        log.warning("No campaign reports submitted — skipping campaign_daily")
        return

    log.info(f"Submitted {len(pending)} campaign report(s). Polling (30-min timeout)…")

    # ── Step 2: poll all reports together ──────────────────────
    completed: list[tuple[str, str]] = []   # (url, label)
    remaining = list(pending)
    deadline  = time.time() + 1800
    while remaining and time.time() < deadline:
        time.sleep(30)
        still_pending = []
        for report_id, label, desc in remaining:
            try:
                resp = requests.get(
                    f"{_ADS_BASE_URL}/reporting/reports/{report_id}",
                    headers=headers, timeout=30,
                )
                resp.raise_for_status()
                data   = resp.json()
                status = data.get("status")
                if status == "COMPLETED":
                    completed.append((data["url"], label))
                    log.info(f"  ✓ {desc} complete")
                elif status in ("FAILURE", "CANCELLED"):
                    log.warning(f"  ✗ {desc} failed: {status} — {data.get('statusDetails', '')}")
                else:
                    still_pending.append((report_id, label, desc))
            except Exception as exc:
                log.warning(f"  Poll error for {desc}: {exc}")
                still_pending.append((report_id, label, desc))
        remaining = still_pending
        if remaining:
            log.info(f"  Still waiting on {len(remaining)} campaign report(s)…")

    if remaining:
        log.warning(f"Campaign reports timed out: {[d for _, _, d in remaining]}")

    # ── Step 3: parse + upsert ─────────────────────────────────
    rows: list[dict] = []
    for url, label in completed:
        try:
            parsed = _ads_parse_campaigns(url, label, brand)
            rows.extend(parsed)
            log.info(f"  Parsed {label}: {len(parsed)} campaign-day row(s)")
        except Exception as exc:
            log.warning(f"  Failed to parse {label} campaign report: {exc}")

    if rows:
        supabase_upsert("campaign_daily", rows)
        days = len({r["date"] for r in rows})
        camps = len({r["campaign_id"] for r in rows})
        log.info(f"✓ Campaign data: {len(rows)} row(s), {camps} campaign(s) across {days} day(s)")
    else:
        log.info("  No campaign rows parsed")


# ── Orders API (hourly heatmap) ────────────────────────────────────────────────

def orders_pull_range(start: date, end: date, brand: str) -> None:
    """
    Pull orders via SP-API Orders endpoint, bucket by (date, hour) in the seller's
    local timezone (_SELLER_TZ), and upsert to the hourly_sales table.

    Rate limits: getOrders = 0.0167 req/sec, burst 20.
    Pages 1-20 have a 2s gap (within burst); beyond page 20, 65s gap.
    For a typical daily pull (1-2 days) this is 1-5 pages — completes in <15 s.
    For a 90-day backfill it can take 30-90 minutes depending on order volume.
    """
    api = SpOrders(credentials=SP_CREDS, marketplace=Marketplaces.US)

    # {(date_str, hour): {order_count, units, revenue}}
    buckets: dict[tuple[str, int], dict] = {}
    next_token: str | None = None
    page = 0

    log.info(f"Orders API: pulling {start} → {end} (tz={_SELLER_TZ})…")

    while True:
        page += 1
        if page > 1:
            time.sleep(65 if page > 20 else 2)

        try:
            if next_token:
                resp = api.get_orders(NextToken=next_token)
            else:
                resp = api.get_orders(
                    CreatedAfter=(start.isoformat() + "T00:00:00Z"),
                    CreatedBefore=((end + timedelta(days=1)).isoformat() + "T00:00:00Z"),
                    MarketplaceIds=[SP_MARKETPLACE_ID],
                    OrderStatuses=["Shipped", "Unshipped", "PartiallyShipped", "Pending"],
                    MaxResultsPerPage=100,
                )

            orders = resp.payload.get("Orders", [])
            log.info(f"  Orders page {page}: {len(orders)} orders")

            for order in orders:
                purchase_str = order.get("PurchaseDate", "")
                if not purchase_str:
                    continue

                try:
                    utc_dt   = _dt.fromisoformat(purchase_str.replace("Z", "+00:00"))
                    local_dt = utc_dt.astimezone(_SELLER_TZ)
                    date_str = local_dt.strftime("%Y-%m-%d")
                    hour     = local_dt.hour
                except Exception:
                    continue

                d = date.fromisoformat(date_str)
                if d < start or d > end:
                    continue

                # Order total (may be absent on Pending orders)
                amount = 0.0
                try:
                    raw = (order.get("OrderTotal") or {}).get("Amount", 0)
                    amount = float(raw or 0)
                except (ValueError, TypeError):
                    pass

                shipped   = int(order.get("NumberOfItemsShipped")   or 0)
                unshipped = int(order.get("NumberOfItemsUnshipped") or 0)
                units     = max(shipped + unshipped, 1)

                key = (date_str, hour)
                if key not in buckets:
                    buckets[key] = {"order_count": 0, "units": 0, "revenue": 0.0}
                buckets[key]["order_count"] += 1
                buckets[key]["units"]       += units
                buckets[key]["revenue"]     += amount

            next_token = resp.payload.get("NextToken")
            if not next_token:
                break

        except Exception as exc:
            log.error(f"  Orders API error on page {page}: {type(exc).__name__}: {exc}")
            log.error(traceback.format_exc())
            break

    if not buckets:
        log.info("  No orders found in range")
        return

    rows = [
        {
            "date":        ds,
            "hour":        h,
            "brand":       brand,
            "order_count": v["order_count"],
            "units":       v["units"],
            "revenue":     round(v["revenue"], 2),
        }
        for (ds, h), v in buckets.items()
    ]
    supabase_upsert("hourly_sales", rows)
    days_covered = len({ds for ds, _ in buckets})
    log.info(f"✓ Orders: {len(rows)} hourly buckets across {days_covered} day(s)")


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


def supabase_delete_range(table: str, brand: str, start: date, end: date,
                          date_col: str = "ship_date") -> None:
    """
    Delete rows for a brand within [start, end] inclusive. Used to overwrite a trailing
    window before re-upserting, so reconciliation adjustments (and rows that should no
    longer exist) are reflected and re-runs stay idempotent.

    Always filtered by brand AND date — never issue an unfiltered DELETE.
    """
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_sb_headers(),
        params=[
            ("brand",  f"eq.{brand}"),
            (date_col, f"gte.{start.isoformat()}"),
            (date_col, f"lte.{end.isoformat()}"),
        ],
        timeout=60,
    )
    if not resp.ok:
        log.error(f"Supabase delete {table} {resp.status_code}: {resp.text[:400]}")
        resp.raise_for_status()


# ── Gap detection ──────────────────────────────────────────────────────────────

def get_existing_dates(start: date, end: date, brand: str) -> set[str]:
    """
    Query Supabase for dates in [start, end] that already have Amazon data.
    A date is considered present only if at least one of amazon_revenue or
    amazon_ppc_spend is non-null (i.e. the API actually returned something).
    """
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/daily_data",
        headers={
            "apikey":        SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
        },
        params=[
            ("select", "date,amazon_revenue,amazon_ppc_spend"),
            ("brand",  f"eq.{brand}"),
            ("date",   f"gte.{start}"),
            ("date",   f"lte.{end}"),
        ],
        timeout=30,
    )
    resp.raise_for_status()
    return {
        r["date"]
        for r in resp.json()
        if r.get("amazon_revenue") is not None or r.get("amazon_ppc_spend") is not None
    }


def find_gaps(start: date, end: date, brand: str) -> list[tuple[date, date]]:
    """
    Return a list of (gap_start, gap_end) ranges that are missing Amazon data
    in Supabase for the given brand. Consecutive missing days are merged into
    a single range so the backfill uses as few API calls as possible.
    """
    existing = get_existing_dates(start, end, brand)
    missing  = [d for d in date_range(start, end) if d.strftime("%Y-%m-%d") not in existing]
    if not missing:
        return []

    # Group consecutive days into ranges
    ranges: list[tuple[date, date]] = []
    gap_start = gap_end = missing[0]
    for d in missing[1:]:
        if d == gap_end + timedelta(days=1):
            gap_end = d
        else:
            ranges.append((gap_start, gap_end))
            gap_start = gap_end = d
    ranges.append((gap_start, gap_end))
    return ranges


def auto_backfill_gaps(brand: str, lookback_days: int = 30) -> None:
    """
    Scan the last `lookback_days` days and backfill any that are missing.
    Called automatically in daily cron mode so skipped GitHub Actions runs
    are caught and filled on the next successful execution.
    """
    today = date.today()
    end   = today - timedelta(days=1)          # yesterday (today not yet finalised)
    start = today - timedelta(days=lookback_days)

    log.info(f"Gap scan: checking [{start} → {end}] for missing data…")
    try:
        gaps = find_gaps(start, end, brand)
    except Exception as exc:
        log.warning(f"Gap scan failed (Supabase query error): {exc} — skipping auto-backfill")
        return

    if not gaps:
        log.info("  No gaps found — all days present ✓")
        return

    total_missing = sum((ge - gs).days + 1 for gs, ge in gaps)
    log.info(f"  Found {total_missing} missing day(s) across {len(gaps)} gap(s):")
    for gs, ge in gaps:
        log.info(f"    {gs} → {ge}")

    for gs, ge in gaps:
        log.info(f"Backfilling gap {gs} → {ge}…")
        try:
            backfill_range(gs, ge, brand)
        except Exception as exc:
            log.error(f"  Backfill of {gs}→{ge} failed: {exc}")


def find_ppc_gaps(start: date, end: date, brand: str) -> list[tuple[date, date]]:
    """
    Find dates where amazon_revenue is present but amazon_ppc_spend is NULL
    OR suspiciously tiny (< _PPC_SUSPECT_THRESHOLD). Amazon sometimes serves a
    broken partial (e.g. $1.40 on Jun 26, $0.66 on Jul 9) that is non-null, so a
    null-only scan never revisits it. Real spend runs ~$600-1000/day, so a few
    dollars is always a partial. Returns grouped (gap_start, gap_end) ranges.
    """
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/daily_data",
        headers={
            "apikey":        SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
        },
        params=[
            ("select",              "date"),
            ("brand",               f"eq.{brand}"),
            ("date",                f"gte.{start}"),
            ("date",                f"lte.{end}"),
            ("amazon_revenue",      "not.is.null"),   # revenue exists
            # PPC missing or a broken partial
            ("or", f"(amazon_ppc_spend.is.null,amazon_ppc_spend.lt.{_PPC_SUSPECT_THRESHOLD})"),
        ],
        timeout=30,
    )
    resp.raise_for_status()
    missing = sorted(r["date"] for r in resp.json())
    if not missing:
        return []

    ranges: list[tuple[date, date]] = []
    gap_start = gap_end = date.fromisoformat(missing[0])
    for ds in missing[1:]:
        d = date.fromisoformat(ds)
        if d == gap_end + timedelta(days=1):
            gap_end = d
        else:
            ranges.append((gap_start, gap_end))
            gap_start = gap_end = d
    ranges.append((gap_start, gap_end))
    return ranges


def auto_backfill_ppc_gaps(brand: str, lookback_days: int = 30) -> None:
    """
    Re-pull Ads API spend for any day in the last N days where revenue is
    present but amazon_ppc_spend is NULL. This catches days where the Ads API
    timed out or hit a 429 while SP-API succeeded.
    Only upserts the ppc_spend column — revenue and CSV channels are untouched.
    """
    today = date.today()
    end   = today - timedelta(days=1)
    start = today - timedelta(days=lookback_days)

    log.info(f"PPC gap scan: checking [{start} → {end}] for missing spend data…")
    try:
        gaps = find_ppc_gaps(start, end, brand)
    except Exception as exc:
        log.warning(f"PPC gap scan failed: {exc} — skipping")
        return

    if not gaps:
        log.info("  No PPC gaps found ✓")
        return

    total = sum((ge - gs).days + 1 for gs, ge in gaps)
    log.info(f"  Found {total} day(s) with missing PPC across {len(gaps)} gap(s):")
    for gs, ge in gaps:
        log.info(f"    {gs} → {ge}")

    # Coalesce all gaps into ONE wide ranged pull. Empirically, wide ranged
    # reports (like manual backfills) return complete data, while narrow
    # single-day requests intermittently come back missing the SP rows —
    # leaving the $1-4 "SB/SD-only" partial days. One wide request also uses
    # far less createReport quota than one request per gap.
    span_start, span_end = gaps[0][0], gaps[-1][1]
    log.info(f"Re-pulling Ads API for the full span {span_start} → {span_end} (covers all gaps)…")
    try:
        all_spend = ads_pull_range(span_start, span_end)
        gap_days = [d for gs, ge in gaps for d in date_range(gs, ge)]
        rows = [
            {"date": d.strftime("%Y-%m-%d"), "brand": brand,
             "amazon_ppc_spend": all_spend[d.strftime("%Y-%m-%d")]}
            for d in gap_days
            if all_spend.get(d.strftime("%Y-%m-%d"), 0) > 0
        ]
        if rows:
            supabase_upsert("daily_data", rows)
            log.info(f"  ✓ Filled PPC for {len(rows)}/{len(gap_days)} gap day(s)")
        else:
            log.info(f"  Ads API returned no spend data for the gap days — skipping")
    except Exception as exc:
        log.error(f"  Ads API re-pull failed for {span_start}→{span_end}: {exc}")


def refresh_recent_ppc(brand: str, days: int = 5) -> None:
    """
    Trailing-window OVERWRITE of PPC spend for the last N days (ending yesterday).

    Amazon Ads finalises Sponsored Products/Brands/Display spend with a 2-3 day
    lag, so the daily "yesterday" pull frequently records a NULL or a partial
    value that grows later. The NULL-only gap scan (auto_backfill_ppc_gaps) fixes
    the null case but NEVER touches a day that already has a (possibly partial)
    value — e.g. a day that pulled a broken $1.40 stays $1.40 forever.

    This re-pulls the whole trailing window every run and overwrites the spend
    whenever the API returns a real (>0) value, so late-finalising and partial
    days self-correct within N days. It never clobbers an existing value with
    NULL or 0 (only upserts days the API actually returned a positive spend for).
    """
    today = date.today()
    end   = today - timedelta(days=1)
    start = today - timedelta(days=days)

    log.info(f"PPC trailing refresh: re-pulling [{start} → {end}] (overwrite finalised/partial spend)…")
    try:
        all_spend = ads_pull_range(start, end)
    except Exception as exc:
        log.warning(f"PPC trailing refresh failed: {exc} — skipping")
        return

    rows = [
        {"date": ds, "brand": brand, "amazon_ppc_spend": all_spend[ds]}
        for ds in (d.strftime("%Y-%m-%d") for d in date_range(start, end))
        if all_spend.get(ds, 0) > 0
    ]
    if rows:
        supabase_upsert("daily_data", rows)
        log.info(f"  ✓ Refreshed PPC for {len(rows)} recent day(s)")
    else:
        log.info("  Trailing refresh: no positive PPC returned for the window — leaving existing values")


def find_asin_session_gaps(start: date, end: date, brand: str) -> list[date]:
    """
    Find dates (>= 4 days old) where asin_daily_data rows exist but all sessions = 0.
    This means Amazon's traffic data wasn't available when the day was originally
    pulled and still hasn't been refreshed.

    Strategy: query for dates that have at least one session > 0 (data is good),
    then compare against all dates that have any ASIN rows — the difference is
    dates where every ASIN shows 0 sessions.
    """
    # Only check dates old enough for Amazon to have finalised traffic data
    finalized_end = min(end, date.today() - timedelta(days=4))
    if start > finalized_end:
        return []

    headers = {
        "apikey":        SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
    }

    # Dates that have at least one ASIN with sessions > 0 (traffic IS available)
    r1 = requests.get(
        f"{SUPABASE_URL}/rest/v1/asin_daily_data",
        headers=headers,
        params=[
            ("select",   "date"),
            ("brand",    f"eq.{brand}"),
            ("date",     f"gte.{start}"),
            ("date",     f"lte.{finalized_end}"),
            ("sessions", "gt.0"),
            ("limit",    "10000"),
        ],
        timeout=30,
    )
    r1.raise_for_status()
    dates_ok = set(r["date"] for r in r1.json())

    # All dates that have any ASIN rows at all
    r2 = requests.get(
        f"{SUPABASE_URL}/rest/v1/asin_daily_data",
        headers=headers,
        params=[
            ("select", "date"),
            ("brand",  f"eq.{brand}"),
            ("date",   f"gte.{start}"),
            ("date",   f"lte.{finalized_end}"),
            ("limit",  "10000"),
        ],
        timeout=30,
    )
    r2.raise_for_status()
    dates_all = set(r["date"] for r in r2.json())

    # Dates where every ASIN has sessions = 0
    gaps = sorted(dates_all - dates_ok)
    return [date.fromisoformat(d) for d in gaps]


def auto_refresh_asin_sessions(brand: str, lookback_days: int = 30) -> None:
    """
    Re-pull SP-API ASIN data for any date (4–30 days old) where sessions are
    all 0, meaning Amazon's traffic data wasn't available at original pull time.
    Uses fan-out: all gap dates are submitted simultaneously and polled together.
    """
    today = date.today()
    end   = today - timedelta(days=1)
    start = today - timedelta(days=lookback_days)

    log.info(f"ASIN session gap scan: checking [{start} → {end}] (finalized dates only)…")
    try:
        gap_dates = find_asin_session_gaps(start, end, brand)
    except Exception as exc:
        log.warning(f"ASIN session gap scan failed: {exc} — skipping")
        return

    if not gap_dates:
        log.info("  No ASIN session gaps found ✓")
        return

    log.info(f"  Found {len(gap_dates)} date(s) with zero sessions: {[str(d) for d in gap_dates]}")
    log.info("  Submitting SP-API reports for all gap dates (fan-out)…")

    try:
        sp_results = sp_pull_days_fanout(gap_dates)
        for date_str, (_, asin_data) in sp_results.items():
            if not asin_data:
                log.info(f"  No ASIN data returned for {date_str} — skipping")
                continue
            # Only upsert if at least one ASIN now has sessions > 0
            if not any(m.get("sessions") for m in asin_data.values()):
                log.info(f"  {date_str}: sessions still 0 — Amazon data may still not be ready")
                continue
            supabase_upsert("asin_daily_data", [
                {
                    "date":                  date_str,
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
                for asin, m in asin_data.items()
            ])
            log.info(f"  ✓ Refreshed ASIN sessions for {date_str}: {len(asin_data)} ASINs")
    except Exception as exc:
        log.error(f"  ASIN session refresh failed: {exc}")


# ── FBA Inventory Ledger (depletion feed) ──────────────────────────────────────

def _parse_ledger_date(raw: str) -> str | None:
    """
    Normalise a ledger 'Date' cell to ISO 'YYYY-MM-DD'. The flat file's date format is
    locale-dependent, so try the common layouts. Returns None on an unparseable value.
    """
    raw = (raw or "").strip()
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y"):
        try:
            return _dt.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _ledger_header_index(headers: list[str], aliases: list[str], *, required: bool) -> int | None:
    """
    Find a column index by matching any of `aliases` (case-insensitive) against the TSV
    header row. Fail LOUDLY if a required column is absent rather than silently producing
    zeros — locale/version can shift or rename columns.
    """
    norm = [h.strip().lower() for h in headers]
    for alias in aliases:
        if alias in norm:
            return norm.index(alias)
    if required:
        raise RuntimeError(
            f"Inventory ledger TSV is missing a required column (looked for {aliases}). "
            f"Headers present: {headers}"
        )
    return None


def _parse_ledger_tsv(content: str, brand: str) -> tuple[list[dict], dict[str, int]]:
    """
    Parse a GET_LEDGER_DETAIL_VIEW_DATA TSV into fba_daily_shipped rows.

    Maps columns by header name (Date / Event Type / MSKU / ASIN / Quantity), filters to
    customer-shipment event types, and aggregates abs(qty) per (ship_date, msku, asin).
    Returns (rows, event_type_counts); the counts are logged so the event filter can be
    verified and locked on first run.
    """
    lines = content.split("\n")
    if not lines or not lines[0].strip():
        raise RuntimeError("Inventory ledger report was empty")

    headers = lines[0].rstrip("\r").split("\t")
    i_date  = _ledger_header_index(headers, ["date"], required=True)
    i_event = _ledger_header_index(headers, ["event type", "eventtype"], required=True)
    i_msku  = _ledger_header_index(headers, ["msku", "merchant sku", "merchantsku", "seller sku", "sku"], required=True)
    i_qty   = _ledger_header_index(headers, ["quantity", "qty"], required=True)
    i_asin  = _ledger_header_index(headers, ["asin"], required=False)
    need    = max(i_date, i_event, i_msku, i_qty)

    event_counts: dict[str, int] = {}
    agg: dict[tuple[str, str, str | None], int] = {}

    for line in lines[1:]:
        line = line.rstrip("\r")
        if not line.strip():
            continue
        cells = line.split("\t")
        if len(cells) <= need:
            continue

        event = cells[i_event].strip()
        event_counts[event] = event_counts.get(event, 0) + 1
        # Customer shipments only — Amazon orders + MCF removals. Everything else skipped.
        if event.lower().replace(" ", "") not in _LEDGER_SHIPMENT_NORM:
            continue

        ship_date = _parse_ledger_date(cells[i_date])
        msku = cells[i_msku].strip()
        if not ship_date or not msku:
            continue

        # Shipments are reported as negative quantities (depletion) — take abs().
        try:
            qty = abs(int(float(cells[i_qty].strip() or 0)))
        except (ValueError, TypeError):
            continue
        if qty == 0:
            continue

        asin = None
        if i_asin is not None and i_asin < len(cells):
            asin = cells[i_asin].strip() or None

        key = (ship_date, msku, asin)
        agg[key] = agg.get(key, 0) + qty

    rows = [
        {"ship_date": d, "msku": m, "brand": brand, "asin": a, "units": u}
        for (d, m, a), u in agg.items()
    ]
    return rows, event_counts


def fetch_inventory_ledger(start: date, end: date, brand: str) -> None:
    """
    Pull the FBA Inventory Ledger (detailed view) for [start, end] and upsert per-SKU
    customer-shipment units into fba_daily_shipped — the MCF-inclusive depletion signal
    that drives replenishment forecasting.

    Why the ledger and not asin_daily_data.units_ordered: units_ordered comes from
    salesAndTrafficByAsin, which counts Amazon-marketplace orders ONLY. Shopify orders
    fulfilled via Amazon MCF are not Amazon-marketplace orders, so they're invisible there.
    The ledger's customer-shipment events capture Amazon orders AND MCF removals together —
    the true draw-down of the FBA pool.

    Reuses the existing SP-API auth/client (SP_CREDS) and Supabase REST helpers — no new
    secrets, no second auth path. Scope is Amazon FBA "Pool 1" across all marketplaces in
    AMAZON_MARKETPLACE_ID.

    Idempotent: the trailing _LEDGER_OVERWRITE_DAYS days of the range are deleted and
    re-inserted each run (the ledger keeps reconciling for several days); the rest is
    upserted on the (ship_date, msku, brand) primary key.

    MUST-VERIFY (logged each run — see _LEDGER_SHIPMENT_EVENT_TYPES TODO): the distinct
    event-type strings found, that required TSV headers exist, MCF reconciliation, and the
    quantity sign convention.
    """
    marketplace_ids = [m.strip() for m in SP_MARKETPLACE_ID.split(",") if m.strip()]

    log.info(f"{'='*60}")
    log.info(f"FBA INVENTORY LEDGER: {start} → {end}  (brand: {brand}, marketplaces: {marketplace_ids})")
    log.info(f"{'='*60}")

    api = Reports(credentials=SP_CREDS, marketplace=Marketplaces.US)
    try:
        resp = api.create_report(
            reportType="GET_LEDGER_DETAIL_VIEW_DATA",
            dataStartTime=start.strftime("%Y-%m-%dT00:00:00Z"),
            dataEndTime=end.strftime("%Y-%m-%dT23:59:59Z"),
            marketplaceIds=marketplace_ids,
        )
    except Exception as exc:
        # A 403 here means the refresh token doesn't carry the "Amazon Fulfillment"
        # role (or Amazon hasn't attached it server-side). Surface the Amazon request
        # id so it can be handed to SP-API developer support.
        hdrs = getattr(exc, "headers", None) or {}
        req_id = hdrs.get("x-amzn-RequestId") or hdrs.get("x-amzn-requestid") or "unknown"
        log.error(
            f"create_report failed for GET_LEDGER_DETAIL_VIEW_DATA: {type(exc).__name__}: {exc}"
        )
        log.error(
            f"  → If this is a 403/Unauthorized: the token lacks the 'Amazon Fulfillment' role. "
            f"Amazon request id (for a support case): {req_id}"
        )
        raise
    report_id = resp.payload["reportId"]
    log.info(f"  Ledger report ID: {report_id} — polling…")
    doc_id  = _sp_wait(api, report_id, timeout=1800)
    content = _sp_download(api, doc_id)

    rows, event_counts = _parse_ledger_tsv(content, brand)

    # MUST-VERIFY logging: distinct event types found — lock the filter from this.
    log.info(f"  Ledger distinct event types seen: {event_counts}")
    log.info(f"  Customer-shipment rows after filter "
             f"(matched {sorted(_LEDGER_SHIPMENT_EVENT_TYPES)}): {len(rows)}")

    # Idempotent overwrite of the trailing reconciliation window, then upsert the rest.
    overwrite_from = max(start, end - timedelta(days=_LEDGER_OVERWRITE_DAYS - 1))
    supabase_delete_range("fba_daily_shipped", brand, overwrite_from, end)
    log.info(f"  Cleared trailing window {overwrite_from} → {end} for idempotent re-insert")

    supabase_upsert("fba_daily_shipped", rows)

    units_total = sum(r["units"] for r in rows)
    n_mskus = len({r["msku"] for r in rows})
    n_days  = len({r["ship_date"] for r in rows})
    log.info(f"✓ Ledger: {len(rows)} row(s), {n_mskus} MSKU(s), {units_total} units across {n_days} day(s)")
    print(f"\n  ✓ Inventory ledger {start} → {end}: {len(rows)} rows, "
          f"{n_mskus} MSKUs, {units_total} units shipped\n")


# ── MCF probe (Fulfillment Outbound API) ───────────────────────────────────────

def fetch_mcf_probe(brand: str) -> None:
    """
    READ-ONLY diagnostic. Tests whether the Fulfillment Outbound API (MCF orders) is
    accessible with the current token. It's a DIFFERENT API surface than the Reports
    ledger but shares the SAME Amazon Fulfillment role — so:
      • If it WORKS  → the role is attached; the ledger 403 is report-type-specific,
                       and this API itself is a clean MCF data source we can pull from.
      • If it 403s   → the role genuinely isn't granting access → support case.
    Logs a small non-PII sample (order ids, status, dates, and one order's SKUs) or the
    403 request id. Writes nothing to the database.
    """
    api = FulfillmentOutbound(credentials=SP_CREDS, marketplace=Marketplaces.US)
    query_start = (date.today() - timedelta(days=30)).strftime("%Y-%m-%dT00:00:00Z")

    log.info(f"{'='*60}")
    log.info(f"MCF PROBE (Fulfillment Outbound) — orders since {query_start[:10]}")
    log.info(f"{'='*60}")

    try:
        resp = api.list_all_fulfillment_orders(queryStartDate=query_start)
    except Exception as exc:
        hdrs   = getattr(exc, "headers", None) or {}
        req_id = hdrs.get("x-amzn-RequestId") or hdrs.get("x-amzn-requestid") or "unknown"
        log.error(f"list_all_fulfillment_orders failed: {type(exc).__name__}: {exc}")
        log.error(f"  → If this is 403/Unauthorized, the token still lacks the 'Amazon "
                  f"Fulfillment' role. Amazon request id (for support): {req_id}")
        raise

    payload = resp.payload or {}
    orders  = payload.get("fulfillmentOrders") or payload.get("FulfillmentOrders") or []
    log.info(f"✓ Fulfillment Outbound ACCESSIBLE — {len(orders)} MCF order(s) in the last 30 days")

    for o in orders[:5]:
        sfid = o.get("sellerFulfillmentOrderId") or o.get("SellerFulfillmentOrderId")
        disp = o.get("displayableOrderId")       or o.get("DisplayableOrderId")
        stat = o.get("fulfillmentOrderStatus")   or o.get("FulfillmentOrderStatus")
        recv = o.get("receivedDate")             or o.get("ReceivedDate")
        log.info(f"  order: id={sfid} | displayable={disp} | status={stat} | received={recv}")

    # Pull one order's line items to confirm we can get SKU + quantity
    if orders:
        sfid = orders[0].get("sellerFulfillmentOrderId") or orders[0].get("SellerFulfillmentOrderId")
        try:
            detail = (api.get_fulfillment_order(sellerFulfillmentOrderId=sfid).payload or {})
            items  = detail.get("fulfillmentOrderItems") or detail.get("FulfillmentOrderItems") or []
            parts  = [f"{it.get('sellerSku') or it.get('SellerSku')} x{it.get('quantity') or it.get('Quantity')}"
                      for it in items]
            log.info(f"  sample SKUs for {sfid}: {parts}")
        except Exception as exc:
            log.warning(f"  could not fetch line items for {sfid}: {exc}")

    print(f"\n  ✓ MCF probe OK — Fulfillment Outbound returned {len(orders)} order(s) in 30 days. "
          f"If this worked, the role is fine and we can pull MCF here.\n")


def _mcf_get_order_items(api: FulfillmentOutbound, sfid: str, max_retries: int = 4) -> list[dict]:
    """Fetch one MCF order's line items, retrying on throttling."""
    backoff = [2, 5, 10, 20]
    for attempt in range(max_retries + 1):
        try:
            detail = api.get_fulfillment_order(sellerFulfillmentOrderId=sfid).payload or {}
            return detail.get("fulfillmentOrderItems") or detail.get("FulfillmentOrderItems") or []
        except Exception as exc:
            code = getattr(getattr(exc, "response", None), "status_code", None)
            throttled = code == 429 or "throttl" in str(exc).lower()
            if throttled and attempt < max_retries:
                wait = backoff[min(attempt, len(backoff) - 1)]
                log.warning(f"  Throttled on {sfid} — waiting {wait}s")
                time.sleep(wait)
                continue
            log.warning(f"  Could not fetch items for {sfid}: {exc}")
            return []
    return []


def fetch_mcf_orders(start: date, end: date, brand: str) -> None:
    """
    Pull MCF fulfillment orders (Shopify orders fulfilled from FBA) for [start, end] via
    the Fulfillment Outbound API, sum units per (ship_date, msku), and upsert into
    fba_daily_shipped — the off-Amazon half of FBA depletion.

    Why this source: the FBA Inventory Ledger report 403s (report-type-specific), but
    Fulfillment Outbound works with the same Amazon Fulfillment role. Only MCF orders
    appear here (TikTok-from-3PL never touches FBA), so no channel filtering is needed —
    every order genuinely depleted the FBA pool. Bucketed by received date in the seller
    timezone. Cancelled/invalid orders are skipped.

    Idempotent: deletes + re-inserts the trailing _MCF_OVERWRITE_DAYS days each run.
    """
    api = FulfillmentOutbound(credentials=SP_CREDS, marketplace=Marketplaces.US)
    query_start = start.strftime("%Y-%m-%dT00:00:00Z")

    log.info(f"{'='*60}")
    log.info(f"MCF ORDERS (Fulfillment Outbound): {start} → {end}  (brand: {brand})")
    log.info(f"{'='*60}")

    # ── Step 1: list all MCF orders received since `start` (paginated) ──────────
    summaries: list[dict] = []
    next_token: str | None = None
    page = 0
    while True:
        page += 1
        if next_token:
            resp = api.list_all_fulfillment_orders(nextToken=next_token)
        else:
            resp = api.list_all_fulfillment_orders(queryStartDate=query_start)
        payload = resp.payload or {}
        batch   = payload.get("fulfillmentOrders") or payload.get("FulfillmentOrders") or []
        summaries.extend(batch)
        next_token = payload.get("nextToken") or payload.get("NextToken")
        log.info(f"  List page {page}: {len(batch)} order(s) (total {len(summaries)})")
        if not next_token:
            break
        time.sleep(1)   # gentle on the list rate limit

    # ── Step 2: filter by date/status, fetch items, aggregate per (date, sku) ───
    agg: dict[tuple[str, str], int] = {}
    counted = skipped_cancel = skipped_date = 0

    for o in summaries:
        status = (o.get("fulfillmentOrderStatus") or o.get("FulfillmentOrderStatus") or "").lower()
        if status in ("cancelled", "canceled", "invalid"):
            skipped_cancel += 1
            continue

        recv = o.get("receivedDate") or o.get("ReceivedDate")
        if not recv:
            continue
        try:
            utc_dt   = _dt.fromisoformat(recv.replace("Z", "+00:00"))
            local_dt = utc_dt.astimezone(_SELLER_TZ)
            date_str = local_dt.strftime("%Y-%m-%d")
        except Exception:
            continue

        d = date.fromisoformat(date_str)
        if d < start or d > end:
            skipped_date += 1
            continue

        sfid = o.get("sellerFulfillmentOrderId") or o.get("SellerFulfillmentOrderId")
        if not sfid:
            continue

        items = _mcf_get_order_items(api, sfid)
        for it in items:
            sku = (it.get("sellerSku") or it.get("SellerSku") or "").strip()
            try:
                qty = int(it.get("quantity") or it.get("Quantity") or 0)
            except (ValueError, TypeError):
                continue
            if not sku or qty <= 0:
                continue
            agg[(date_str, sku)] = agg.get((date_str, sku), 0) + qty
        counted += 1
        time.sleep(0.5)   # ~2 req/sec for the per-order detail calls

    rows = [
        {"ship_date": d, "msku": s, "brand": brand, "units": u}
        for (d, s), u in agg.items()
    ]

    overwrite_from = max(start, end - timedelta(days=_MCF_OVERWRITE_DAYS - 1))
    supabase_delete_range("fba_daily_shipped", brand, overwrite_from, end)
    log.info(f"  Cleared trailing window {overwrite_from} → {end} for idempotent re-insert")

    supabase_upsert("fba_daily_shipped", rows)

    units_total = sum(r["units"] for r in rows)
    n_mskus = len({r["msku"] for r in rows})
    n_days  = len({r["ship_date"] for r in rows})
    log.info(f"✓ MCF orders: {len(rows)} row(s), {n_mskus} MSKU(s), {units_total} units across {n_days} day(s) "
             f"| {counted} orders counted, {skipped_cancel} cancelled, {skipped_date} out-of-range")
    print(f"\n  ✓ MCF orders {start} → {end}: {len(rows)} rows, {n_mskus} MSKUs, "
          f"{units_total} units (Shopify via MCF)\n")


# ── Amazon marketplace units by SKU (Sales & Traffic windows) ──────────────────

def _sp_create_report_retry(api: Reports, max_retries: int = 6, **kwargs):
    """create_report with exponential backoff on throttling — the createReport quota
    is low (~1/min sustained), so submitting several reports needs 429 retries."""
    backoff = [20, 40, 60, 90, 120, 120]
    for attempt in range(max_retries + 1):
        try:
            return api.create_report(**kwargs)
        except Exception as exc:
            throttled = "Throttl" in type(exc).__name__ or "QuotaExceeded" in str(exc)
            if throttled and attempt < max_retries:
                wait = backoff[min(attempt, len(backoff) - 1)]
                log.warning(f"  createReport throttled — waiting {wait}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                continue
            raise


def _fetch_sku_map(brand: str) -> dict[str, str]:
    """User-maintained ASIN→canonical-SKU overrides (sku_map). Wins over the listings
    report, for products whose Amazon listing SKU differs from the canonical SKU."""
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/sku_map",
            headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"},
            params=[("brand", f"eq.{brand}"), ("select", "asin,msku")],
            timeout=30,
        )
        resp.raise_for_status()
        return {r["asin"]: r["msku"] for r in resp.json() if r.get("asin") and r.get("msku")}
    except Exception as exc:
        log.warning(f"  Could not load sku_map overrides: {exc}")
        return {}


def _pull_listings_asin_sku_map() -> dict[str, str]:
    """
    Pull the ACTIVE listings report (GET_MERCHANT_LISTINGS_DATA) → {asin: seller_sku}.
    Active-only avoids stale/ghost duplicate listings — the "All Listings" report includes
    old inactive SKUs for the same ASIN, which mis-mapped some products. Used to key the
    (child-ASIN) Sales & Traffic numbers by canonical MSKU.
    """
    api = Reports(credentials=SP_CREDS, marketplace=Marketplaces.US)
    marketplace_ids = [m.strip() for m in SP_MARKETPLACE_ID.split(",") if m.strip()]
    try:
        resp = _sp_create_report_retry(
            api,
            reportType="GET_MERCHANT_LISTINGS_DATA",
            marketplaceIds=marketplace_ids,
        )
    except Exception as exc:
        hdrs   = getattr(exc, "headers", None) or {}
        req_id = hdrs.get("x-amzn-RequestId") or hdrs.get("x-amzn-requestid") or "unknown"
        log.error(f"create_report failed for GET_MERCHANT_LISTINGS_DATA: {type(exc).__name__}: {exc}")
        log.error(f"  → If 403: token lacks listings-report access. Amazon request id: {req_id}")
        raise

    report_id = resp.payload["reportId"]
    doc_id  = _sp_wait(api, report_id, timeout=900)
    content = _sp_download(api, doc_id)

    lines = content.split("\n")
    if not lines or not lines[0].strip():
        raise RuntimeError("Listings report was empty")
    headers = lines[0].rstrip("\r").split("\t")
    i_sku  = _ledger_header_index(headers, ["seller-sku", "sku"], required=True)
    i_asin = _ledger_header_index(headers, ["asin1", "asin"], required=True)

    mapping: dict[str, str] = {}
    for line in lines[1:]:
        cells = line.rstrip("\r").split("\t")
        if len(cells) <= max(i_sku, i_asin):
            continue
        sku  = cells[i_sku].strip()
        asin = cells[i_asin].strip()
        if sku and asin:
            mapping[asin] = sku
    log.info(f"  Listings map: {len(mapping)} ASIN→SKU pair(s)")
    return mapping


def fetch_amazon_sales_windows(brand: str) -> None:
    """
    Pull Amazon-marketplace UNITS ORDERED per SKU for the 7/14/30/60/90-day windows
    ending yesterday, from the authoritative Detail Page Sales & Traffic report
    (GET_SALES_AND_TRAFFIC_REPORT, child-ASIN granularity), mapped ASIN→SKU via the
    listings report. Upserts pre-computed window totals into amazon_sku_windows.

    Each window is its own report covering its full range, so 60/90-day windows are
    complete regardless of daily history. Replaces the brand's rows each run (snapshots).
    """
    windows = [7, 14, 30, 60, 90]
    yesterday = date.today() - timedelta(days=1)

    log.info(f"{'='*60}")
    log.info(f"AMAZON SALES WINDOWS (Sales & Traffic): {windows} ending {yesterday}  (brand: {brand})")
    log.info(f"{'='*60}")

    asin_sku = _pull_listings_asin_sku_map()
    overrides = _fetch_sku_map(brand)   # user-maintained ASIN→canonical-SKU, wins over listings
    if overrides:
        asin_sku.update(overrides)
        log.info(f"  Applied {len(overrides)} sku_map override(s)")
    sku_asin = {sku: asin for asin, sku in asin_sku.items()}

    api = Reports(credentials=SP_CREDS, marketplace=Marketplaces.US)
    marketplace_ids = [m.strip() for m in SP_MARKETPLACE_ID.split(",") if m.strip()]

    # Submit all window reports up front (fan-out), then poll together.
    pending: list[tuple[str, int]] = []
    for i, N in enumerate(windows):
        if i > 0:
            time.sleep(15)   # ease the createReport quota between submissions
        start = yesterday - timedelta(days=N - 1)
        resp = _sp_create_report_retry(
            api,
            reportType="GET_SALES_AND_TRAFFIC_REPORT",
            dataStartTime=start.strftime("%Y-%m-%dT00:00:00Z"),
            dataEndTime=yesterday.strftime("%Y-%m-%dT23:59:59Z"),
            reportOptions={"dateGranularity": "DAY", "asinGranularity": "CHILD"},
            marketplaceIds=marketplace_ids,
        )
        pending.append((resp.payload["reportId"], N))
        log.info(f"  Submitted S&T {N}d ({start} → {yesterday}): {resp.payload['reportId']}")

    completed: list[tuple[str, int]] = []   # (doc_id, N)
    remaining = list(pending)
    deadline  = time.time() + 1800
    while remaining and time.time() < deadline:
        time.sleep(30)
        still = []
        for report_id, N in remaining:
            try:
                r = api.get_report(reportId=report_id)
                status = r.payload["processingStatus"]
                if status == "DONE":
                    completed.append((r.payload["reportDocumentId"], N))
                    log.info(f"  ✓ S&T {N}d done")
                elif status in ("FATAL", "CANCELLED"):
                    log.warning(f"  ✗ S&T {N}d: {status}")
                else:
                    still.append((report_id, N))
            except Exception as exc:
                log.warning(f"  Poll error S&T {N}d: {exc}")
                still.append((report_id, N))
        remaining = still
        if remaining:
            log.info(f"  Still waiting on {len(remaining)} S&T report(s)…")

    # Parse each window's by-ASIN units ordered → per SKU window totals
    per_sku: dict[str, dict] = {}
    for doc_id, N in completed:
        try:
            content   = _sp_download(api, doc_id)
            asin_data = _sp_parse_asin(content)   # {childAsin: {units_ordered, …}}
            for asin, m in asin_data.items():
                sku = asin_sku.get(asin)
                if not sku:
                    continue
                units = m.get("units_ordered") or 0
                row = per_sku.setdefault(sku, {})
                row[f"units_{N}"] = row.get(f"units_{N}", 0) + int(units)
            log.info(f"  Parsed S&T {N}d: {len(asin_data)} ASIN(s)")
        except Exception as exc:
            log.warning(f"  Failed to parse S&T {N}d: {exc}")

    rows = [
        {
            "msku":  sku,
            "brand": brand,
            "asin":  sku_asin.get(sku),
            "units_7":  w.get("units_7", 0),
            "units_14": w.get("units_14", 0),
            "units_30": w.get("units_30", 0),
            "units_60": w.get("units_60", 0),
            "units_90": w.get("units_90", 0),
        }
        for sku, w in per_sku.items()
    ]

    # These are full-window snapshots — replace the brand's rows rather than merge.
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/amazon_sku_windows",
        headers=_sb_headers(),
        params=[("brand", f"eq.{brand}")],
        timeout=60,
    )
    supabase_upsert("amazon_sku_windows", rows)

    total30 = sum(r["units_30"] for r in rows)
    log.info(f"✓ Amazon sales windows: {len(rows)} SKU(s) (30-day total {total30} units)")
    print(f"\n  ✓ Amazon sales windows (ending {yesterday}): {len(rows)} SKUs, 30d total {total30} units\n")


# ── Shopify (online-store MCF depletion) ───────────────────────────────────────

_SHOPIFY_ORDERS_QUERY = """
query($cursor: String, $q: String!) {
  orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
    edges {
      node {
        createdAt
        cancelledAt
        tags
        lineItems(first: 100) {
          edges { node { sku quantity } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""


def _shopify_graphql(url: str, headers: dict, variables: dict, max_retries: int = 5) -> dict:
    """POST a GraphQL query, retrying on Shopify rate limiting (HTTP 429 or THROTTLED)."""
    backoff = [2, 5, 10, 20, 30]
    for attempt in range(max_retries + 1):
        resp = requests.post(
            url, headers=headers,
            json={"query": _SHOPIFY_ORDERS_QUERY, "variables": variables},
            timeout=60,
        )
        if resp.status_code == 429:
            wait = backoff[min(attempt, len(backoff) - 1)]
            log.warning(f"  Shopify 429 — waiting {wait}s")
            time.sleep(wait)
            continue
        if not resp.ok:
            log.error(f"Shopify {resp.status_code}: {resp.text[:300]}")
            resp.raise_for_status()
        data = resp.json()
        errs = data.get("errors")
        if errs:
            throttled = any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in errs)
            if throttled and attempt < max_retries:
                wait = backoff[min(attempt, len(backoff) - 1)]
                log.warning(f"  Shopify THROTTLED — waiting {wait}s")
                time.sleep(wait)
                continue
            raise RuntimeError(f"Shopify GraphQL errors: {errs}")
        return data["data"]
    raise RuntimeError("Shopify GraphQL: exhausted retries")


def fetch_shopify_orders(start: date, end: date, brand: str) -> None:
    """
    Pull Shopify ONLINE-STORE orders for [start, end], sum units per (ship_date, msku),
    and upsert into shopify_daily_shipped — the MCF half of FBA depletion.

    All online-store orders are MCF-fulfilled from Amazon FBA, so every unit here draws
    down the same pool as Amazon orders. TikTok orders (which ship from a 3PL) are
    excluded by tag. Cancelled orders are skipped. Bucketed by order date in the seller
    timezone, consistent with the Orders heatmap.

    Idempotent: deletes + re-inserts the trailing _SHOPIFY_OVERWRITE_DAYS days each run.
    Skips cleanly if SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN are not set.
    """
    if not SHOPIFY_STORE_DOMAIN or not SHOPIFY_ADMIN_TOKEN:
        log.warning("Shopify creds not set (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN) — skipping Shopify pull")
        return

    url = f"https://{SHOPIFY_STORE_DOMAIN}/admin/api/{_SHOPIFY_API_VERSION}/graphql.json"
    headers = {"X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json"}
    end_excl = end + timedelta(days=1)   # created_at:< next day → include the whole end day
    q = (f"created_at:>={start.isoformat()} created_at:<{end_excl.isoformat()} "
         f"-tag:'{_SHOPIFY_EXCLUDE_TAG}'")

    log.info(f"{'='*60}")
    log.info(f"SHOPIFY ONLINE-STORE (MCF): {start} → {end}  (brand: {brand}, excl tag: '{_SHOPIFY_EXCLUDE_TAG}')")
    log.info(f"{'='*60}")

    agg: dict[tuple[str, str], int] = {}
    excluded_tiktok = 0
    cursor: str | None = None
    page = 0

    while True:
        page += 1
        conn = _shopify_graphql(url, headers, {"cursor": cursor, "q": q})["orders"]

        for edge in conn["edges"]:
            node = edge["node"]
            if node.get("cancelledAt"):
                continue
            # Belt-and-suspenders: skip anything tagged TikTok even if the query filter shifts
            if any("tiktok" in (t or "").lower() for t in (node.get("tags") or [])):
                excluded_tiktok += 1
                continue

            try:
                utc_dt   = _dt.fromisoformat(node["createdAt"].replace("Z", "+00:00"))
                local_dt = utc_dt.astimezone(_SELLER_TZ)
                date_str = local_dt.strftime("%Y-%m-%d")
            except Exception:
                continue

            d = date.fromisoformat(date_str)
            if d < start or d > end:
                continue

            for li in node["lineItems"]["edges"]:
                sku = (li["node"].get("sku") or "").strip()
                qty = li["node"].get("quantity") or 0
                if not sku or qty <= 0:
                    continue
                key = (date_str, sku)
                agg[key] = agg.get(key, 0) + qty

        if conn["pageInfo"]["hasNextPage"]:
            cursor = conn["pageInfo"]["endCursor"]
            time.sleep(0.6)   # gentle on the GraphQL rate bucket
            log.info(f"  Shopify page {page}: {len(agg)} (date,sku) buckets so far…")
        else:
            break

    rows = [
        {"ship_date": d, "msku": s, "brand": brand, "units": u}
        for (d, s), u in agg.items()
    ]

    overwrite_from = max(start, end - timedelta(days=_SHOPIFY_OVERWRITE_DAYS - 1))
    supabase_delete_range("shopify_daily_shipped", brand, overwrite_from, end)
    log.info(f"  Cleared trailing window {overwrite_from} → {end} for idempotent re-insert")

    supabase_upsert("shopify_daily_shipped", rows)

    units_total = sum(r["units"] for r in rows)
    n_mskus = len({r["msku"] for r in rows})
    n_days  = len({r["ship_date"] for r in rows})
    log.info(f"✓ Shopify: {len(rows)} row(s), {n_mskus} MSKU(s), {units_total} units across {n_days} day(s) "
             f"({excluded_tiktok} TikTok order(s) excluded)")
    print(f"\n  ✓ Shopify online-store {start} → {end}: {len(rows)} rows, "
          f"{n_mskus} MSKUs, {units_total} units (MCF)\n")


# ── Orchestration ──────────────────────────────────────────────────────────────

def pull_day(target: date, brand: str) -> None:
    """
    Single day pull — revenue + ASIN traffic + PPC spend.

    SP-API reports are requested for the last 5 days simultaneously (fan-out)
    so that delayed ASIN traffic data (sessions, CVR, Buy Box %) is refreshed
    once Amazon finalises it. Amazon typically takes 2-4 days to publish
    accurate session counts — pulling only yesterday leaves recent rows at 0.
    """
    log.info(f"{'='*60}")
    log.info(f"DAILY PULL: {target}  (brand: {brand})")
    log.info(f"{'='*60}")

    # SP-API: fan-out last 5 days so delayed session/CVR data gets refreshed.
    # Amazon takes up to 4 days to finalise ASIN traffic — 5-day window gives buffer.
    # All reports submitted simultaneously; poll together — no extra wall-clock time.
    sp_days = [target - timedelta(days=i) for i in range(5)]
    log.info(f"SP-API: submitting reports for {sp_days[-1]} → {sp_days[0]} (5 days)…")

    revenue: float | None = None
    asin_traffic: dict[str, dict] = {}
    try:
        sp_results = sp_pull_days_fanout(sp_days)

        # Primary day: grab revenue for today's daily_data row
        target_str = target.strftime("%Y-%m-%d")
        if target_str in sp_results:
            revenue, asin_traffic = sp_results[target_str]
        log.info(f"Revenue: {revenue}  |  ASINs (today): {len(asin_traffic)}")

        # Upsert ASIN data for ALL returned days (refreshes delayed traffic data)
        for date_str, (_, day_asin) in sp_results.items():
            if not day_asin:
                continue
            supabase_upsert("asin_daily_data", [
                {
                    "date":                  date_str,
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
                for asin, m in day_asin.items()
            ])
    except Exception as exc:
        log.error(f"SP-API failed: {exc}")

    # Ads API: PPC spend (target day only)
    spend: float | None = None
    try:
        spend_map = ads_pull_range(target, target)
        spend = spend_map.get(target.strftime("%Y-%m-%d"))
        log.info(f"PPC spend: {spend}")
    except Exception as exc:
        log.error(f"Ads API failed: {exc}")

    # Upsert daily_data for target day (Amazon columns only — CSV channels untouched)
    supabase_upsert("daily_data", [{
        "date":             target.strftime("%Y-%m-%d"),
        "brand":            brand,
        "amazon_revenue":   revenue,
        "amazon_ppc_spend": spend,
    }])

    # Orders API: bucket by hour for heatmap (target day only — fast, 1-3 pages)
    try:
        orders_pull_range(target, target, brand)
    except Exception as exc:
        log.error(f"Orders API failed: {exc}")

    # Per-campaign performance for budget allocation (read-only analysis data)
    try:
        ads_pull_campaigns_range(target, target, brand)
    except Exception as exc:
        log.error(f"Campaign data pull failed: {exc}")

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

    # Orders: pull full range for heatmap data (paginated, may take a while for long ranges)
    try:
        log.info("Pulling Orders API for heatmap data (this may take a few minutes)…")
        orders_pull_range(start, end, brand)
    except Exception as exc:
        log.error(f"Orders API range pull failed: {exc}")

    # Per-campaign performance for budget allocation (read-only analysis data)
    try:
        log.info("Pulling per-campaign performance for budget allocation…")
        ads_pull_campaigns_range(start, end, brand)
    except Exception as exc:
        log.error(f"Campaign data range pull failed: {exc}")

    # Summary
    got_rev   = sum(1 for r in rows if r["amazon_revenue"]   is not None)
    got_spend = sum(1 for r in rows if r["amazon_ppc_spend"] is not None)
    print(f"\n  ✓ Backfill complete: {days} days upserted")
    print(f"    Revenue populated:   {got_rev}/{days} days")
    print(f"    PPC spend populated: {got_spend}/{days} days\n")


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Pull Amazon data into Supabase")
    parser.add_argument("--date",        help="Single date YYYY-MM-DD (default: yesterday)")
    parser.add_argument("--start",       help="Backfill start date YYYY-MM-DD")
    parser.add_argument("--end",         help="Backfill end date YYYY-MM-DD")
    parser.add_argument("--brand",       default=ACTIVE_BRAND)
    parser.add_argument("--orders-only", action="store_true",
                        help="Pull Orders API only (hourly_sales heatmap). Skip SP-API + Ads API.")
    parser.add_argument("--campaigns-only", action="store_true",
                        help="Pull per-campaign Ads performance only (campaign_daily). Skip everything else.")
    parser.add_argument("--ledger-only", action="store_true",
                        help="Pull FBA Inventory Ledger only (fba_daily_shipped). Skip everything else.")
    parser.add_argument("--shopify-only", action="store_true",
                        help="Pull Shopify online-store MCF units only (shopify_daily_shipped). Skip everything else.")
    parser.add_argument("--mcf-probe", action="store_true",
                        help="Read-only: test whether the Fulfillment Outbound API (MCF orders) is accessible. No DB writes.")
    parser.add_argument("--mcf-orders-only", action="store_true",
                        help="Pull MCF fulfillment orders only (fba_daily_shipped) via Fulfillment Outbound. Skip everything else.")
    parser.add_argument("--amazon-skus-only", action="store_true",
                        help="Pull Amazon-marketplace units per SKU only (amazon_sku_windows) via Sales & Traffic windows. Skip everything else.")
    args = parser.parse_args()

    # ── MCF probe (read-only diagnostic) ────────────────────────────────────────
    if args.mcf_probe:
        fetch_mcf_probe(args.brand)
        return

    # ── MCF-orders-only mode ────────────────────────────────────────────────────
    if args.mcf_orders_only:
        if args.start and args.end:
            log.info("MCF-orders-only backfill mode")
            fetch_mcf_orders(
                date.fromisoformat(args.start),
                date.fromisoformat(args.end),
                args.brand,
            )
        elif args.date:
            d = date.fromisoformat(args.date)
            log.info(f"MCF-orders-only single-day mode: {d}")
            fetch_mcf_orders(d, d, args.brand)
        else:
            mcf_end   = date.today() - timedelta(days=1)
            mcf_start = date.today() - timedelta(days=_MCF_LOOKBACK_DAYS)
            log.info(f"MCF-orders-only mode: last {_MCF_LOOKBACK_DAYS} days ({mcf_start} → {mcf_end})")
            fetch_mcf_orders(mcf_start, mcf_end, args.brand)
        return

    # ── Amazon-SKUs-only mode ───────────────────────────────────────────────────
    # Always pulls the 7/14/30/60/90 windows ending yesterday (no date range needed).
    if args.amazon_skus_only:
        log.info("Amazon-SKUs-only mode: Sales & Traffic windows ending yesterday")
        fetch_amazon_sales_windows(args.brand)
        return

    # ── Orders-only mode ────────────────────────────────────────────────────────
    if args.orders_only:
        if args.start and args.end:
            log.info("Orders-only backfill mode")
            orders_pull_range(
                date.fromisoformat(args.start),
                date.fromisoformat(args.end),
                args.brand,
            )
        elif args.date:
            d = date.fromisoformat(args.date)
            log.info(f"Orders-only single-day mode: {d}")
            orders_pull_range(d, d, args.brand)
        else:
            yesterday = date.today() - timedelta(days=1)
            log.info(f"Orders-only mode: pulling yesterday ({yesterday})")
            orders_pull_range(yesterday, yesterday, args.brand)
        return

    # ── Campaigns-only mode ─────────────────────────────────────────────────────
    if args.campaigns_only:
        if args.start and args.end:
            log.info("Campaigns-only backfill mode")
            ads_pull_campaigns_range(
                date.fromisoformat(args.start),
                date.fromisoformat(args.end),
                args.brand,
            )
        elif args.date:
            d = date.fromisoformat(args.date)
            log.info(f"Campaigns-only single-day mode: {d}")
            ads_pull_campaigns_range(d, d, args.brand)
        else:
            yesterday = date.today() - timedelta(days=1)
            log.info(f"Campaigns-only mode: pulling yesterday ({yesterday})")
            ads_pull_campaigns_range(yesterday, yesterday, args.brand)
        return

    # ── Ledger-only mode ────────────────────────────────────────────────────────
    if args.ledger_only:
        if args.start and args.end:
            log.info("Ledger-only backfill mode")
            fetch_inventory_ledger(
                date.fromisoformat(args.start),
                date.fromisoformat(args.end),
                args.brand,
            )
        elif args.date:
            d = date.fromisoformat(args.date)
            log.info(f"Ledger-only single-day mode: {d}")
            fetch_inventory_ledger(d, d, args.brand)
        else:
            led_end   = date.today() - timedelta(days=1)
            led_start = date.today() - timedelta(days=_LEDGER_LOOKBACK_DAYS)
            log.info(f"Ledger-only mode: last {_LEDGER_LOOKBACK_DAYS} days ({led_start} → {led_end})")
            fetch_inventory_ledger(led_start, led_end, args.brand)
        return

    # ── Shopify-only mode ───────────────────────────────────────────────────────
    if args.shopify_only:
        if args.start and args.end:
            log.info("Shopify-only backfill mode")
            fetch_shopify_orders(
                date.fromisoformat(args.start),
                date.fromisoformat(args.end),
                args.brand,
            )
        elif args.date:
            d = date.fromisoformat(args.date)
            log.info(f"Shopify-only single-day mode: {d}")
            fetch_shopify_orders(d, d, args.brand)
        else:
            shop_end   = date.today() - timedelta(days=1)
            shop_start = date.today() - timedelta(days=_SHOPIFY_LOOKBACK_DAYS)
            log.info(f"Shopify-only mode: last {_SHOPIFY_LOOKBACK_DAYS} days ({shop_start} → {shop_end})")
            fetch_shopify_orders(shop_start, shop_end, args.brand)
        return

    # ── Full pull modes ─────────────────────────────────────────────────────────
    if args.start and args.end:
        backfill_range(
            date.fromisoformat(args.start),
            date.fromisoformat(args.end),
            args.brand,
        )
    elif args.date:
        # Explicit single date — no gap scan, just pull that day
        pull_day(date.fromisoformat(args.date), args.brand)
    else:
        # Default cron mode: scan for gaps first, then pull yesterday
        auto_backfill_gaps(args.brand, lookback_days=30)         # missing days entirely
        auto_backfill_ppc_gaps(args.brand, lookback_days=30)     # days with revenue but no PPC (nulls)
        refresh_recent_ppc(args.brand, days=_PPC_REFRESH_DAYS)   # overwrite last N days (Ads finalises late)
        auto_refresh_asin_sessions(args.brand, lookback_days=30) # days with sessions=0 (delayed traffic)
        pull_day(date.today() - timedelta(days=1), args.brand)

        # MCF orders (Fulfillment Outbound): off-Amazon FBA depletion — your Shopify
        # orders fulfilled from FBA. This is the WORKING depletion feed (the ledger
        # report 403s). Additive and non-fatal so it can't break the core pull.
        try:
            mcf_end   = date.today() - timedelta(days=1)
            mcf_start = date.today() - timedelta(days=_MCF_LOOKBACK_DAYS)
            fetch_mcf_orders(mcf_start, mcf_end, args.brand)
        except Exception as exc:
            log.error(f"MCF orders pull failed (non-fatal): {exc}")
            log.error(traceback.format_exc())

        # Amazon-marketplace units by SKU (Sales & Traffic windows) — the other half of
        # FBA depletion. Combined with MCF in sku_velocity = total demand. Non-fatal.
        try:
            fetch_amazon_sales_windows(args.brand)
        except Exception as exc:
            log.error(f"Amazon sales-windows pull failed (non-fatal): {exc}")
            log.error(traceback.format_exc())

        # Shopify online-store MCF depletion (the MCF half, sourced directly from Shopify
        # while the FBA ledger is blocked). Also additive and non-fatal.
        try:
            shop_end   = date.today() - timedelta(days=1)
            shop_start = date.today() - timedelta(days=_SHOPIFY_LOOKBACK_DAYS)
            fetch_shopify_orders(shop_start, shop_end, args.brand)
        except Exception as exc:
            log.error(f"Shopify pull failed (non-fatal): {exc}")
            log.error(traceback.format_exc())


if __name__ == "__main__":
    main()

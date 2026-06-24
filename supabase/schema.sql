-- ============================================================
-- X PRO Dashboard — Supabase Schema
-- Run this entire file in: Supabase → SQL Editor → New query
-- ============================================================


-- ── 1. daily_data ────────────────────────────────────────────
-- One row per calendar day per brand.
-- Stores all raw inputs; derived metrics (ROAS, TACOS, etc.) are computed on read.

create table if not exists daily_data (
  date                 date          not null,
  brand                varchar(50)   not null default 'xpro',

  -- Ad spend levers
  amazon_ppc_spend     numeric(12,2),
  tiktok_ads_spend     numeric(12,2),
  meta_ads_spend       numeric(12,2),

  -- Channel revenue (total ordered product sales, not ad-attributed)
  amazon_revenue       numeric(12,2),
  tiktok_shop_revenue  numeric(12,2),
  shopify_revenue      numeric(12,2),

  -- Manual annotation
  annotation           text,

  -- Audit
  created_at           timestamptz   not null default now(),
  updated_at           timestamptz   not null default now(),

  primary key (date, brand)
);

-- Auto-update updated_at on every write
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger daily_data_updated_at
  before update on daily_data
  for each row execute function set_updated_at();


-- ── 2. asin_daily_data ───────────────────────────────────────
-- One row per calendar day per child ASIN per brand.
-- Populated from SP-API salesAndTrafficByAsin (one report request per day).

create table if not exists asin_daily_data (
  date                   date          not null,
  asin                   varchar(20)   not null,
  brand                  varchar(50)   not null default 'xpro',

  parent_asin            varchar(20),
  sessions               integer,
  page_views             integer,
  units_ordered          integer,
  ordered_product_sales  numeric(12,2),
  unit_session_pct       numeric(7,4),   -- CVR stored as 0–1 decimal (e.g. 0.0420 = 4.20%)
  buy_box_pct            numeric(7,4),   -- Buy box % stored as 0–1 decimal

  updated_at             timestamptz   not null default now(),

  primary key (date, asin, brand)
);

create or replace trigger asin_daily_data_updated_at
  before update on asin_daily_data
  for each row execute function set_updated_at();


-- ── 3. Row Level Security ────────────────────────────────────
-- Only authenticated (logged-in) users can read or write data.
-- No user-scoping needed — this is a team-internal dashboard.

alter table daily_data      enable row level security;
alter table asin_daily_data enable row level security;

-- daily_data policies
create policy "authenticated users can read daily_data"
  on daily_data for select
  to authenticated
  using (true);

create policy "authenticated users can insert daily_data"
  on daily_data for insert
  to authenticated
  with check (true);

create policy "authenticated users can update daily_data"
  on daily_data for update
  to authenticated
  using (true);

-- asin_daily_data policies
create policy "authenticated users can read asin_daily_data"
  on asin_daily_data for select
  to authenticated
  using (true);

create policy "authenticated users can insert asin_daily_data"
  on asin_daily_data for insert
  to authenticated
  with check (true);

create policy "authenticated users can update asin_daily_data"
  on asin_daily_data for update
  to authenticated
  using (true);


-- ── 4. Useful indexes ────────────────────────────────────────
create index if not exists idx_daily_data_brand_date
  on daily_data (brand, date desc);

create index if not exists idx_asin_daily_brand_date
  on asin_daily_data (brand, date desc);

create index if not exists idx_asin_daily_asin
  on asin_daily_data (asin);


-- ── 5. fba_daily_shipped ─────────────────────────────────────
-- One row per ship_date per MSKU per brand.
-- Populated from the FBA Inventory Ledger (GET_LEDGER_DETAIL_VIEW_DATA), filtered to
-- customer-shipment events only.
--
-- Why this exists separately from asin_daily_data.units_ordered:
-- units_ordered comes from salesAndTrafficByAsin, which counts Amazon-marketplace
-- orders ONLY. Shopify orders fulfilled via Amazon MCF are not Amazon-marketplace
-- orders, so they are missing there — forecasting off units_ordered undercounts demand
-- on SKUs that Shopify draws from FBA. The ledger's customer-shipment events capture
-- Amazon orders AND MCF removals together: the true depletion of the FBA pool.
--
-- Keyed by MSKU (not ASIN): replenishment happens at the SKU level, and the ledger
-- reports by MSKU/FNSKU (one ASIN can map to several MSKUs).

create table if not exists fba_daily_shipped (
  ship_date    date          not null,
  msku         text          not null,
  brand        varchar(50)   not null default 'xpro',
  asin         varchar(20),
  units        integer       not null default 0,
  updated_at   timestamptz   not null default now(),

  primary key (ship_date, msku, brand)
);

create or replace trigger fba_daily_shipped_updated_at
  before update on fba_daily_shipped
  for each row execute function set_updated_at();

alter table fba_daily_shipped enable row level security;

create policy "authenticated users can read fba_daily_shipped"
  on fba_daily_shipped for select
  to authenticated
  using (true);

create policy "authenticated users can insert fba_daily_shipped"
  on fba_daily_shipped for insert
  to authenticated
  with check (true);

create policy "authenticated users can update fba_daily_shipped"
  on fba_daily_shipped for update
  to authenticated
  using (true);

-- The pull script writes with the service_role key (bypasses RLS but still needs table
-- privileges). Grant them explicitly, same lesson as hourly_sales / campaign_daily.
-- DELETE is included so the script can overwrite the trailing reconciliation window.
grant select, insert, update, delete on fba_daily_shipped to service_role;

create index if not exists idx_fba_daily_shipped_brand_date
  on fba_daily_shipped (brand, ship_date desc);

create index if not exists idx_fba_daily_shipped_msku
  on fba_daily_shipped (msku);


-- ── 6. sku_velocity (view) ───────────────────────────────────
-- Rolling units-shipped windows + average daily velocity per MSKU.
-- Drives replenishment forecasting (units/day × lead time = reorder need).
-- Windows use `ship_date > current_date - N` so they always reflect the last N days.

create or replace view sku_velocity as
select
  msku,
  brand,
  max(asin) as asin,
  coalesce(sum(units) filter (where ship_date > current_date - 7),  0) as units_7,
  coalesce(sum(units) filter (where ship_date > current_date - 14), 0) as units_14,
  coalesce(sum(units) filter (where ship_date > current_date - 30), 0) as units_30,
  coalesce(sum(units) filter (where ship_date > current_date - 60), 0) as units_60,
  coalesce(sum(units) filter (where ship_date > current_date - 90), 0) as units_90,
  round(coalesce(sum(units) filter (where ship_date > current_date - 7),  0) / 7.0,  2) as vel_7,
  round(coalesce(sum(units) filter (where ship_date > current_date - 14), 0) / 14.0, 2) as vel_14,
  round(coalesce(sum(units) filter (where ship_date > current_date - 30), 0) / 30.0, 2) as vel_30,
  round(coalesce(sum(units) filter (where ship_date > current_date - 60), 0) / 60.0, 2) as vel_60,
  round(coalesce(sum(units) filter (where ship_date > current_date - 90), 0) / 90.0, 2) as vel_90
from fba_daily_shipped
group by msku, brand;

grant select on sku_velocity to authenticated, service_role;

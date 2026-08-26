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


-- ── 5b. amazon_sku_windows ───────────────────────────────────
-- Amazon-MARKETPLACE units ordered per MSKU, per rolling window (7/14/30/60/90 days
-- ending yesterday). Sourced from the authoritative Detail Page Sales & Traffic report
-- (GET_SALES_AND_TRAFFIC_REPORT, child-ASIN granularity) — the same "units ordered"
-- number you see in Seller Central — mapped ASIN→MSKU via the listings report (1:1).
-- Stored as pre-computed window totals (not daily) so each window report covers its full
-- range regardless of how much daily history exists. Combined with MCF in sku_velocity.

create table if not exists amazon_sku_windows (
  msku       text         not null,
  brand      varchar(50)  not null default 'xpro',
  asin       varchar(20),
  units_7    integer      not null default 0,
  units_14   integer      not null default 0,
  units_30   integer      not null default 0,
  units_60   integer      not null default 0,
  units_90   integer      not null default 0,
  updated_at timestamptz  not null default now(),

  primary key (msku, brand)
);

create or replace trigger amazon_sku_windows_updated_at
  before update on amazon_sku_windows
  for each row execute function set_updated_at();

alter table amazon_sku_windows enable row level security;

create policy "authenticated users can read amazon_sku_windows"
  on amazon_sku_windows for select to authenticated using (true);

create policy "authenticated users can insert amazon_sku_windows"
  on amazon_sku_windows for insert to authenticated with check (true);

create policy "authenticated users can update amazon_sku_windows"
  on amazon_sku_windows for update to authenticated using (true);

grant select, insert, update, delete on amazon_sku_windows to service_role;


-- ── 5c. sku_map (ASIN→canonical MSKU overrides) ──────────────
-- User-maintained corrections for products whose Amazon listing SKU (from the
-- listings report) is a stale/ghost SKU that differs from the canonical MSKU.
-- The daily pull overlays these on the listings map (overrides win), so the
-- Amazon-marketplace windows (amazon_sku_windows) get filed under the right MSKU
-- and merge with the MCF side in sku_velocity.

create table if not exists sku_map (
  asin       varchar(20)  not null,
  brand      varchar(50)  not null default 'xpro',
  msku       text         not null,   -- canonical MSKU this ASIN should map to
  note       text,
  updated_at timestamptz  not null default now(),

  primary key (asin, brand)
);

create or replace trigger sku_map_updated_at
  before update on sku_map
  for each row execute function set_updated_at();

alter table sku_map enable row level security;

create policy "authenticated users can read sku_map"
  on sku_map for select to authenticated using (true);

grant select, insert, update, delete on sku_map to service_role;


-- ── 5d. forecast_settings (global blend + controls) ──────────
-- One row per brand: the velocity-blend weights, reorder policy, horizon,
-- safety-stock method/level/CV, and the global seasonality curve. Persisted
-- server-side (was browser localStorage) so it survives cache clears and is
-- shared across devices. Per-SKU params live in sku_params; this is the
-- brand-wide defaults the Forecast tab's "Save settings" button writes.

create table if not exists forecast_settings (
  brand          varchar(50)  primary key default 'xpro',
  weights        jsonb        not null default '{}'::jsonb,   -- {w7,w14,w30,w60,w90}
  horizon        integer      not null default 180,
  policy         text         not null default 'R_S',
  safety_method  text         not null default 'days',
  service_lvl    text         not null default '95',
  demand_cv      numeric      not null default 0.4,
  seasonality_on boolean      not null default false,
  seasonality    jsonb        not null default '[]'::jsonb,   -- global 12-month curve, [] = flat
  season_strip_deals boolean  not null default true,   -- monthly factors include deal days → de-compound promos
  blackouts      jsonb        not null default '[]'::jsonb,   -- [{start,end,label,kind:factory|receiving}, …]
  updated_at     timestamptz  not null default now()
);

create or replace trigger forecast_settings_updated_at
  before update on forecast_settings
  for each row execute function set_updated_at();

alter table forecast_settings enable row level security;

create policy "authenticated users can read forecast_settings"
  on forecast_settings for select to authenticated using (true);

grant select, insert, update, delete on forecast_settings to service_role;


-- ── 5e. forecast_scenarios (saved what-if runs per SKU) ──────
-- Named scenarios store OVERRIDES only (base velocity, inbounds, promotions;
-- null = inherit live values), so each open re-simulates against current data
-- rather than freezing a stale projection. Rendered as overlay lines on the
-- Forecast tab's SKU chart for side-by-side route comparison.

create table if not exists forecast_scenarios (
  brand         varchar(50)  not null default 'xpro',
  msku          text         not null,
  name          text         not null,
  base_velocity numeric,          -- null = use the live blended velocity
  inbounds      jsonb,           -- null = inherit the SKU's live inbounds
  promotions    jsonb,           -- null = inherit the SKU's live promotions
  notes         text,
  updated_at    timestamptz  not null default now(),

  primary key (brand, msku, name)
);

create or replace trigger forecast_scenarios_updated_at
  before update on forecast_scenarios
  for each row execute function set_updated_at();

alter table forecast_scenarios enable row level security;

create policy "authenticated users can read forecast_scenarios"
  on forecast_scenarios for select to authenticated using (true);

grant select, insert, update, delete on forecast_scenarios to service_role;


-- ── 6. sku_velocity (view) ───────────────────────────────────
-- TOTAL demand per MSKU over 7/14/30/60/90-day windows ending YESTERDAY =
--   Amazon-marketplace units ordered (amazon_sku_windows, pre-computed windows)
--   + MCF/Shopify units (fba_daily_shipped, daily rows windowed here).
-- Full outer join so a SKU selling on either channel still appears.

-- drop first: create-or-replace can't change a view column's data type
drop view if exists sku_velocity;

create view sku_velocity as
with mcf as (
  select
    msku, brand, max(asin)::varchar(20) as asin,
    coalesce(sum(units) filter (where ship_date >= current_date - 7  and ship_date < current_date), 0) as u7,
    coalesce(sum(units) filter (where ship_date >= current_date - 14 and ship_date < current_date), 0) as u14,
    coalesce(sum(units) filter (where ship_date >= current_date - 30 and ship_date < current_date), 0) as u30,
    coalesce(sum(units) filter (where ship_date >= current_date - 60 and ship_date < current_date), 0) as u60,
    coalesce(sum(units) filter (where ship_date >= current_date - 90 and ship_date < current_date), 0) as u90
  from fba_daily_shipped
  group by msku, brand
)
select
  coalesce(m.msku, a.msku)   as msku,
  coalesce(m.brand, a.brand) as brand,
  coalesce(a.asin, m.asin)   as asin,
  coalesce(m.u7, 0)  + coalesce(a.units_7, 0)  as units_7,
  coalesce(m.u14, 0) + coalesce(a.units_14, 0) as units_14,
  coalesce(m.u30, 0) + coalesce(a.units_30, 0) as units_30,
  coalesce(m.u60, 0) + coalesce(a.units_60, 0) as units_60,
  coalesce(m.u90, 0) + coalesce(a.units_90, 0) as units_90,
  round((coalesce(m.u7, 0)  + coalesce(a.units_7, 0))  / 7.0,  2) as vel_7,
  round((coalesce(m.u14, 0) + coalesce(a.units_14, 0)) / 14.0, 2) as vel_14,
  round((coalesce(m.u30, 0) + coalesce(a.units_30, 0)) / 30.0, 2) as vel_30,
  round((coalesce(m.u60, 0) + coalesce(a.units_60, 0)) / 60.0, 2) as vel_60,
  round((coalesce(m.u90, 0) + coalesce(a.units_90, 0)) / 90.0, 2) as vel_90
from mcf m
full outer join amazon_sku_windows a on a.msku = m.msku and a.brand = m.brand;

grant select on sku_velocity to authenticated, service_role;


-- ── 7. shopify_daily_shipped ─────────────────────────────────
-- One row per ship_date per MSKU per brand — units on Shopify ONLINE-STORE orders,
-- which are all fulfilled via Amazon MCF and therefore deplete the same FBA pool as
-- Amazon-marketplace orders. This is the MCF half of FBA depletion, captured directly
-- from Shopify while the FBA Inventory Ledger (GET_LEDGER_DETAIL_VIEW_DATA) is blocked
-- on the Amazon Fulfillment role.
--
-- Notes:
--   • Shopify SKU == Amazon MSKU for this catalog, so it joins straight to Amazon data.
--   • TikTok orders flow into the same Shopify store but ship from a 3PL — the pull
--     EXCLUDES them (by the "Shipped by TikTok" tag), so they don't count as FBA draw.

create table if not exists shopify_daily_shipped (
  ship_date  date         not null,
  msku       text         not null,
  brand      varchar(50)  not null default 'xpro',
  units      integer      not null default 0,
  updated_at timestamptz  not null default now(),

  primary key (ship_date, msku, brand)
);

create or replace trigger shopify_daily_shipped_updated_at
  before update on shopify_daily_shipped
  for each row execute function set_updated_at();

alter table shopify_daily_shipped enable row level security;

create policy "authenticated users can read shopify_daily_shipped"
  on shopify_daily_shipped for select to authenticated using (true);

create policy "authenticated users can insert shopify_daily_shipped"
  on shopify_daily_shipped for insert to authenticated with check (true);

create policy "authenticated users can update shopify_daily_shipped"
  on shopify_daily_shipped for update to authenticated using (true);

grant select, insert, update, delete on shopify_daily_shipped to service_role;

create index if not exists idx_shopify_daily_shipped_brand_date
  on shopify_daily_shipped (brand, ship_date desc);

create index if not exists idx_shopify_daily_shipped_msku
  on shopify_daily_shipped (msku);


-- ── 8. shopify_sku_velocity (view) ───────────────────────────
-- Same shape as sku_velocity (incl. a null asin column) so the dashboard can read
-- either source interchangeably. Rolling 7/14/30/60/90-day units + per-day velocity.

create or replace view shopify_sku_velocity as
select
  msku,
  brand,
  null::varchar(20) as asin,
  coalesce(sum(units) filter (where ship_date >= current_date - 7 and ship_date < current_date),  0) as units_7,
  coalesce(sum(units) filter (where ship_date >= current_date - 14 and ship_date < current_date), 0) as units_14,
  coalesce(sum(units) filter (where ship_date >= current_date - 30 and ship_date < current_date), 0) as units_30,
  coalesce(sum(units) filter (where ship_date >= current_date - 60 and ship_date < current_date), 0) as units_60,
  coalesce(sum(units) filter (where ship_date >= current_date - 90 and ship_date < current_date), 0) as units_90,
  round(coalesce(sum(units) filter (where ship_date >= current_date - 7 and ship_date < current_date),  0) / 7.0,  2) as vel_7,
  round(coalesce(sum(units) filter (where ship_date >= current_date - 14 and ship_date < current_date), 0) / 14.0, 2) as vel_14,
  round(coalesce(sum(units) filter (where ship_date >= current_date - 30 and ship_date < current_date), 0) / 30.0, 2) as vel_30,
  round(coalesce(sum(units) filter (where ship_date >= current_date - 60 and ship_date < current_date), 0) / 60.0, 2) as vel_60,
  round(coalesce(sum(units) filter (where ship_date >= current_date - 90 and ship_date < current_date), 0) / 90.0, 2) as vel_90
from shopify_daily_shipped
group by msku, brand;

grant select on shopify_sku_velocity to authenticated, service_role;


-- ── 9. sku_params ────────────────────────────────────────────
-- Per-SKU inventory inputs for the Forecast tab (lead time, on-hand, MOQ, etc.).
-- The 7/14/30/60/90 velocity is auto-loaded from sku_velocity; these are the
-- planning parameters the user sets. One row per MSKU per brand.

create table if not exists sku_params (
  msku              text         not null,
  brand             varchar(50)  not null default 'xpro',
  on_hand           integer      not null default 0,    -- current FBA on-hand units
  inbound_qty       integer      not null default 0,    -- (legacy) single inbound qty
  inbound_days      integer      not null default 0,    -- (legacy) days until inbound arrives
  inbound_date      date,                                -- (legacy) single inbound arrival date
  inbounds          jsonb        not null default '[]'::jsonb,  -- [{date,qty}, …] multiple shipments
  lead_time_days    integer      not null default 80,   -- reorder lead time (mean)
  lead_time_std_days integer     not null default 0,    -- lead-time variability (± days, σ_L)
  safety_stock_days integer      not null default 15,   -- days of safety stock (days-based method)
  moq               integer      not null default 0,    -- minimum order quantity
  casepack          integer      not null default 1,    -- order rounding multiple
  cycle_cover_days  integer      not null default 35,   -- order-up-to cycle coverage
  seasonality       jsonb        not null default '[]'::jsonb,  -- per-SKU 12-month multipliers, [] = use global
  demand_cv         numeric      not null default 0,    -- per-SKU demand CV override; 0 = use global
  history_days      integer      not null default 0,    -- days actually selling; caps window denominator (0 = full)
  promotions        jsonb        not null default '[]'::jsonb,  -- [{start,end,mult,label}, …] planned deals
  last_forecasted   date,                                -- when this SKU was last forecast/reviewed
  updated_at        timestamptz  not null default now(),

  primary key (msku, brand)
);

create or replace trigger sku_params_updated_at
  before update on sku_params
  for each row execute function set_updated_at();

alter table sku_params enable row level security;

create policy "authenticated users can read sku_params"
  on sku_params for select to authenticated using (true);

create policy "authenticated users can insert sku_params"
  on sku_params for insert to authenticated with check (true);

create policy "authenticated users can update sku_params"
  on sku_params for update to authenticated using (true);

grant select, insert, update, delete on sku_params to service_role;

grant select on shopify_sku_velocity to authenticated, service_role;

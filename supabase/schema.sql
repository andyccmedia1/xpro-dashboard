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

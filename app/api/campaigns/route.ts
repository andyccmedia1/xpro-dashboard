import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse }       from 'next/server'

// GET /api/campaigns?days=30&brand=xpro
//
// Returns per-campaign aggregates over the last `days` days. Raw metrics only —
// ACOS/bucket/recommended-budget classification happens client-side so the
// target-ACOS slider is instant (no refetch). Uses the admin client to bypass
// RLS (consistent with the other internal API routes).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const brand = searchParams.get('brand') ?? 'xpro'
  const days  = Math.min(parseInt(searchParams.get('days') ?? '30'), 365)

  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceStr = since.toISOString().slice(0, 10)

  const supabase = createAdminClient()

  // Page through results — campaign_daily can exceed PostgREST's 1000-row cap
  const pageSize = 1000
  let from = 0
  const all: Row[] = []
  while (true) {
    const { data, error } = await supabase
      .from('campaign_daily')
      .select('campaign_id, campaign_name, ad_product, budget, impressions, clicks, cost, orders, sales, date')
      .eq('brand', brand)
      .gte('date', sinceStr)
      .order('date', { ascending: true })
      .range(from, from + pageSize - 1)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const batch = (data ?? []) as Row[]
    all.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }

  // Aggregate per campaign
  const map = new Map<string, Agg>()
  for (const r of all) {
    let a = map.get(r.campaign_id)
    if (!a) {
      a = {
        campaign_id:   r.campaign_id,
        campaign_name: r.campaign_name ?? r.campaign_id,
        ad_product:    r.ad_product,
        impressions: 0, clicks: 0, cost: 0, orders: 0, sales: 0,
        active_days: 0, capped_days: 0,
        current_budget: null, _last_budget_date: null,
      }
      map.set(r.campaign_id, a)
    }

    const dayCost = num(r.cost)
    const budget  = r.budget != null ? num(r.budget) : null

    a.impressions += int(r.impressions)
    a.clicks      += int(r.clicks)
    a.cost        += dayCost
    a.orders      += int(r.orders)
    a.sales       += num(r.sales)

    if (dayCost > 0) a.active_days += 1
    // "Capped" day: spent ≥ 92% of that day's budget
    if (budget != null && budget > 0 && dayCost >= budget * 0.92) a.capped_days += 1
    // Latest known budget (rows are date-ascending)
    if (budget != null && (a._last_budget_date == null || r.date >= a._last_budget_date)) {
      a.current_budget    = budget
      a._last_budget_date = r.date
    }
    if (r.campaign_name) a.campaign_name = r.campaign_name
  }

  const campaigns = [...map.values()].map(({ _last_budget_date, ...rest }) => ({
    ...rest,
    cost:  Math.round(rest.cost  * 100) / 100,
    sales: Math.round(rest.sales * 100) / 100,
  }))

  return NextResponse.json({ campaigns, days })
}

// ── Types & helpers ──────────────────────────────────────────────────────────
type Row = {
  campaign_id: string
  campaign_name: string | null
  ad_product: string
  budget: number | string | null
  impressions: number | null
  clicks: number | null
  cost: number | string | null
  orders: number | null
  sales: number | string | null
  date: string
}

type Agg = {
  campaign_id: string
  campaign_name: string
  ad_product: string
  impressions: number
  clicks: number
  cost: number
  orders: number
  sales: number
  active_days: number
  capped_days: number
  current_budget: number | null
  _last_budget_date: string | null
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0)
  return Number.isFinite(n) ? n : 0
}
function int(v: number | null | undefined): number {
  return Number.isFinite(v as number) ? (v as number) : 0
}

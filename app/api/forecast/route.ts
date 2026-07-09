import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse }       from 'next/server'

// Default planning params when a SKU has no sku_params row yet.
const DEFAULTS = {
  on_hand: 0,
  lead_time_days: 80, lead_time_std_days: 0, safety_stock_days: 15,
  moq: 0, casepack: 1, cycle_cover_days: 35,
}

const num = (v: unknown) => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number)
  return Number.isFinite(n) ? n : 0
}

// GET /api/forecast?brand=xpro
// Returns each SKU's velocity (from sku_velocity, falling back to shopify_sku_velocity)
// merged with its planning params (sku_params, with defaults).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const brand = searchParams.get('brand') ?? 'xpro'
  const supabase = createAdminClient()

  const velCols = 'msku, asin, units_7, units_14, units_30, units_60, units_90, vel_7, vel_14, vel_30, vel_60, vel_90'
  let source: 'ledger' | 'shopify' = 'ledger'
  let { data: vel, error } = await supabase.from('sku_velocity').select(velCols).eq('brand', brand)
  if (!error && (!vel || vel.length === 0)) {
    source = 'shopify'
    ;({ data: vel, error } = await supabase.from('shopify_sku_velocity').select(velCols).eq('brand', brand))
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: params } = await supabase
    .from('sku_params')
    .select('msku, on_hand, inbounds, lead_time_days, lead_time_std_days, safety_stock_days, moq, casepack, cycle_cover_days, seasonality, demand_cv, history_days, promotions, last_forecasted')
    .eq('brand', brand)

  const paramMap = new Map<string, Record<string, unknown>>()
  for (const p of (params ?? []) as Record<string, unknown>[]) paramMap.set(p.msku as string, p)

  const skus = ((vel ?? []) as Record<string, unknown>[]).map((r) => {
    const p = paramMap.get(r.msku as string) ?? {}
    return {
      msku:  r.msku as string,
      asin:  (r.asin as string | null) ?? null,
      v7: num(r.vel_7), v14: num(r.vel_14), v30: num(r.vel_30), v60: num(r.vel_60), v90: num(r.vel_90),
      units_7: num(r.units_7), units_14: num(r.units_14), units_30: num(r.units_30), units_60: num(r.units_60), units_90: num(r.units_90),
      on_hand:            num(p.on_hand ?? DEFAULTS.on_hand),
      inbounds:           Array.isArray(p.inbounds) ? p.inbounds : [],
      lead_time_days:     num(p.lead_time_days ?? DEFAULTS.lead_time_days),
      lead_time_std_days: num(p.lead_time_std_days ?? DEFAULTS.lead_time_std_days),
      safety_stock_days:  num(p.safety_stock_days ?? DEFAULTS.safety_stock_days),
      moq:               num(p.moq ?? DEFAULTS.moq),
      casepack:          num(p.casepack ?? DEFAULTS.casepack),
      cycle_cover_days:  num(p.cycle_cover_days ?? DEFAULTS.cycle_cover_days),
      seasonality:       Array.isArray(p.seasonality) && p.seasonality.length === 12 ? p.seasonality.map(num) : [],
      demand_cv:         num(p.demand_cv),
      history_days:      num(p.history_days),
      promotions:        Array.isArray(p.promotions) ? p.promotions : [],
      last_forecasted:   (p.last_forecasted as string | null) ?? null,
      has_params:        paramMap.has(r.msku as string),
    }
  }).sort((a, b) => b.v30 - a.v30)

  return NextResponse.json({ skus, source })
}

// POST /api/forecast  — upsert one SKU's planning params.
// body: { brand?, msku, on_hand, inbound_qty, inbound_days, lead_time_days, safety_stock_days, moq, casepack, cycle_cover_days }
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body?.msku) return NextResponse.json({ error: 'msku is required' }, { status: 400 })

  // Sanitise the inbound shipments list: [{date:'YYYY-MM-DD', qty:int}, …]
  const inbounds = Array.isArray(body.inbounds)
    ? body.inbounds
        .map((s: { date?: unknown; qty?: unknown }) => ({
          date: s.date ? String(s.date) : '',
          qty:  Math.round(num(s.qty)),
        }))
        .filter((s: { date: string; qty: number }) => s.date && s.qty > 0)
    : []

  // Per-SKU seasonality override: exactly 12 non-negative multipliers, else [] (use global).
  const seasonality = Array.isArray(body.seasonality) && body.seasonality.length === 12
    ? body.seasonality.map((v: unknown) => Math.max(0, num(v)))
    : []

  // Deals/promos: [{start:'YYYY-MM-DD', end:'YYYY-MM-DD', mult:number, label:string}, …]
  const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  const promotions = Array.isArray(body.promotions)
    ? body.promotions
        .map((pr: { start?: unknown; end?: unknown; mult?: unknown; label?: unknown }) => ({
          start: isDate(pr.start) ? pr.start : '',
          end:   isDate(pr.end)   ? pr.end   : '',
          mult:  Math.max(0, num(pr.mult)),
          label: pr.label ? String(pr.label).slice(0, 80) : '',
        }))
        .filter((pr: { start: string; end: string; mult: number }) => pr.start && pr.end && pr.mult > 0)
    : []

  // last_forecasted: a 'YYYY-MM-DD' string, or null to clear
  const lastForecasted = typeof body.last_forecasted === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.last_forecasted)
    ? body.last_forecasted
    : null

  const row = {
    brand:             body.brand ?? 'xpro',
    msku:              String(body.msku),
    on_hand:            Math.round(num(body.on_hand)),
    inbounds,
    seasonality,
    demand_cv:          Math.max(0, num(body.demand_cv)),
    history_days:       Math.max(0, Math.round(num(body.history_days))),
    promotions,
    last_forecasted:    lastForecasted,
    lead_time_days:     Math.round(num(body.lead_time_days ?? DEFAULTS.lead_time_days)),
    lead_time_std_days: Math.round(num(body.lead_time_std_days ?? DEFAULTS.lead_time_std_days)),
    safety_stock_days:  Math.round(num(body.safety_stock_days ?? DEFAULTS.safety_stock_days)),
    moq:               Math.round(num(body.moq)),
    casepack:          Math.max(1, Math.round(num(body.casepack ?? 1))),
    cycle_cover_days:  Math.round(num(body.cycle_cover_days ?? DEFAULTS.cycle_cover_days)),
  }

  const supabase = createAdminClient()
  const { error } = await supabase.from('sku_params').upsert(row, { onConflict: 'msku,brand' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

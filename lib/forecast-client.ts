// ── Shared client-side forecast logic ────────────────────────────────────────
// Types + the computeFor pipeline used by BOTH the Forecast tab and the
// Scenario Planner tab, so the two always simulate with identical math.

import { weightedVelocity, runForecast, analyzeForecast, type PeriodWeights } from '@/lib/forecast'

export type Inbound = { date: string; qty: number }
// A deal/promo window: demand is multiplied by `mult` from start to end (inclusive)
export type Promo = { start: string; end: string; mult: number; label: string }
// A calendar constraint: factory closed (no PO placement) or FBA receiving closed
export type Blackout = { start: string; end: string; label: string; kind: 'factory' | 'receiving' }
// A saved what-if scenario: overrides only, null = inherit the live value
export type Scenario = { msku: string; name: string; base_velocity: number | null; inbounds: Inbound[] | null; promotions: Promo[] | null; notes: string | null; updated_at?: string }

export type Sku = {
  msku: string
  asin: string | null
  v7: number; v14: number; v30: number; v60: number; v90: number
  units_7: number; units_14: number; units_30: number; units_60: number; units_90: number
  on_hand: number; inbounds: Inbound[]
  lead_time_days: number; lead_time_std_days: number; safety_stock_days: number
  moq: number; casepack: number; cycle_cover_days: number
  seasonality: number[]   // per-SKU override: 12 monthly multipliers, or [] = use global
  demand_cv: number       // per-SKU demand CV override; 0 = use global
  history_days: number    // days the SKU has actually been selling; 0 = use full window
  promotions: Promo[]     // planned deals/promos (demand multiplier over a date range)
  last_forecasted: string | null   // 'YYYY-MM-DD' — when this SKU was last forecast/reviewed
  has_params: boolean
}

export type Policy = 'R_S' | 's_Q' | 'EOQ'
export type SafetyMethod = 'days' | 'service'
export type Safety = { method: SafetyMethod; z: number; cv: number }
// 12 monthly multipliers (Jan..Dec). on=false → flat demand.
// strip: monthly factors were measured from actuals that already contain deal
// days, so promo months are rescaled to avoid double-counting the deal lift.
export type Seasonality = { on: boolean; factors: number[]; strip: boolean }

// Service-level → z-score
export const Z: Record<string, number> = { '90': 1.28, '95': 1.65, '97': 1.88, '99': 2.33 }

// Overlay colors for scenario lines (fixed order — orange, teal, violet)
export const SCEN_COLORS = ['#f97316', '#14b8a6', '#a855f7']

export const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—')
export const n2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—')

// A SKU looks recently-stocked (long windows diluted) when its 90-day units total
// equals a shorter window's — i.e. no sales that far back. history_days corrects it.
export const isDiluted = (s: Sku) =>
  s.history_days === 0 && s.units_90 > 0 && (s.units_90 === s.units_30 || s.units_90 === s.units_60)

export const DAY_MS = 86_400_000
/** Whole days from the forecast anchor to an inbound date (null/past → null). */
export function inboundDayOffset(inboundDate: string | null, anchor: Date): number | null {
  if (!inboundDate) return null
  const d = new Date(inboundDate + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  const offset = Math.round((d.getTime() - anchor.getTime()) / DAY_MS)
  return offset >= 0 ? offset : null
}

// Build the engine's month→multiplier map, normalised so the CURRENT month = 1.0.
// baseVelocity already reflects the current month's run-rate (trailing windows),
// so anchoring the current month to 1.0 keeps day-0 demand equal to baseVelocity
// and scales every other month relative to it.
export function seasonalityMap(season: Seasonality, today: Date): Record<number, number> | undefined {
  if (!season.on) return undefined
  const cur = today.getMonth()                  // 0-11
  const anchor = season.factors[cur] || 1
  const map: Record<number, number> = {}
  for (let m = 0; m < 12; m++) map[m + 1] = (season.factors[m] || 0) / (anchor || 1)
  return map
}

export function computeFor(sku: Sku, weights: PeriodWeights, horizon: number, policy: Policy, today: Date, safety: Safety, season: Seasonality, blackouts: Blackout[], baseOverride?: number) {
  // History correction: for a recently-stocked SKU, windows longer than its
  // selling history are diluted by pre-stock zero-demand days. Divide by the
  // actual days selling instead of the full window so the rate isn't dragged
  // down (units_N / min(N, history_days)). history_days = 0 → no correction.
  const hd = sku.history_days
  const ev = (unitsN: number, vN: number, N: number) => (hd > 0 && hd < N ? unitsN / hd : vN)
  // baseOverride: what-if scenarios pin the base rate instead of deriving it
  const base = baseOverride ?? weightedVelocity({
    v7:  ev(sku.units_7,  sku.v7,  7),
    v14: ev(sku.units_14, sku.v14, 14),
    v30: ev(sku.units_30, sku.v30, 30),
    v60: ev(sku.units_60, sku.v60, 60),
    v90: ev(sku.units_90, sku.v90, 90),
  }, weights)
  const deliveries = (sku.inbounds ?? [])
    .map(s => ({ day: inboundDayOffset(s.date, today), qty: s.qty }))
    .filter((d): d is { day: number; qty: number } => d.day != null && d.qty > 0)
  const useService = safety.method === 'service'
  const cv = sku.demand_cv > 0 ? sku.demand_cv : safety.cv   // per-SKU override else global
  const sigmaD = cv * base          // daily demand std as a fraction of velocity
  // Per-SKU curve overrides the global one; global toggle still gates whether any applies.
  const effFactors = sku.seasonality?.length === 12 ? sku.seasonality : season.factors
  const seasonalityFactors = seasonalityMap({ on: season.on, factors: effFactors, strip: season.strip }, today)
  // Deals/promos → day-index demand multipliers (applied regardless of the seasonality toggle)
  const dayOffset = (ds: string) => {
    const d = new Date(ds + 'T00:00:00')
    return isNaN(d.getTime()) ? null : Math.round((d.getTime() - today.getTime()) / DAY_MS)
  }
  const dayMultipliers: Record<number, number> = {}
  const promoWindows: { promo: Promo; startDay: number; endDay: number }[] = []
  for (const pr of sku.promotions ?? []) {
    if (!pr.start || !pr.end || !(pr.mult > 0)) continue
    const s = dayOffset(pr.start), e = dayOffset(pr.end)
    if (s == null || e == null || e < 0 || s > e) continue
    const cs = Math.max(0, s), ce = Math.min(horizon - 1, e)
    if (cs > ce) continue
    for (let d = cs; d <= ce; d++) dayMultipliers[d] = (dayMultipliers[d] ?? 1) * pr.mult
    promoWindows.push({ promo: pr, startDay: cs, endDay: ce })
  }

  // De-compound deals from monthly seasonality. If the monthly curve was
  // measured from historical actuals, deal days are already baked into the
  // month's average (Nov 1.15 contains BFCM), so month × promo double-counts.
  // Rescale each promo month by c = N / (N − d + Σmult) so the month's AVERAGE
  // stays at the entered factor while the lift concentrates in the deal window:
  // Nov 1.15 + 5d×1.75 → normal days 1.02×, deal days 1.79× (avg still 1.15).
  if (season.on && season.strip && promoWindows.length > 0) {
    const monthKey     = (i: number) => { const d = new Date(today.getTime() + i * DAY_MS); return d.getFullYear() * 12 + d.getMonth() }
    const promoMultSum = new Map<number, number>()   // monthKey -> Σ mult over deal days
    const promoDayCnt  = new Map<number, number>()   // monthKey -> # deal days
    for (const [ds, m] of Object.entries(dayMultipliers)) {
      const k = monthKey(Number(ds))
      promoMultSum.set(k, (promoMultSum.get(k) ?? 0) + m)
      promoDayCnt.set(k, (promoDayCnt.get(k) ?? 0) + 1)
    }
    const corr = new Map<number, number>()
    for (const [k, sumL] of promoMultSum) {
      const N = new Date(Math.floor(k / 12), (k % 12) + 1, 0).getDate()   // days in that month
      const d = promoDayCnt.get(k) ?? 0
      corr.set(k, N / (N - d + sumL))
    }
    for (let i = 0; i < horizon; i++) {
      const c = corr.get(monthKey(i))
      if (c) dayMultipliers[i] = (dayMultipliers[i] ?? 1) * c
    }
  }
  // Blackout windows → day-index ranges within the horizon
  const blackoutBands = (blackouts ?? [])
    .map(b => {
      const s = dayOffset(b.start), e = dayOffset(b.end)
      if (s == null || e == null || e < 0 || s > e) return null
      const cs = Math.max(0, s), ce = Math.min(horizon - 1, e)
      return cs <= ce ? { label: b.label, kind: b.kind, startDay: cs, endDay: ce } : null
    })
    .filter((b): b is { label: string; kind: 'factory' | 'receiving'; startDay: number; endDay: number } => b != null)
  const orderBlackouts   = blackoutBands.filter(b => b.kind === 'factory')
    .map(b => ({ start: b.startDay, end: b.endDay, label: b.label }))
  const arrivalBlackouts = blackoutBands.filter(b => b.kind === 'receiving')
    .map(b => ({ start: b.startDay, end: b.endDay, label: b.label }))

  const rows = runForecast({
    initialInventory: sku.on_hand,
    baseVelocity: base,
    startDate: today,
    days: horizon,
    deliveries,
    orderBlackouts,
    arrivalBlackouts,
    leadTime: sku.lead_time_days,
    safetyStockDays: sku.safety_stock_days,
    cycleCoverDays: sku.cycle_cover_days,
    moq: sku.moq,
    casepack: sku.casepack,
    reorderPolicy: policy,
    dynamicReorder: true,
    useServiceLevelSafety: useService,
    serviceLevelZ: safety.z,
    demandStdDev: sigmaD,
    leadTimeStdDays: sku.lead_time_std_days,
    useSeasonality: season.on,
    seasonalityFactors,
    dayMultipliers,
  })
  const analytics = analyzeForecast(rows)
  const daysOfCover = base > 0 ? sku.on_hand / base : Infinity
  // Safety stock figure for display (mirrors the engine)
  const safetyStock = useService
    ? safety.z * Math.sqrt(sigmaD * sigmaD * sku.lead_time_days + base * base * sku.lead_time_std_days * sku.lead_time_std_days)
    : base * sku.safety_stock_days

  // Per-promo projection: units the deal moves, lost sales, and end-of-deal stock
  const promoStats = promoWindows.map(w => {
    const slice = rows.slice(w.startDay, w.endDay + 1)
    const units    = slice.reduce((s, r) => s + (r.velocity - r.lostSales), 0)
    const lost     = slice.reduce((s, r) => s + r.lostSales, 0)
    const endInv   = slice[slice.length - 1]?.inventory ?? 0
    const stockout = slice.some(r => r.inventory <= 0)
    return { ...w, units, lost, endInv, stockout }
  })

  // Ad signal: throttle when the sim projects a stockout even with reorders;
  // push when sitting on more cover than a full lead time + order cycle needs.
  const adSignal: 'throttle' | 'steady' | 'push' =
    analytics.firstStockoutDay != null ? 'throttle'
    : base > 0 && sku.on_hand > 0 && daysOfCover > sku.lead_time_days + sku.cycle_cover_days ? 'push'
    : 'steady'

  // Days where blackouts changed the plan (PO pulled earlier / blocked / arrival slipped)
  const blackoutNotes = rows.filter(r => r.reorderNote).map(r => ({ date: r.date, note: r.reorderNote }))

  return { base, rows, analytics, daysOfCover, safetyStock, cv, promoStats, adSignal, blackoutBands, blackoutNotes }
}

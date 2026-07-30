import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse }       from 'next/server'

// GET /api/forecast/cv?msku=...&brand=xpro&days=90
// Computes the coefficient of variation (σ_d ÷ mean) of TOTAL daily demand for a
// SKU — Amazon marketplace (asin_daily_data.units_ordered) + MCF
// (fba_daily_shipped.units), summed per day over a trailing window ending
// yesterday. Only days actually observed in at least one source are counted, so
// data-collection gaps don't masquerade as zero-demand days.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const msku  = searchParams.get('msku')
  const brand = searchParams.get('brand') ?? 'xpro'
  const days  = Math.min(180, Math.max(14, parseInt(searchParams.get('days') ?? '90') || 90))
  if (!msku) return NextResponse.json({ error: 'msku is required' }, { status: 400 })

  const supabase = createAdminClient()

  // Window: [today - days, today) — excludes today (partial).
  const today = new Date()
  const startISO = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  const todayISO = today.toISOString().slice(0, 10)

  // Resolve the SKU's ASIN from the velocity view.
  const { data: velRow } = await supabase
    .from('sku_velocity').select('asin').eq('brand', brand).eq('msku', msku).maybeSingle()
  const asin = (velRow?.asin as string | null) ?? null

  // Per-day demand map: date -> units. Sum Amazon + MCF.
  const daily = new Map<string, number>()

  // MCF (always keyed by msku)
  const { data: mcf } = await supabase
    .from('fba_daily_shipped').select('ship_date, units')
    .eq('brand', brand).eq('msku', msku).gte('ship_date', startISO).lt('ship_date', todayISO)
  for (const r of (mcf ?? []) as { ship_date: string; units: number | null }[]) {
    daily.set(r.ship_date, (daily.get(r.ship_date) ?? 0) + (Number(r.units) || 0))
  }

  // Amazon marketplace (keyed by ASIN)
  if (asin) {
    const { data: amz } = await supabase
      .from('asin_daily_data').select('date, units_ordered')
      .eq('brand', brand).eq('asin', asin).gte('date', startISO).lt('date', todayISO)
    for (const r of (amz ?? []) as { date: string; units_ordered: number | null }[]) {
      daily.set(r.date, (daily.get(r.date) ?? 0) + (Number(r.units_ordered) || 0))
    }
  }

  if (daily.size < 7) {
    return NextResponse.json({ error: 'not enough daily history', days: daily.size }, { status: 422 })
  }

  // Selling history span: first day with a sale → yesterday.
  const saleDates   = Array.from(daily.entries()).filter(([, u]) => u > 0).map(([d]) => d).sort()
  const firstSale   = saleDates[0] ?? null
  const sellingDays = saleDates.length
  const historyDays = firstSale
    ? Math.round((Date.parse(todayISO) - Date.parse(firstSale)) / 86_400_000)
    : null

  // Build a CONTINUOUS daily series from first sale → yesterday, filling missing
  // dates as 0 (the S&T report omits zero-activity days, so absent = no sales).
  const series: number[] = []
  if (firstSale) {
    for (let t = Date.parse(firstSale); t < Date.parse(todayISO); t += 86_400_000) {
      series.push(daily.get(new Date(t).toISOString().slice(0, 10)) ?? 0)
    }
  }

  // Suspected-stockout exclusion. We have no daily inventory history (the
  // ledger report is blocked), so use a statistical proxy: for a SKU whose
  // selling-day mean is >= 3/day, a run of >= 3 consecutive zero days is
  // overwhelmingly out-of-stock, not demand (Poisson P(0)^3 is negligible).
  // Drop those runs from BOTH the mean/σ and the selling-days denominator;
  // keep isolated zeros — those are genuine zero-demand observations. Slow
  // movers skip the heuristic (natural zero runs are expected for them).
  const meanSelling = sellingDays > 0
    ? saleDates.reduce((s, d) => s + (daily.get(d) ?? 0), 0) / sellingDays
    : 0
  const OOS_RUN = 3
  let oosDays = 0
  let kept: number[] = series
  if (meanSelling >= 3) {
    kept = []
    let i = 0
    while (i < series.length) {
      if (series[i] === 0) {
        let j = i
        while (j < series.length && series[j] === 0) j++
        if (j - i >= OOS_RUN) oosDays += j - i          // suspected OOS run → drop
        else for (let k = i; k < j; k++) kept.push(0)    // isolated zeros → real demand
        i = j
      } else {
        kept.push(series[i]); i++
      }
    }
  }

  const stats = (xs: number[]) => {
    const n = xs.length
    if (n < 2) return { mean: 0, std: 0, cv: 0 }
    const mean = xs.reduce((s, v) => s + v, 0) / n
    const std  = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1))
    return { mean, std, cv: mean > 0 ? std / mean : 0 }
  }
  const filtered = stats(kept)
  const raw      = stats(series)
  const round2 = (v: number) => Math.round(Math.min(3, Math.max(0, v)) * 100) / 100

  return NextResponse.json({
    cv:     round2(filtered.cv),
    days:   kept.length,
    mean:   Math.round(filtered.mean * 10) / 10,
    std:    Math.round(filtered.std * 10) / 10,
    cv_raw:   round2(raw.cv),          // what the naive calc would say
    mean_raw: Math.round(raw.mean * 10) / 10,
    oos_days: oosDays,                 // zero-run days excluded as suspected stockouts
    hasAmazon: !!asin,
    first_sale:   firstSale,
    history_days: historyDays,                                        // first sale → yesterday (gross)
    history_days_net: historyDays != null ? historyDays - oosDays : null,  // minus suspected OOS
    selling_days: sellingDays,
  })
}

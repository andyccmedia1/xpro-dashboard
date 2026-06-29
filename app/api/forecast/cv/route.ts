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

  const series = Array.from(daily.values())
  const n = series.length
  if (n < 7) {
    return NextResponse.json({ error: 'not enough daily history', days: n }, { status: 422 })
  }

  const mean = series.reduce((s, v) => s + v, 0) / n
  // Sample standard deviation (n-1).
  const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
  const std = Math.sqrt(variance)
  const cvRaw = mean > 0 ? std / mean : 0
  const cv = Math.round(Math.min(3, Math.max(0, cvRaw)) * 100) / 100

  return NextResponse.json({
    cv,
    days: n,
    mean: Math.round(mean * 10) / 10,
    std:  Math.round(std * 10) / 10,
    hasAmazon: !!asin,
  })
}

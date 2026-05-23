/**
 * GET /api/skus?start=YYYY-MM-DD&end=YYYY-MM-DD&brand=xpro
 *
 * Returns per-ASIN aggregated metrics + daily series for sparklines.
 */
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const start = searchParams.get('start')
  const end   = searchParams.get('end')
  const brand = searchParams.get('brand') ?? 'xpro'

  if (!start || !end) {
    return NextResponse.json({ error: 'start and end are required' }, { status: 400 })
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('asin_daily_data')
    .select('date, asin, parent_asin, sessions, page_views, units_ordered, ordered_product_sales, unit_session_pct, buy_box_pct')
    .eq('brand', brand)
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true })

  if (error) {
    console.error('[/api/skus]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Group rows by ASIN
  const asinMap = new Map<string, {
    asin: string
    parent_asin: string | null
    sessions: number
    page_views: number
    units_ordered: number
    ordered_product_sales: number
    cvr_sum: number
    cvr_count: number
    buy_box_sum: number
    buy_box_count: number
    daily: Array<{
      date: string
      sessions: number
      units_ordered: number
      ordered_product_sales: number
      unit_session_pct: number | null
      buy_box_pct: number | null
    }>
  }>()

  for (const row of data ?? []) {
    if (!asinMap.has(row.asin)) {
      asinMap.set(row.asin, {
        asin: row.asin,
        parent_asin: row.parent_asin,
        sessions: 0, page_views: 0, units_ordered: 0, ordered_product_sales: 0,
        cvr_sum: 0, cvr_count: 0, buy_box_sum: 0, buy_box_count: 0,
        daily: [],
      })
    }
    const entry = asinMap.get(row.asin)!
    const sess  = Number(row.sessions              ?? 0)
    const pv    = Number(row.page_views            ?? 0)
    const units = Number(row.units_ordered         ?? 0)
    const sales = Number(row.ordered_product_sales ?? 0)
    const cvr   = row.unit_session_pct != null ? Number(row.unit_session_pct) : null
    const bb    = row.buy_box_pct      != null ? Number(row.buy_box_pct)      : null

    entry.sessions              += sess
    entry.page_views            += pv
    entry.units_ordered         += units
    entry.ordered_product_sales += sales
    if (cvr != null) { entry.cvr_sum     += cvr; entry.cvr_count++     }
    if (bb  != null) { entry.buy_box_sum += bb;  entry.buy_box_count++ }

    entry.daily.push({
      date: row.date,
      sessions: sess, units_ordered: units,
      ordered_product_sales: sales,
      unit_session_pct: cvr,
      buy_box_pct: bb,
    })
  }

  // Build output array sorted by revenue desc
  const skus = Array.from(asinMap.values())
    .map((e) => ({
      asin:                  e.asin,
      parent_asin:           e.parent_asin,
      sessions:              e.sessions,
      page_views:            e.page_views,
      units_ordered:         e.units_ordered,
      ordered_product_sales: e.ordered_product_sales,
      avg_cvr:               e.cvr_count     > 0 ? e.cvr_sum     / e.cvr_count     : null,
      avg_buy_box_pct:       e.buy_box_count > 0 ? e.buy_box_sum / e.buy_box_count : null,
      daily: e.daily,
    }))
    .sort((a, b) => b.ordered_product_sales - a.ordered_product_sales)

  // Summary totals
  const summary = {
    total_sessions: skus.reduce((s, r) => s + r.sessions, 0),
    total_units:    skus.reduce((s, r) => s + r.units_ordered, 0),
    total_revenue:  skus.reduce((s, r) => s + r.ordered_product_sales, 0),
    avg_cvr:        skus.filter(r => r.avg_cvr != null).reduce((s, r, _, a) => s + r.avg_cvr! / a.length, 0) || null,
    sku_count:      skus.length,
  }

  return NextResponse.json({ summary, skus })
}

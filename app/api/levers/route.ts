/**
 * GET /api/levers?start=YYYY-MM-DD&end=YYYY-MM-DD&brand=xpro
 *
 * Returns daily series + period averages for the Lever Analysis tab.
 * Levers = the ad spend inputs that drive revenue outcomes.
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
    .from('daily_data')
    .select('date, amazon_revenue, amazon_ppc_spend, tiktok_ads_spend, meta_ads_spend, shopify_revenue, tiktok_shop_revenue')
    .eq('brand', brand)
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true })

  if (error) {
    console.error('[/api/levers]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // ── Build daily series with derived metrics ───────────────────────────────
  let sumRev = 0, sumSpend = 0, sumAmzRev = 0, sumAmzSpend = 0
  let roasCount = 0, tacosCount = 0, roasSum = 0, tacosSum = 0

  const series = (data ?? []).map((row) => {
    const amzRev   = Number(row.amazon_revenue      ?? 0)
    const amzSpend = Number(row.amazon_ppc_spend    ?? 0)
    const ttkSpend = Number(row.tiktok_ads_spend    ?? 0)
    const metSpend = Number(row.meta_ads_spend      ?? 0)
    const shopRev  = Number(row.shopify_revenue     ?? 0)
    const ttkRev   = Number(row.tiktok_shop_revenue ?? 0)

    const totalRev   = amzRev + shopRev + ttkRev
    const totalSpend = amzSpend + ttkSpend + metSpend

    const roas  = totalSpend  > 0 ? totalRev   / totalSpend  : null
    const tacos = amzRev      > 0 ? amzSpend   / amzRev      : null
    const amzRoas = amzSpend  > 0 ? amzRev     / amzSpend    : null

    sumRev     += totalRev
    sumSpend   += totalSpend
    sumAmzRev  += amzRev
    sumAmzSpend+= amzSpend

    if (roas  !== null) { roasSum  += roas;  roasCount++ }
    if (tacos !== null) { tacosSum += tacos; tacosCount++ }

    return {
      date: row.date,
      amazon_revenue:   amzRev,
      amazon_ppc_spend: amzSpend,
      tiktok_ads_spend: ttkSpend,
      meta_ads_spend:   metSpend,
      shopify_revenue:  shopRev,
      tiktok_revenue:   ttkRev,
      total_revenue:    totalRev,
      total_spend:      totalSpend,
      roas:             roas  !== null ? Math.round(roas  * 100) / 100 : null,
      tacos:            tacos !== null ? Math.round(tacos * 10000) / 10000 : null,
      amz_roas:         amzRoas !== null ? Math.round(amzRoas * 100) / 100 : null,
    }
  })

  const totals = {
    total_revenue:      sumRev,
    total_spend:        sumSpend,
    amazon_revenue:     sumAmzRev,
    amazon_ppc_spend:   sumAmzSpend,
    avg_roas:           roasCount  > 0 ? roasSum  / roasCount  : null,
    avg_tacos:          tacosCount > 0 ? tacosSum / tacosCount : null,
    period_roas:        sumSpend   > 0 ? sumRev   / sumSpend   : null,
    period_tacos:       sumAmzRev  > 0 ? sumAmzSpend / sumAmzRev : null,
  }

  return NextResponse.json({ series, totals })
}

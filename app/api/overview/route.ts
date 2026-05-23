/**
 * GET /api/overview?start=YYYY-MM-DD&end=YYYY-MM-DD&brand=xpro
 *
 * Returns:
 *  - kpis:   aggregated totals for the period
 *  - series: daily rows for the chart
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
    .select(`
      date,
      amazon_revenue,
      shopify_revenue,
      tiktok_shop_revenue,
      amazon_ppc_spend,
      tiktok_ads_spend,
      meta_ads_spend,
      annotation
    `)
    .eq('brand', brand)
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true })

  if (error) {
    console.error('[/api/overview]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // ── Aggregate KPIs ──────────────────────────────────────────
  let totalAmazonRev     = 0
  let totalShopifyRev    = 0
  let totalTiktokRev     = 0
  let totalAmazonSpend   = 0
  let totalTiktokSpend   = 0
  let totalMetaSpend     = 0

  const series = (data ?? []).map((row) => {
    const amzRev   = Number(row.amazon_revenue      ?? 0)
    const shopRev  = Number(row.shopify_revenue     ?? 0)
    const ttkRev   = Number(row.tiktok_shop_revenue ?? 0)
    const amzSpend = Number(row.amazon_ppc_spend    ?? 0)
    const ttkSpend = Number(row.tiktok_ads_spend    ?? 0)
    const metSpend = Number(row.meta_ads_spend      ?? 0)

    totalAmazonRev   += amzRev
    totalShopifyRev  += shopRev
    totalTiktokRev   += ttkRev
    totalAmazonSpend += amzSpend
    totalTiktokSpend += ttkSpend
    totalMetaSpend   += metSpend

    return {
      date:          row.date,
      amazon_revenue:       amzRev,
      shopify_revenue:      shopRev,
      tiktok_shop_revenue:  ttkRev,
      amazon_ppc_spend:     amzSpend,
      tiktok_ads_spend:     ttkSpend,
      meta_ads_spend:       metSpend,
      total_revenue: amzRev + shopRev + ttkRev,
      total_spend:   amzSpend + ttkSpend + metSpend,
      annotation:    row.annotation ?? null,
    }
  })

  const totalRevenue = totalAmazonRev + totalShopifyRev + totalTiktokRev
  const totalSpend   = totalAmazonSpend + totalTiktokSpend + totalMetaSpend

  const kpis = {
    total_revenue:      totalRevenue,
    total_spend:        totalSpend,
    blended_roas:       totalSpend > 0 ? totalRevenue / totalSpend : null,
    tacos:              totalAmazonRev > 0 ? totalAmazonSpend / totalAmazonRev : null,
    amazon_revenue:     totalAmazonRev,
    shopify_revenue:    totalShopifyRev,
    tiktok_revenue:     totalTiktokRev,
    amazon_ppc_spend:   totalAmazonSpend,
    tiktok_ads_spend:   totalTiktokSpend,
    meta_ads_spend:     totalMetaSpend,
  }

  return NextResponse.json({ kpis, series })
}

/**
 * GET /api/channels?start=YYYY-MM-DD&end=YYYY-MM-DD&brand=xpro
 *
 * Returns channel-level revenue + spend breakdown for the Channels tab.
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
    .select('date, amazon_revenue, shopify_revenue, tiktok_shop_revenue, amazon_ppc_spend, tiktok_ads_spend, meta_ads_spend')
    .eq('brand', brand)
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true })

  if (error) {
    console.error('[/api/channels]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let amzRev = 0, shopRev = 0, ttkRev = 0
  let amzSpend = 0, ttkSpend = 0, metSpend = 0

  const series = (data ?? []).map((row) => {
    const ar = Number(row.amazon_revenue      ?? 0)
    const sr = Number(row.shopify_revenue     ?? 0)
    const tr = Number(row.tiktok_shop_revenue ?? 0)
    const as_ = Number(row.amazon_ppc_spend   ?? 0)
    const ts = Number(row.tiktok_ads_spend    ?? 0)
    const ms = Number(row.meta_ads_spend      ?? 0)

    amzRev   += ar;  shopRev  += sr;  ttkRev   += tr
    amzSpend += as_; ttkSpend += ts;  metSpend += ms

    return {
      date: row.date,
      amazon_revenue:      ar,
      shopify_revenue:     sr,
      tiktok_shop_revenue: tr,
      amazon_ppc_spend:    as_,
      tiktok_ads_spend:    ts,
      meta_ads_spend:      ms,
      total_revenue: ar + sr + tr,
      total_spend:   as_ + ts + ms,
    }
  })

  const totalRev   = amzRev + shopRev + ttkRev
  const totalSpend = amzSpend + ttkSpend + metSpend

  const channels = {
    revenue: {
      amazon:  { total: amzRev,  share: totalRev > 0 ? amzRev  / totalRev : 0 },
      shopify: { total: shopRev, share: totalRev > 0 ? shopRev / totalRev : 0 },
      tiktok:  { total: ttkRev,  share: totalRev > 0 ? ttkRev  / totalRev : 0 },
      total:   totalRev,
    },
    spend: {
      amazon:  { total: amzSpend,  share: totalSpend > 0 ? amzSpend  / totalSpend : 0, roas: amzSpend  > 0 ? amzRev  / amzSpend  : null },
      tiktok:  { total: ttkSpend,  share: totalSpend > 0 ? ttkSpend  / totalSpend : 0, roas: ttkSpend  > 0 ? ttkRev  / ttkSpend  : null },
      // Meta ads drive the Shopify store, so Meta ROAS = Shopify revenue ÷ Meta spend
      // (same attribution as the Channel Efficiency table).
      meta:    { total: metSpend,  share: totalSpend > 0 ? metSpend  / totalSpend : 0, roas: metSpend  > 0 ? shopRev / metSpend  : null },
      total:   totalSpend,
    },
  }

  return NextResponse.json({ channels, series })
}

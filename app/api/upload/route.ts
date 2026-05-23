/**
 * POST /api/upload
 * Body: { channel: 'shopify' | 'tiktok' | 'meta_spend' | 'tiktok_spend', rows: [{date, value}], brand }
 *
 * Upserts revenue or spend rows into daily_data.
 */
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const CHANNEL_COLUMN: Record<string, string> = {
  shopify:      'shopify_revenue',
  tiktok:       'tiktok_shop_revenue',
  tiktok_spend: 'tiktok_ads_spend',
  meta_spend:   'meta_ads_spend',
}

export async function POST(request: Request) {
  const body = await request.json()
  const { channel, rows, brand = 'xpro' } = body

  if (!channel || !CHANNEL_COLUMN[channel]) {
    return NextResponse.json({ error: `Unknown channel: ${channel}` }, { status: 400 })
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'rows must be a non-empty array' }, { status: 400 })
  }

  const col = CHANNEL_COLUMN[channel]
  const supabase = await createClient()

  // Build upsert payload — one row per date
  const payload = rows
    .filter((r: any) => r.date && r.value != null && !isNaN(Number(r.value)))
    .map((r: any) => ({
      date:  r.date,
      brand,
      [col]: Number(r.value),
    }))

  if (payload.length === 0) {
    return NextResponse.json({ error: 'No valid rows to insert' }, { status: 400 })
  }

  const { error } = await supabase
    .from('daily_data')
    .upsert(payload, { onConflict: 'date,brand', ignoreDuplicates: false })

  if (error) {
    console.error('[/api/upload]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ inserted: payload.length })
}

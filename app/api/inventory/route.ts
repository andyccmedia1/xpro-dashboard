import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse }       from 'next/server'

// GET /api/inventory?brand=xpro
//
// Reads the sku_velocity view (rolling units-shipped windows + per-day velocity per
// MSKU), sourced from the MCF-inclusive FBA Inventory Ledger feed. Admin client bypasses
// RLS, consistent with the other internal API routes. One row per SKU — no pagination.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const brand = searchParams.get('brand') ?? 'xpro'

  const supabase = createAdminClient()
  const cols = 'msku, asin, units_7, units_14, units_30, units_60, units_90, vel_7, vel_14, vel_30, vel_60, vel_90'

  // Prefer the FBA ledger (Amazon orders + MCF combined). While it's blocked on the
  // Amazon Fulfillment role it returns no rows, so fall back to the Shopify MCF feed
  // (the MCF half, pulled straight from Shopify). `source` lets the UI label which it is.
  let source: 'ledger' | 'shopify' = 'ledger'
  let { data, error } = await supabase.from('sku_velocity').select(cols).eq('brand', brand)
  if (!error && (!data || data.length === 0)) {
    source = 'shopify'
    ;({ data, error } = await supabase.from('shopify_sku_velocity').select(cols).eq('brand', brand))
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Coerce numeric/bigint (PostgREST may serialise them as strings) and sort by 30-day velocity.
  const num = (v: unknown) => {
    const n = typeof v === 'string' ? parseFloat(v) : (v as number)
    return Number.isFinite(n) ? n : 0
  }
  const skus = ((data ?? []) as Record<string, unknown>[])
    .map((r) => ({
      msku:     r.msku as string,
      asin:     (r.asin as string | null) ?? null,
      units_7:  num(r.units_7),
      units_14: num(r.units_14),
      units_30: num(r.units_30),
      units_60: num(r.units_60),
      units_90: num(r.units_90),
      vel_7:    num(r.vel_7),
      vel_14:   num(r.vel_14),
      vel_30:   num(r.vel_30),
      vel_60:   num(r.vel_60),
      vel_90:   num(r.vel_90),
    }))
    .sort((a: { vel_30: number }, b: { vel_30: number }) => b.vel_30 - a.vel_30)

  return NextResponse.json({ skus, source })
}

import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse }       from 'next/server'

// Saved what-if scenarios per SKU. A scenario stores its OVERRIDES (base
// velocity, inbounds, promotions — null/absent = inherit the live values), so
// re-opening a scenario re-simulates it against current data instead of
// freezing a stale projection.

const num = (v: unknown) => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number)
  return Number.isFinite(n) ? n : 0
}
const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const brand = searchParams.get('brand') ?? 'xpro'
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('forecast_scenarios')
    .select('msku, name, base_velocity, inbounds, promotions, notes, updated_at')
    .eq('brand', brand)
    .order('updated_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ scenarios: data ?? [] })
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body?.msku || !body?.name) return NextResponse.json({ error: 'msku and name are required' }, { status: 400 })

  const inbounds = Array.isArray(body.inbounds)
    ? body.inbounds
        .map((s: { date?: unknown; qty?: unknown }) => ({ date: isDate(s.date) ? s.date : '', qty: Math.round(num(s.qty)) }))
        .filter((s: { date: string; qty: number }) => s.date && s.qty > 0)
    : null
  const promotions = Array.isArray(body.promotions)
    ? body.promotions
        .map((p: { start?: unknown; end?: unknown; mult?: unknown; label?: unknown }) => ({
          start: isDate(p.start) ? p.start : '', end: isDate(p.end) ? p.end : '',
          mult: Math.max(0, num(p.mult)), label: p.label ? String(p.label).slice(0, 80) : '',
        }))
        .filter((p: { start: string; end: string; mult: number }) => p.start && p.end && p.mult > 0)
    : null

  const row = {
    brand:         body.brand ?? 'xpro',
    msku:          String(body.msku),
    name:          String(body.name).slice(0, 60),
    base_velocity: body.base_velocity == null ? null : Math.max(0, num(body.base_velocity)),
    inbounds,
    promotions,
    notes:         body.notes ? String(body.notes).slice(0, 500) : null,
  }
  const supabase = createAdminClient()
  const { error } = await supabase.from('forecast_scenarios').upsert(row, { onConflict: 'brand,msku,name' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url)
  const brand = searchParams.get('brand') ?? 'xpro'
  const msku  = searchParams.get('msku')
  const name  = searchParams.get('name')
  if (!msku || !name) return NextResponse.json({ error: 'msku and name are required' }, { status: 400 })
  const supabase = createAdminClient()
  const { error } = await supabase.from('forecast_scenarios').delete()
    .eq('brand', brand).eq('msku', msku).eq('name', name)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse }       from 'next/server'

// Global (brand-wide) forecast settings — velocity blend weights, reorder
// policy, horizon, safety-stock method, and the global seasonality curve.
// One row per brand in forecast_settings. Stored server-side so they survive
// cache clears and are shared across devices (unlike the old localStorage).

const num = (v: unknown) => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number)
  return Number.isFinite(n) ? n : 0
}

// GET /api/forecast/settings?brand=xpro
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const brand = searchParams.get('brand') ?? 'xpro'
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('forecast_settings')
    .select('weights, horizon, policy, safety_method, service_lvl, demand_cv, seasonality_on, seasonality, season_strip_deals, blackouts')
    .eq('brand', brand)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ settings: data ?? null })
}

// POST /api/forecast/settings — upsert the brand's settings.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const weights = (body.weights && typeof body.weights === 'object') ? body.weights : {}
  const seasonality = Array.isArray(body.seasonality) && body.seasonality.length === 12
    ? body.seasonality.map((v: unknown) => Math.max(0, num(v)))
    : []

  // Blackout windows: [{start:'YYYY-MM-DD', end:'YYYY-MM-DD', label, kind:'factory'|'receiving'}, …]
  const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  const blackouts = Array.isArray(body.blackouts)
    ? body.blackouts
        .map((b: { start?: unknown; end?: unknown; label?: unknown; kind?: unknown }) => ({
          start: isDate(b.start) ? b.start : '',
          end:   isDate(b.end)   ? b.end   : '',
          label: b.label ? String(b.label).slice(0, 80) : '',
          kind:  b.kind === 'receiving' ? 'receiving' : 'factory',
        }))
        .filter((b: { start: string; end: string }) => b.start && b.end && b.start <= b.end)
    : []

  const row = {
    brand:          body.brand ?? 'xpro',
    weights,
    horizon:        Math.round(num(body.horizon)) || 180,
    policy:         String(body.policy ?? 'R_S'),
    safety_method:  String(body.safety_method ?? 'days'),
    service_lvl:    String(body.service_lvl ?? '95'),
    demand_cv:      Math.max(0, num(body.demand_cv)),
    seasonality_on: !!body.seasonality_on,
    seasonality,
    season_strip_deals: body.season_strip_deals !== false,   // default true
    blackouts,
  }

  const supabase = createAdminClient()
  const { error } = await supabase.from('forecast_settings').upsert(row, { onConflict: 'brand' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

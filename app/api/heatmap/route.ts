import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse }       from 'next/server'

// GET /api/heatmap?days=90&brand=xpro
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const brand = searchParams.get('brand') ?? 'xpro'
  const days  = Math.min(parseInt(searchParams.get('days') ?? '90'), 365)

  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceStr = since.toISOString().slice(0, 10)

  // Use the admin client so RLS doesn't silently filter out rows when the
  // caller is in the `authenticated` role (the anon RLS policy doesn't apply).
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('hourly_sales')
    .select('date, hour, order_count, units, revenue')
    .eq('brand', brand)
    .gte('date', sinceStr)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Aggregate rows → (day_of_week 0=Mon, hour) buckets
  const cells: Record<string, { day: number; hour: number; order_count: number; units: number; revenue: number }> = {}

  for (const row of data ?? []) {
    // Parse date at noon to avoid DST edge cases
    const d   = new Date(row.date + 'T12:00:00')
    const dow = (d.getDay() + 6) % 7          // JS getDay: 0=Sun → shift so 0=Mon
    const key = `${dow}-${row.hour}`

    if (!cells[key]) cells[key] = { day: dow, hour: row.hour, order_count: 0, units: 0, revenue: 0 }
    cells[key].order_count += row.order_count ?? 0
    cells[key].units       += row.units       ?? 0
    cells[key].revenue     += row.revenue     ?? 0
  }

  const result = Object.values(cells).map(c => ({
    ...c,
    revenue: Math.round(c.revenue * 100) / 100,
  }))

  return NextResponse.json({ cells: result, days })
}

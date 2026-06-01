'use client'

import { useState, useEffect, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────
type Cell = {
  day: number          // 0 = Monday … 6 = Sunday
  hour: number         // 0–23, in seller's local timezone (America/New_York)
  order_count: number
  units: number
  revenue: number
}

type Metric = 'order_count' | 'revenue'

// ── Constants ─────────────────────────────────────────────────────────────────
const DAYS  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtHour(h: number): string {
  if (h === 0)  return '12am'
  if (h < 12)   return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

function fmtRevenue(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`
  return `$${v.toFixed(0)}`
}

function fmtMetric(v: number, metric: Metric): string {
  return metric === 'revenue' ? fmtRevenue(v) : v.toLocaleString()
}

/** Dark gray → amber-400 gradient, gamma-corrected for visual spread */
function cellColor(value: number, max: number): string {
  if (!max || !value) return 'rgb(17,24,39)'        // gray-900 (empty)
  const t = Math.pow(value / max, 0.55)              // gamma < 1 spreads low values
  const r = Math.round(17  + t * (251 - 17))
  const g = Math.round(24  + t * (146 - 24))
  const b = Math.round(39  + t * (60  - 39))
  return `rgb(${r},${g},${b})`
}

// ── Heatmap component ─────────────────────────────────────────────────────────
export default function Heatmap() {
  const [periodDays, setPeriodDays] = useState<30 | 60 | 90>(90)
  const [metric,     setMetric]     = useState<Metric>('order_count')
  const [cells,      setCells]      = useState<Cell[]>([])
  const [loading,    setLoading]    = useState(true)
  const [hover,      setHover]      = useState<{ cell: Cell; x: number; y: number } | null>(null)

  const load = useCallback((days: number) => {
    setLoading(true)
    fetch(`/api/heatmap?days=${days}`)
      .then(r => r.json())
      .then(d  => { setCells(d.cells ?? []); setLoading(false) })
      .catch(()  => setLoading(false))
  }, [])

  useEffect(() => { load(periodDays) }, [periodDays, load])

  // Build O(1) lookup: "day-hour" → Cell
  const lookup = new Map<string, Cell>()
  for (const c of cells) lookup.set(`${c.day}-${c.hour}`, c)

  const maxVal = Math.max(...cells.map(c => c[metric]), 1)

  // Top 3 peak hours across all days for the selected metric
  const peakHours = HOURS
    .map(h => ({
      hour: h,
      value: DAYS.reduce((sum, _, d) => sum + (lookup.get(`${d}-${h}`)?.[metric] ?? 0), 0),
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)

  // Best day
  const peakDays = DAYS
    .map((label, d) => ({
      label,
      value: HOURS.reduce((sum, h) => sum + (lookup.get(`${d}-${h}`)?.[metric] ?? 0), 0),
    }))
    .sort((a, b) => b.value - a.value)

  return (
    <div className="space-y-6">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Sales Heatmap</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            When orders are placed — time your campaigns to peak buying windows (ET)
          </p>
        </div>

        <div className="flex gap-2 flex-wrap">
          {/* Metric */}
          <div className="flex bg-gray-800 rounded-lg p-0.5">
            {(['order_count', 'revenue'] as Metric[]).map(m => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  metric === m
                    ? 'bg-gray-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {m === 'order_count' ? 'Orders' : 'Revenue'}
              </button>
            ))}
          </div>

          {/* Period */}
          <div className="flex bg-gray-800 rounded-lg p-0.5">
            {([30, 60, 90] as const).map(d => (
              <button
                key={d}
                onClick={() => setPeriodDays(d)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  periodDays === d
                    ? 'bg-gray-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Loading / empty states ──────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
          Loading heatmap…
        </div>
      ) : cells.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-center space-y-2">
          <p className="text-gray-300 text-sm font-medium">No order data yet</p>
          <p className="text-gray-600 text-xs max-w-sm">
            Run a backfill from GitHub Actions (no date = auto-fills gaps) to populate
            historical order times, then come back here.
          </p>
        </div>
      ) : (
        <>
          {/* ── Heatmap grid ──────────────────────────────────── */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 overflow-x-auto">
            <div style={{ minWidth: 680 }}>

              {/* Hour axis labels (every 3 hours) */}
              <div className="flex mb-1.5" style={{ marginLeft: 40 }}>
                {HOURS.map(h => (
                  <div
                    key={h}
                    className="text-center text-gray-600"
                    style={{ flex: 1, fontSize: 9, fontWeight: 500 }}
                  >
                    {h % 3 === 0 ? fmtHour(h) : ''}
                  </div>
                ))}
              </div>

              {/* Rows: one per day */}
              {DAYS.map((dayLabel, d) => (
                <div key={dayLabel} className="flex items-center mb-0.5 gap-0.5">
                  {/* Day label */}
                  <div className="text-right text-xs text-gray-500 font-medium shrink-0 pr-1.5"
                       style={{ width: 32 }}>
                    {dayLabel}
                  </div>

                  {/* 24 hour cells */}
                  {HOURS.map(h => {
                    const cell = lookup.get(`${d}-${h}`)
                    const val  = cell?.[metric] ?? 0
                    const isHovered = hover?.cell.day === d && hover?.cell.hour === h

                    return (
                      <div
                        key={h}
                        className="rounded-sm cursor-default transition-all"
                        style={{
                          flex: 1,
                          height: 26,
                          backgroundColor: cellColor(val, maxVal),
                          outline: isHovered ? '1px solid rgba(251,146,60,0.7)' : undefined,
                          outlineOffset: 1,
                        }}
                        onMouseEnter={e => cell && setHover({ cell, x: e.clientX, y: e.clientY })}
                        onMouseMove={e  => hover && setHover(h => h ? { ...h, x: e.clientX, y: e.clientY } : null)}
                        onMouseLeave={() => setHover(null)}
                      />
                    )
                  })}
                </div>
              ))}

              {/* Colour legend */}
              <div className="flex items-center justify-end gap-2 mt-3">
                <span className="text-xs text-gray-600">Low</span>
                <div className="flex gap-px">
                  {[0, 0.15, 0.3, 0.5, 0.7, 0.85, 1.0].map(t => (
                    <div
                      key={t}
                      className="rounded-sm"
                      style={{ width: 18, height: 10, backgroundColor: cellColor(t * maxVal, maxVal) }}
                    />
                  ))}
                </div>
                <span className="text-xs text-gray-600">High</span>
              </div>
            </div>
          </div>

          {/* ── Insights row ──────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

            {/* Peak hours */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Top Buying Hours
              </h3>
              <div className="space-y-2">
                {peakHours.map((ph, i) => {
                  const pct = ph.value / (peakHours[0]?.value || 1)
                  return (
                    <div key={ph.hour} className="flex items-center gap-3">
                      <span className="text-xs font-bold text-amber-400 w-4">#{i + 1}</span>
                      <span className="text-sm text-white w-20 shrink-0">
                        {fmtHour(ph.hour)}–{fmtHour(ph.hour + 1 < 24 ? ph.hour + 1 : 0)}
                      </span>
                      <div className="flex-1 bg-gray-800 rounded-full h-1.5 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-amber-500"
                          style={{ width: `${pct * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400 w-16 text-right shrink-0">
                        {fmtMetric(ph.value, metric)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Best days */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Best Days
              </h3>
              <div className="space-y-2">
                {peakDays.slice(0, 4).map((pd, i) => {
                  const pct = pd.value / (peakDays[0]?.value || 1)
                  return (
                    <div key={pd.label} className="flex items-center gap-3">
                      <span className="text-xs font-bold text-amber-400 w-4">#{i + 1}</span>
                      <span className="text-sm text-white w-10 shrink-0">{pd.label}</span>
                      <div className="flex-1 bg-gray-800 rounded-full h-1.5 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-indigo-500"
                          style={{ width: `${pct * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400 w-16 text-right shrink-0">
                        {fmtMetric(pd.value, metric)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Campaign timing tip */}
          {peakHours.length >= 2 && (
            <div className="bg-amber-950/30 border border-amber-800/40 rounded-xl p-4 text-sm text-amber-300">
              <span className="font-semibold">Campaign tip: </span>
              Schedule your highest-budget dayparts around{' '}
              <span className="font-medium text-white">
                {fmtHour(peakHours[0].hour)}–{fmtHour((peakHours[0].hour + 2) % 24)}
              </span>{' '}
              and{' '}
              <span className="font-medium text-white">
                {fmtHour(peakHours[1].hour)}–{fmtHour((peakHours[1].hour + 2) % 24)}
              </span>{' '}
              ET — your two highest-volume windows over the last {periodDays} days.
            </div>
          )}
        </>
      )}

      {/* ── Hover tooltip ─────────────────────────────────────── */}
      {hover && (
        <div
          className="fixed z-50 pointer-events-none bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 shadow-xl"
          style={{ left: hover.x + 14, top: hover.y - 56 }}
        >
          <p className="text-xs font-semibold text-white mb-0.5">
            {DAYS[hover.cell.day]} · {fmtHour(hover.cell.hour)}–{fmtHour((hover.cell.hour + 1) % 24)}
          </p>
          <p className="text-xs text-gray-300">
            {hover.cell.order_count.toLocaleString()} orders · {hover.cell.units.toLocaleString()} units
          </p>
          <p className="text-xs text-amber-400">{fmtRevenue(hover.cell.revenue)}</p>
        </div>
      )}
    </div>
  )
}

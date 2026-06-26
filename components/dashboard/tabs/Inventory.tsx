'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────
type Sku = {
  msku: string
  asin: string | null
  units_7: number;  units_14: number; units_30: number; units_60: number; units_90: number
  vel_7: number;    vel_14: number;   vel_30: number;   vel_60: number;   vel_90: number
}

type Window = 7 | 14 | 30 | 60 | 90

// ── Helpers ───────────────────────────────────────────────────────────────────
const WINDOWS: Window[] = [7, 14, 30, 60, 90]
const unitsKey = (w: Window) => `units_${w}` as keyof Sku
const velKey   = (w: Window) => `vel_${w}`   as keyof Sku

/** Recent-vs-baseline trend: short-window velocity against the 90-day velocity. */
function trendOf(s: Sku): { label: string; cls: string; arrow: string } {
  const recent = s.vel_7
  const base   = s.vel_90
  if (base === 0 && recent === 0) return { label: 'No sales', cls: 'text-gray-600', arrow: '·' }
  if (base === 0 && recent > 0)   return { label: 'New / ramping', cls: 'text-amber-400', arrow: '↑' }
  const ratio = recent / base
  if (ratio >= 1.2) return { label: 'Accelerating', cls: 'text-emerald-400', arrow: '↑' }
  if (ratio <= 0.8) return { label: 'Slowing',      cls: 'text-rose-400',    arrow: '↓' }
  return { label: 'Steady', cls: 'text-gray-400', arrow: '→' }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function Inventory() {
  const [skus,    setSkus]    = useState<Sku[]>([])
  const [loading, setLoading] = useState(true)
  const [win,     setWin]     = useState<Window>(30)
  const [q,       setQ]       = useState('')
  const [source,  setSource]  = useState<'ledger' | 'shopify'>('ledger')

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/inventory')
      .then(r => r.json())
      .then(d => { setSkus(d.skus ?? []); setSource(d.source ?? 'ledger'); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const rows = useMemo(() => {
    const filtered = q.trim()
      ? skus.filter(s =>
          s.msku.toLowerCase().includes(q.toLowerCase()) ||
          (s.asin ?? '').toLowerCase().includes(q.toLowerCase()))
      : skus
    return [...filtered].sort((a, b) => (b[velKey(win)] as number) - (a[velKey(win)] as number))
  }, [skus, q, win])

  const totals = useMemo(() => ({
    skuCount:  skus.length,
    units30:   skus.reduce((s, r) => s + r.units_30, 0),
    units90:   skus.reduce((s, r) => s + r.units_90, 0),
    perDay30:  skus.reduce((s, r) => s + r.vel_30, 0),
  }), [skus])

  return (
    <div className="space-y-6">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Inventory Velocity</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            {source === 'ledger'
              ? <>Total FBA depletion per SKU — <span className="text-emerald-400">Amazon-marketplace orders + MCF (Shopify)</span> combined. The true demand signal for replenishment.</>
              : <>Showing <span className="text-emerald-400">Shopify online-store (MCF)</span> units — your off-Amazon orders fulfilled from FBA.</>}
          </p>
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search SKU / ASIN…"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-44"
          />
          <div className="flex bg-gray-800 rounded-lg p-0.5">
            {WINDOWS.map(w => (
              <button
                key={w}
                onClick={() => setWin(w)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  win === w ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64 text-gray-500 text-sm">Loading inventory…</div>
      ) : skus.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-center space-y-2">
          <p className="text-gray-300 text-sm font-medium">No inventory data yet</p>
          <p className="text-gray-600 text-xs max-w-sm">
            Run the workflow with “ledger_only” checked (start_date 90 days ago) to populate
            fba_daily_shipped, then come back here.
          </p>
        </div>
      ) : (
        <>
          {/* ── Summary cards ─────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card label="SKUs tracked"        value={totals.skuCount.toLocaleString()} sub="With shipments in window" />
            <Card label="Units shipped (30d)" value={totals.units30.toLocaleString()}  sub="All FBA depletion" />
            <Card label="Units shipped (90d)" value={totals.units90.toLocaleString()}  sub="All FBA depletion" />
            <Card label="Run rate"            value={`${totals.perDay30.toLocaleString(undefined, { maximumFractionDigits: 0 })}/day`} sub="Blended 30-day velocity" />
          </div>

          {/* ── Table ─────────────────────────────────────────── */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                    <th className="px-4 py-3 font-medium">SKU</th>
                    {WINDOWS.map(w => (
                      <th key={w} className={`px-3 py-3 font-medium text-right ${win === w ? 'text-gray-300' : ''}`}>{w}d</th>
                    ))}
                    <th className="px-3 py-3 font-medium text-right">/day ({win}d)</th>
                    <th className="px-4 py-3 font-medium">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(s => {
                    const t = trendOf(s)
                    return (
                      <tr key={s.msku} className="border-b border-gray-800/60 hover:bg-gray-800/30">
                        <td className="px-4 py-3 max-w-xs">
                          <div className="text-white truncate" title={s.msku}>{s.msku}</div>
                          {s.asin && <div className="text-xs text-gray-600">{s.asin}</div>}
                        </td>
                        {WINDOWS.map(w => (
                          <td
                            key={w}
                            className={`px-3 py-3 text-right tabular-nums ${win === w ? 'text-white font-medium' : 'text-gray-400'}`}
                          >
                            {(s[unitsKey(w)] as number).toLocaleString()}
                          </td>
                        ))}
                        <td className="px-3 py-3 text-right tabular-nums text-amber-400 font-medium">
                          {(s[velKey(win)] as number).toFixed(2)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-medium ${t.cls}`}>{t.arrow} {t.label}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── How to read this ──────────────────────────────── */}
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 text-xs text-gray-400 space-y-1.5">
            <p>
              <span className="text-gray-300 font-medium">Why these numbers differ from Sellerboard / the SKU tab:</span>{' '}
              the Amazon sales report counts marketplace orders only. This feed reads the FBA Inventory
              Ledger, which also captures Shopify/TikTok orders fulfilled via MCF — so SKUs that draw
              from FBA for off-Amazon channels show their <em>full</em> demand here.
            </p>
            <p>
              <span className="text-emerald-400 font-medium">Trend</span> compares 7-day vs 90-day
              velocity: accelerating SKUs are worth reordering against the shorter window.
            </p>
            <p className="text-gray-600 pt-1">
              Next phase: add lead time, safety stock, and on-hand per SKU to turn velocity into a
              reorder point + “reorder now” flag.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

// ── Small UI piece ────────────────────────────────────────────────────────────
function Card({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wider font-medium">{label}</p>
      <p className="text-2xl font-bold mt-1 text-white">{value}</p>
      <p className="text-xs text-gray-600 mt-0.5">{sub}</p>
    </div>
  )
}

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts'
import { DEFAULT_WEIGHTS, type PeriodWeights } from '@/lib/forecast'
import {
  computeFor, Z, SCEN_COLORS, n0, n2,
  type Sku, type Blackout, type Scenario, type Policy, type SafetyMethod, type Safety, type Seasonality,
} from '@/lib/forecast-client'

// ── Scenario Planner ──────────────────────────────────────────────────────────
// What-if modeling, separate from the operational Forecast tab but fed by the
// SAME live SKU data and global settings. Save named scenarios per SKU (pinned
// velocity + a snapshot of inbounds/deals), overlay up to 3 against the live
// baseline, and compare the routes side by side.

type Settings = {
  weights: PeriodWeights
  policy: Policy
  horizon: number
  safety: Safety
  season: Seasonality
  blackouts: Blackout[]
}

export default function ScenarioPlanner() {
  const [skus,     setSkus]     = useState<Sku[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [loading,  setLoading]  = useState(true)
  const [loadErr,  setLoadErr]  = useState('')

  const [selected, setSelected] = useState<string>('')
  const [horizon,  setHorizon]  = useState(180)
  const [active,   setActive]   = useState<Record<string, string[]>>({})   // msku -> overlaid names

  const [scenName,  setScenName]  = useState('')
  const [scenVel,   setScenVel]   = useState('')
  const [scenNotes, setScenNotes] = useState('')
  const [scenBusy,  setScenBusy]  = useState(false)
  const [scenErr,   setScenErr]   = useState('')

  // Anchor to yesterday (the last fully-complete data day)
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1); return d }, [])

  const load = useCallback(() => {
    setLoading(true)
    setLoadErr('')
    Promise.all([
      fetch('/api/forecast').then(r => r.json()),
      fetch('/api/forecast/settings').then(r => r.json()).catch(() => ({ settings: null })),
      fetch('/api/forecast/scenarios').then(r => r.json()).catch(() => ({ scenarios: [] })),
    ])
      .then(([f, s, sc]) => {
        if (f.error) { setLoadErr(String(f.error)); setLoading(false); return }
        const list: Sku[] = f.skus ?? []
        setSkus(list)
        if (!selected && list.length) setSelected(list[0].msku)
        const v = s.settings ?? {}
        const st: Settings = {
          weights: { ...DEFAULT_WEIGHTS, ...(v.weights ?? {}) },
          policy: (v.policy ?? 'R_S') as Policy,
          horizon: v.horizon ? Number(v.horizon) : 180,
          safety: {
            method: (v.safety_method ?? 'days') as SafetyMethod,
            z: Z[String(v.service_lvl ?? '95')] ?? 1.65,
            cv: typeof v.demand_cv === 'number' ? v.demand_cv : 0.4,
          },
          season: {
            on: !!v.seasonality_on,
            factors: Array.isArray(v.seasonality) && v.seasonality.length === 12 ? v.seasonality.map(Number) : Array(12).fill(1),
            strip: v.season_strip_deals !== false,
          },
          blackouts: Array.isArray(v.blackouts) ? v.blackouts : [],
        }
        setSettings(st)
        setHorizon(st.horizon)
        if (Array.isArray(sc.scenarios)) setScenarios(sc.scenarios)
        setLoading(false)
      })
      .catch(e => { setLoadErr(e instanceof Error ? e.message : 'Failed to load'); setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { load() }, [load])

  const sku = skus.find(s => s.msku === selected) ?? null

  // Live baseline simulation
  const baseline = useMemo(() => {
    if (!sku || !settings) return null
    return computeFor(sku, settings.weights, horizon, settings.policy, today, settings.safety, settings.season, settings.blackouts)
  }, [sku, settings, horizon, today])

  // Overlaid scenario simulations (re-run against live data every render input change)
  const runs = useMemo(() => {
    if (!sku || !settings) return []
    return (active[sku.msku] ?? [])
      .map((name, i) => {
        const sc = scenarios.find(s => s.msku === sku.msku && s.name === name)
        if (!sc) return null
        const variant: Sku = { ...sku, inbounds: sc.inbounds ?? sku.inbounds, promotions: sc.promotions ?? sku.promotions }
        const run = computeFor(variant, settings.weights, horizon, settings.policy, today, settings.safety, settings.season, settings.blackouts, sc.base_velocity ?? undefined)
        return { name, color: SCEN_COLORS[i % SCEN_COLORS.length], sc, ...run }
      })
      .filter((s): s is NonNullable<typeof s> => s != null)
  }, [sku, settings, horizon, today, active, scenarios])

  async function saveScenario() {
    if (!sku) return
    if (!scenName.trim()) { setScenErr('Give the scenario a name first'); return }
    setScenBusy(true); setScenErr('')
    try {
      const vel = scenVel.trim() === '' ? null : Math.max(0, parseFloat(scenVel) || 0)
      const res = await fetch('/api/forecast/scenarios', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msku: sku.msku, name: scenName.trim(), base_velocity: vel,
          inbounds: sku.inbounds, promotions: sku.promotions,
          notes: scenNotes.trim() || null,
        }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`) }
      const saved = scenName.trim()
      setScenarios(prev => [
        { msku: sku.msku, name: saved, base_velocity: vel, inbounds: sku.inbounds, promotions: sku.promotions, notes: scenNotes.trim() || null },
        ...prev.filter(x => !(x.msku === sku.msku && x.name === saved)),
      ])
      setActive(prev => ({ ...prev, [sku.msku]: [...new Set([...(prev[sku.msku] ?? []), saved])].slice(0, 3) }))
      setScenName(''); setScenVel(''); setScenNotes('')
    } catch (e) {
      setScenErr(e instanceof Error ? e.message : 'Save failed')
    } finally { setScenBusy(false) }
  }

  async function deleteScenario(msku: string, name: string) {
    setScenarios(prev => prev.filter(x => !(x.msku === msku && x.name === name)))
    setActive(prev => ({ ...prev, [msku]: (prev[msku] ?? []).filter(n => n !== name) }))
    await fetch(`/api/forecast/scenarios?msku=${encodeURIComponent(msku)}&name=${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {})
  }

  const toggle = (msku: string, name: string) =>
    setActive(prev => {
      const cur = prev[msku] ?? []
      return { ...prev, [msku]: cur.includes(name) ? cur.filter(n => n !== name) : [...cur, name].slice(0, 3) }
    })

  const mySc = sku ? scenarios.filter(sc => sc.msku === sku.msku) : []
  const scenCount = (msku: string) => scenarios.filter(sc => sc.msku === msku).length

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Scenario Planner</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            What-if modeling on top of the live forecast — pin a velocity, snapshot the PO/deal plan, and compare routes.
            Uses the same SKU data, seasonality, deals and blackouts as the Forecast tab.
          </p>
        </div>
        <div className="flex gap-2 items-center text-xs">
          <span className="text-gray-500">SKU</span>
          <select
            value={selected}
            onChange={e => setSelected(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200 max-w-56"
          >
            {skus.map(s => (
              <option key={s.msku} value={s.msku}>
                {s.msku}{scenCount(s.msku) > 0 ? ` (${scenCount(s.msku)})` : ''}
              </option>
            ))}
          </select>
          <span className="text-gray-500 ml-2">Horizon</span>
          <select
            value={horizon}
            onChange={e => setHorizon(parseInt(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200"
          >
            {[90, 180, 270, 365].map(d => <option key={d} value={d}>{d}d</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-500 text-sm">Loading…</div>
      ) : loadErr ? (
        <div className="flex flex-col items-center justify-center h-48 text-center space-y-2">
          <p className="text-rose-400 text-sm font-medium">⚠ Failed to load — your saved data is safe</p>
          <p className="text-gray-500 text-xs max-w-lg">{loadErr}</p>
          <button onClick={load} className="text-xs font-medium text-indigo-400 hover:text-indigo-300 mt-1">↻ Retry</button>
        </div>
      ) : !sku || !baseline ? (
        <div className="flex items-center justify-center h-48 text-gray-500 text-sm">No SKU data yet — configure SKUs on the Forecast tab first.</div>
      ) : (
        <>
          {/* ── Baseline stats ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card label="Live velocity" value={`${n2(baseline.base)}/day`} sub="blended 7/14/30/60/90" />
            <Card label="On hand" value={n0(sku.on_hand)} sub={Number.isFinite(baseline.daysOfCover) ? `${Math.round(baseline.daysOfCover)} days cover` : '—'} />
            <Card label="Inbound" value={n0((sku.inbounds ?? []).reduce((s, x) => s + (x.qty || 0), 0))} sub={`${(sku.inbounds ?? []).length} shipment(s)`} />
            <Card label="Baseline stockout" value={baseline.analytics.firstStockoutDate ?? 'none'}
                  sub={baseline.analytics.firstReorderDate ? `next PO ${baseline.analytics.firstReorderDate}` : 'no PO in horizon'}
                  accent={baseline.analytics.firstStockoutDate ? 'text-rose-400' : 'text-emerald-400'} />
          </div>

          {/* ── Scenario list + save form ── */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Saved scenarios · {sku.msku}</h3>
              <span className="text-xs text-gray-600">tick up to 3 to overlay</span>
            </div>
            {mySc.length === 0 ? (
              <p className="text-xs text-gray-600">No scenarios yet for this SKU — save one below (e.g. &quot;Push to 150&quot;).</p>
            ) : (
              <div className="space-y-1.5">
                {mySc.map(sc => {
                  const isActive = (active[sku.msku] ?? []).includes(sc.name)
                  const run = runs.find(r => r.name === sc.name)
                  return (
                    <div key={sc.name} className="flex items-center gap-2 flex-wrap text-sm">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input type="checkbox" checked={isActive} onChange={() => toggle(sku.msku, sc.name)} className="accent-indigo-500 w-3.5 h-3.5" />
                        {run && <span className="w-3 h-0.5 rounded" style={{ background: run.color }} />}
                        <span className="text-white">{sc.name}</span>
                      </label>
                      <span className="text-xs text-gray-500">
                        {sc.base_velocity != null ? `${sc.base_velocity}/day` : 'live velocity'}
                        {sc.notes ? ` · ${sc.notes}` : ''}
                      </span>
                      {run && (
                        <span className="text-xs">
                          {run.analytics.firstStockoutDate
                            ? <span className="text-rose-400">stockout {run.analytics.firstStockoutDate}</span>
                            : <span className="text-emerald-400">no stockout</span>}
                          {run.analytics.firstReorderDate && (
                            <span className="text-amber-400"> · new PO by {run.analytics.firstReorderDate} ({n0(run.analytics.firstReorderQty)}u)</span>
                          )}
                          <span className="text-gray-500"> · min {n0(run.analytics.minInventory)}u</span>
                        </span>
                      )}
                      <button onClick={() => deleteScenario(sku.msku, sc.name)}
                              className="text-gray-600 hover:text-rose-400 text-xs px-1" title="Delete scenario">✕</button>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-gray-800/60">
              <input
                type="text" placeholder="scenario name (e.g. Push to 150)"
                value={scenName} onChange={e => setScenName(e.target.value)}
                className="w-48 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
              />
              <input
                type="number" min={0} step={1} placeholder={`${baseline.base.toFixed(0)} (live)`}
                value={scenVel} onChange={e => setScenVel(e.target.value)}
                className="w-28 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-center"
                title="Base units/day for this scenario — leave blank to always track the live blended velocity"
              />
              <span className="text-xs text-gray-600">u/day</span>
              <input
                type="text" placeholder="notes (optional)"
                value={scenNotes} onChange={e => setScenNotes(e.target.value)}
                className="w-52 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
              />
              <button
                onClick={saveScenario}
                disabled={scenBusy}
                className="text-xs font-medium text-indigo-400 hover:text-indigo-300 disabled:opacity-50 px-2 py-1.5 rounded border border-gray-700 hover:bg-gray-800"
              >
                {scenBusy ? 'Saving…' : '+ Save scenario'}
              </button>
              {scenErr && <span className="text-xs text-rose-400">⚠ {scenErr}</span>}
            </div>
            <p className="text-xs text-gray-600">
              Saves the SKU&apos;s current inbounds &amp; deals as a snapshot with the pinned velocity. Scenarios re-simulate
              against fresh sales data on every load, so outcomes stay current as reality unfolds.
            </p>
          </div>

          {/* ── Projection chart ── */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={baseline.rows.map((r, idx) => ({
                    ...r,
                    ...Object.fromEntries(runs.map((s, i) => [`scen${i}`, Math.round(s.rows[idx]?.inventory ?? 0)])),
                  }))}
                  margin={{ top: 16, right: 12, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }}
                         tickFormatter={(d: string) => d.slice(5)} minTickGap={40} />
                  <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} width={44} />
                  <Tooltip
                    contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: '#9ca3af' }}
                    formatter={(v, name) => [n0(Number(v)), name]}
                  />
                  {baseline.blackoutBands.map((b, i) => (
                    <ReferenceArea key={'blk' + i} x1={baseline.rows[b.startDay]?.date} x2={baseline.rows[b.endDay]?.date}
                                   fill={b.kind === 'factory' ? '#64748b' : '#06b6d4'} fillOpacity={0.10}
                                   stroke={b.kind === 'factory' ? '#64748b' : '#06b6d4'} strokeOpacity={0.3}
                                   label={{ value: b.label, position: 'insideBottom', fill: '#94a3b8', fontSize: 10 }} />
                  ))}
                  {baseline.promoStats.map((w, i) => (
                    <ReferenceArea key={'promo' + i} x1={baseline.rows[w.startDay]?.date} x2={baseline.rows[w.endDay]?.date}
                                   fill="#a855f7" fillOpacity={0.10} stroke="#a855f7" strokeOpacity={0.3}
                                   label={{ value: `${w.promo.label || 'deal'} ${w.promo.mult}×`, position: 'insideTop', fill: '#c084fc', fontSize: 10 }} />
                  ))}
                  <Line type="monotone" dataKey="inventory" name="Live baseline" stroke="#6366f1" dot={false} strokeWidth={2} />
                  {runs.map((s, i) => (
                    <Line key={s.name} type="monotone" dataKey={`scen${i}`} name={s.name}
                          stroke={s.color} dot={false} strokeWidth={2} strokeDasharray="6 3" />
                  ))}
                  <Line type="monotone" dataKey="reorderPoint" name="Reorder point" stroke="#f59e0b" dot={false} strokeDasharray="4 3" strokeWidth={1.5} />
                  <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="2 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-gray-600 mt-2">
              Indigo solid = live baseline · dashed colored lines = scenarios · amber dashed = reorder point ·
              purple bands = deals · slate/cyan bands = blackout windows.
            </p>
          </div>

          {/* ── Route comparison table ── */}
          {runs.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                      <th className="px-4 py-3 font-medium">Route</th>
                      <th className="px-3 py-3 font-medium text-right">Base vel</th>
                      <th className="px-3 py-3 font-medium">Stockout</th>
                      <th className="px-3 py-3 font-medium">Next PO by</th>
                      <th className="px-3 py-3 font-medium text-right">PO qty</th>
                      <th className="px-3 py-3 font-medium text-right">Min inv</th>
                      <th className="px-3 py-3 font-medium text-right">End inv</th>
                      <th className="px-3 py-3 font-medium text-right">Service</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[{ name: 'Live baseline', color: '#6366f1', ...baseline }, ...runs].map(r => (
                      <tr key={r.name} className="border-b border-gray-800/60">
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-2 text-white">
                            <span className="w-3 h-0.5 rounded" style={{ background: r.color }} />{r.name}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{n2(r.base)}</td>
                        <td className="px-3 py-3">
                          {r.analytics.firstStockoutDate
                            ? <span className="text-rose-400">{r.analytics.firstStockoutDate}</span>
                            : <span className="text-emerald-400">none</span>}
                        </td>
                        <td className="px-3 py-3 text-amber-400">{r.analytics.firstReorderDate ?? '—'}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{r.analytics.firstReorderQty > 0 ? n0(r.analytics.firstReorderQty) : '—'}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{n0(r.analytics.minInventory)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{n0(r.rows[r.rows.length - 1]?.inventory ?? 0)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{(r.analytics.serviceLevel * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-0.5">
      <p className="text-xs text-gray-500 uppercase tracking-wider font-medium">{label}</p>
      <p className={`text-xl font-bold ${accent ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600">{sub}</p>}
    </div>
  )
}

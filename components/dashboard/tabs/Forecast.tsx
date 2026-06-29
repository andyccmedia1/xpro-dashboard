'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  weightedVelocity, runForecast, analyzeForecast,
  DEFAULT_WEIGHTS, type PeriodWeights, type ForecastRow, type ForecastAnalytics,
} from '@/lib/forecast'

// ── Types ─────────────────────────────────────────────────────────────────────
type Inbound = { date: string; qty: number }

type Sku = {
  msku: string
  asin: string | null
  v7: number; v14: number; v30: number; v60: number; v90: number
  units_7: number; units_14: number; units_30: number; units_60: number; units_90: number
  on_hand: number; inbounds: Inbound[]
  lead_time_days: number; lead_time_std_days: number; safety_stock_days: number
  moq: number; casepack: number; cycle_cover_days: number
  has_params: boolean
}

type Policy = 'R_S' | 's_Q' | 'EOQ'
type SafetyMethod = 'days' | 'service'

// Service-level → z-score
const Z: Record<string, number> = { '90': 1.28, '95': 1.65, '97': 1.88, '99': 2.33 }

// Scalar editable params (inbound shipments are edited in their own list section)
const PARAM_FIELDS = [
  { key: 'on_hand',            label: 'On-hand units' },
  { key: 'lead_time_days',     label: 'Lead time (days)' },
  { key: 'lead_time_std_days', label: 'Lead time ± (days)' },
  { key: 'safety_stock_days',  label: 'Safety stock (days)' },
  { key: 'cycle_cover_days',   label: 'Cycle coverage (days)' },
  { key: 'moq',                label: 'MOQ' },
  { key: 'casepack',           label: 'Casepack' },
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────
const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—')
const n2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—')

const DAY_MS = 86_400_000
/** Whole days from the forecast anchor to an inbound date (null/past → null). */
function inboundDayOffset(inboundDate: string | null, anchor: Date): number | null {
  if (!inboundDate) return null
  const d = new Date(inboundDate + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  const offset = Math.round((d.getTime() - anchor.getTime()) / DAY_MS)
  return offset >= 0 ? offset : null
}

type Safety = { method: SafetyMethod; z: number; cv: number }

function computeFor(sku: Sku, weights: PeriodWeights, horizon: number, policy: Policy, today: Date, safety: Safety) {
  const base = weightedVelocity({ v7: sku.v7, v14: sku.v14, v30: sku.v30, v60: sku.v60, v90: sku.v90 }, weights)
  const deliveries = (sku.inbounds ?? [])
    .map(s => ({ day: inboundDayOffset(s.date, today), qty: s.qty }))
    .filter((d): d is { day: number; qty: number } => d.day != null && d.qty > 0)
  const useService = safety.method === 'service'
  const sigmaD = safety.cv * base   // daily demand std as a fraction of velocity
  const rows = runForecast({
    initialInventory: sku.on_hand,
    baseVelocity: base,
    startDate: today,
    days: horizon,
    deliveries,
    leadTime: sku.lead_time_days,
    safetyStockDays: sku.safety_stock_days,
    cycleCoverDays: sku.cycle_cover_days,
    moq: sku.moq,
    casepack: sku.casepack,
    reorderPolicy: policy,
    dynamicReorder: true,
    useServiceLevelSafety: useService,
    serviceLevelZ: safety.z,
    demandStdDev: sigmaD,
    leadTimeStdDays: sku.lead_time_std_days,
  })
  const analytics = analyzeForecast(rows)
  const daysOfCover = base > 0 ? sku.on_hand / base : Infinity
  // Safety stock figure for display (mirrors the engine)
  const safetyStock = useService
    ? safety.z * Math.sqrt(sigmaD * sigmaD * sku.lead_time_days + base * base * sku.lead_time_std_days * sku.lead_time_std_days)
    : base * sku.safety_stock_days
  return { base, rows, analytics, daysOfCover, safetyStock }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function Forecast() {
  const [skus,    setSkus]    = useState<Sku[]>([])
  const [loading, setLoading] = useState(true)
  const [source,  setSource]  = useState<'ledger' | 'shopify'>('ledger')

  const [weights, setWeights] = useState<PeriodWeights>(DEFAULT_WEIGHTS)
  const [horizon, setHorizon] = useState(180)
  const [policy,  setPolicy]  = useState<Policy>('R_S')
  const [safetyMethod, setSafetyMethod] = useState<SafetyMethod>('days')
  const [serviceLvl,   setServiceLvl]   = useState('95')   // %
  const [demandCv,     setDemandCv]     = useState(0.4)    // σ_d as fraction of velocity

  const safety: Safety = useMemo(
    () => ({ method: safetyMethod, z: Z[serviceLvl] ?? 1.65, cv: demandCv }),
    [safetyMethod, serviceLvl, demandCv],
  )

  const [edits,    setEdits]    = useState<Record<string, Partial<Sku>>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [saving,   setSaving]   = useState(false)
  const detailRef = useRef<HTMLDivElement>(null)

  // Scroll the detail panel into view when a SKU is selected (it renders below the table)
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [selected])

  // Anchor to yesterday (the last fully-complete data day) — today's data is partial.
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1); return d }, [])

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/forecast')
      .then(r => r.json())
      .then(d => { setSkus(d.skus ?? []); setSource(d.source ?? 'ledger'); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  // Merge a SKU with any unsaved edits
  const effective = useCallback((s: Sku): Sku => ({ ...s, ...edits[s.msku] }), [edits])

  // Compute forecast for every SKU (cheap; ~SKUs × horizon iterations)
  const computed = useMemo(() => {
    return skus.map(s => {
      const eff = effective(s)
      return { sku: eff, ...computeFor(eff, weights, horizon, policy, today, safety) }
    })
  }, [skus, edits, weights, horizon, policy, today, effective, safety])

  // Sort: most urgent first (fewest days of cover)
  const rows = useMemo(
    () => [...computed].sort((a, b) => a.daysOfCover - b.daysOfCover),
    [computed],
  )

  const sel = computed.find(c => c.sku.msku === selected) ?? null

  function setEdit(msku: string, key: keyof Sku, value: number | string | null | Inbound[]) {
    setEdits(e => ({ ...e, [msku]: { ...e[msku], [key]: value } }))
  }
  // Inbound shipment list editors
  const setInbounds = (s: Sku, list: Inbound[]) => setEdit(s.msku, 'inbounds', list)
  const addInbound    = (s: Sku) => setInbounds(s, [...(s.inbounds ?? []), { date: '', qty: 0 }])
  const removeInbound = (s: Sku, i: number) => setInbounds(s, (s.inbounds ?? []).filter((_, idx) => idx !== i))
  const updateInbound = (s: Sku, i: number, field: keyof Inbound, value: string | number) =>
    setInbounds(s, (s.inbounds ?? []).map((sh, idx) => (idx === i ? { ...sh, [field]: value } : sh)))

  async function saveParams(s: Sku) {
    setSaving(true)
    try {
      await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msku: s.msku,
          on_hand: s.on_hand, inbounds: s.inbounds,
          lead_time_days: s.lead_time_days, lead_time_std_days: s.lead_time_std_days,
          safety_stock_days: s.safety_stock_days,
          moq: s.moq, casepack: s.casepack, cycle_cover_days: s.cycle_cover_days,
        }),
      })
      // clear edits for this sku and refresh from server
      setEdits(e => { const c = { ...e }; delete c[s.msku]; return c })
      load()
    } finally {
      setSaving(false)
    }
  }

  const weightSum = weights.w7 + weights.w14 + weights.w30 + weights.w60 + weights.w90

  return (
    <div className="space-y-6">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Inventory Forecast</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Velocity auto-loaded from {source === 'shopify' ? 'Shopify MCF' : 'total FBA depletion (Amazon + MCF)'} —
            windows end yesterday. Enter on-hand &amp; lead time per SKU to get reorder recommendations.
          </p>
        </div>
        <div className="flex gap-2 items-center text-xs">
          <span className="text-gray-500">Reorder policy</span>
          <select
            value={policy}
            onChange={e => setPolicy(e.target.value as Policy)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200"
          >
            <option value="R_S">Order-up-to (R,S)</option>
            <option value="s_Q">Fixed lot (s,Q)</option>
            <option value="EOQ">EOQ</option>
          </select>
          <span className="text-gray-500 ml-2">Horizon</span>
          <select
            value={horizon}
            onChange={e => setHorizon(parseInt(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200"
          >
            {[90, 180, 270, 365].map(d => <option key={d} value={d}>{d}d</option>)}
          </select>
          <span className="text-gray-500 ml-2">Safety stock</span>
          <select
            value={safetyMethod}
            onChange={e => setSafetyMethod(e.target.value as SafetyMethod)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200"
          >
            <option value="days">Days-based</option>
            <option value="service">Service level (lead-time risk)</option>
          </select>
          {safetyMethod === 'service' && (
            <>
              <select
                value={serviceLvl}
                onChange={e => setServiceLvl(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200"
                title="Service level (chance of not stocking out during lead time)"
              >
                {['90', '95', '97', '99'].map(s => <option key={s} value={s}>{s}%</option>)}
              </select>
              <span className="text-gray-500" title="Daily demand variability as a fraction of velocity">CV</span>
              <input
                type="number" min={0} max={2} step={0.05}
                value={demandCv}
                onChange={e => setDemandCv(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-14 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200 text-center"
                title="Demand coefficient of variation (σ_d ÷ velocity)"
              />
            </>
          )}
        </div>
      </div>

      {/* ── Velocity weights ────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Velocity blend (weights)</h3>
          <span className={`text-xs ${Math.abs(weightSum - 1) < 0.001 ? 'text-gray-600' : 'text-amber-400'}`}>
            sum {weightSum.toFixed(2)} {Math.abs(weightSum - 1) >= 0.001 && '(auto-normalised)'}
          </span>
        </div>
        <div className="grid grid-cols-5 gap-3">
          {([['w7', '7d'], ['w14', '14d'], ['w30', '30d'], ['w60', '60d'], ['w90', '90d']] as const).map(([k, label]) => (
            <div key={k}>
              <label className="block text-xs text-gray-500 mb-1">{label}</label>
              <input
                type="number" min={0} max={1} step={0.05}
                value={weights[k]}
                onChange={e => setWeights(w => ({ ...w, [k]: Math.max(0, parseFloat(e.target.value) || 0) }))}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white text-center"
              />
            </div>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-500 text-sm">Loading…</div>
      ) : skus.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-center space-y-2">
          <p className="text-gray-300 text-sm font-medium">No velocity data yet</p>
          <p className="text-gray-600 text-xs max-w-sm">Populate fba_daily_shipped (MCF orders) first — then SKUs appear here.</p>
        </div>
      ) : (
        <>
          {/* ── SKU table ─────────────────────────────────────── */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                    <th className="px-4 py-3 font-medium">SKU</th>
                    <th className="px-3 py-3 font-medium text-right">Vel/day</th>
                    <th className="px-3 py-3 font-medium text-right">On-hand</th>
                    <th className="px-3 py-3 font-medium text-right">Days cover</th>
                    <th className="px-3 py-3 font-medium text-right">Stockout in</th>
                    <th className="px-3 py-3 font-medium">Reorder</th>
                    <th className="px-3 py-3 font-medium text-right">Suggested qty</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ sku, base, daysOfCover, analytics }) => {
                    const reorderNow = analytics.firstReorderDay != null && analytics.firstReorderDay <= 7
                    const cover = Number.isFinite(daysOfCover) ? Math.round(daysOfCover) : null
                    const isSel = selected === sku.msku
                    return (
                      <tr
                        key={sku.msku}
                        onClick={() => setSelected(isSel ? null : sku.msku)}
                        className={`border-b border-gray-800/60 cursor-pointer ${isSel ? 'bg-gray-800/50' : 'hover:bg-gray-800/30'}`}
                      >
                        <td className="px-4 py-3">
                          <div className="text-white">{sku.msku}</div>
                          {sku.asin && <div className="text-xs text-gray-600">{sku.asin}</div>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-200">{n2(base)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-300">{n0(sku.on_hand)}</td>
                        <td className={`px-3 py-3 text-right tabular-nums ${cover != null && cover < sku.lead_time_days ? 'text-rose-400' : 'text-gray-300'}`}>
                          {cover != null ? `${cover}d` : '∞'}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-gray-400">
                          {analytics.firstStockoutDay != null ? `${analytics.firstStockoutDay}d` : '—'}
                        </td>
                        <td className="px-3 py-3">
                          {sku.on_hand === 0 && !sku.has_params ? (
                            <span className="text-xs text-gray-600">set on-hand</span>
                          ) : reorderNow ? (
                            <span className="text-xs font-medium text-amber-400">⚠ reorder now</span>
                          ) : analytics.firstReorderDate ? (
                            <span className="text-xs text-gray-400">by {analytics.firstReorderDate.slice(5)}</span>
                          ) : (
                            <span className="text-xs text-emerald-400">ok</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-white font-medium">
                          {analytics.firstReorderQty > 0 ? n0(analytics.firstReorderQty) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Detail panel ──────────────────────────────────── */}
          {sel && (
            <div ref={detailRef} className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-white font-semibold">{sel.sku.msku}</h3>
                  <p className="text-xs text-gray-500">
                    Weighted velocity <span className="text-gray-300">{n2(sel.base)}/day</span> ·
                    blended from 7/14/30/60/90-day actuals
                  </p>
                </div>
                <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300 text-sm">✕</button>
              </div>

              {/* Scalar params */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {PARAM_FIELDS.map(f => (
                  <div key={f.key}>
                    <label className="block text-xs text-gray-500 mb-1">{f.label}</label>
                    <input
                      type="number" min={0}
                      value={(sel.sku as Sku)[f.key] as number}
                      onChange={e => setEdit(sel.sku.msku, f.key, Math.max(0, parseFloat(e.target.value) || 0))}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
                    />
                  </div>
                ))}
              </div>

              {/* Inbound shipments (multiple qty + arrival date) */}
              <div className="border-t border-gray-800 pt-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-gray-500 uppercase tracking-wider">Inbound shipments</label>
                  <button onClick={() => addInbound(sel.sku)} className="text-xs font-medium text-indigo-400 hover:text-indigo-300">
                    + Add shipment
                  </button>
                </div>
                {(sel.sku.inbounds ?? []).length === 0 ? (
                  <p className="text-xs text-gray-600">No inbound shipments. Add one to model incoming stock arriving on a date.</p>
                ) : (
                  <div className="space-y-2">
                    {(sel.sku.inbounds ?? []).map((sh, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          type="number" min={0} placeholder="qty"
                          value={sh.qty || ''}
                          onChange={e => updateInbound(sel.sku, i, 'qty', Math.max(0, parseFloat(e.target.value) || 0))}
                          className="w-28 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
                        />
                        <span className="text-xs text-gray-600">units arriving</span>
                        <input
                          type="date"
                          value={sh.date}
                          onChange={e => updateInbound(sel.sku, i, 'date', e.target.value)}
                          className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
                        />
                        <button onClick={() => removeInbound(sel.sku, i)}
                                className="text-gray-500 hover:text-rose-400 text-sm px-1" title="Remove">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => saveParams(sel.sku)}
                  disabled={saving}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white"
                >
                  {saving ? 'Saving…' : 'Save params'}
                </button>
                {edits[sel.sku.msku] && <span className="text-xs text-amber-400">unsaved changes — forecast updates live</span>}
              </div>

              {/* Safety stock readout */}
              <p className="text-xs text-gray-500">
                {safetyMethod === 'service' ? (
                  <>Safety stock <span className="text-gray-300">{n0(sel.safetyStock)} units</span> @ {serviceLvl}% service —
                    includes <span className="text-amber-400">±{sel.sku.lead_time_std_days}d lead-time risk</span> ·
                    reorder point <span className="text-gray-300">{n0(sel.rows[0]?.reorderPoint ?? 0)}</span></>
                ) : (
                  <>Safety stock <span className="text-gray-300">{n0(sel.safetyStock)} units</span> ({sel.sku.safety_stock_days} days,
                    no lead-time risk) · reorder point <span className="text-gray-300">{n0(sel.rows[0]?.reorderPoint ?? 0)}</span></>
                )}
              </p>

              {/* Analytics cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Card label="Reorder by"  value={sel.analytics.firstReorderDate ? sel.analytics.firstReorderDate.slice(5) : '—'}
                      sub={sel.analytics.firstReorderQty > 0 ? `${n0(sel.analytics.firstReorderQty)} units` : 'no reorder in horizon'}
                      accent={sel.analytics.firstReorderDay != null && sel.analytics.firstReorderDay <= 7 ? 'text-amber-400' : undefined} />
                <Card label="Stockout"    value={sel.analytics.firstStockoutDate ? sel.analytics.firstStockoutDate.slice(5) : 'none'}
                      sub={sel.analytics.firstStockoutDay != null ? `in ${sel.analytics.firstStockoutDay} days` : 'within horizon'}
                      accent={sel.analytics.firstStockoutDay != null ? 'text-rose-400' : 'text-emerald-400'} />
                <Card label="Service level" value={`${(sel.analytics.serviceLevel * 100).toFixed(0)}%`} sub="demand filled" />
                <Card label="Reorders"    value={String(sel.analytics.reorderCount)} sub={`${n0(sel.analytics.totalReordered)} units total`} />
              </div>

              {/* Projection chart */}
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={sel.rows.map(r => ({ ...r, reorderMarker: r.reorderTrigger ? r.inventory : null }))}
                    margin={{ top: 16, right: 12, bottom: 0, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }}
                           tickFormatter={(d: string) => d.slice(5)} minTickGap={40} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} width={40} />
                    <Tooltip
                      contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: '#9ca3af' }}
                      formatter={(v, name, item) => {
                        if (name === 'Reorder placed') {
                          const qty = (item?.payload as ForecastRow | undefined)?.reorderAmount ?? 0
                          return [`${n0(qty)} units ordered`, name]
                        }
                        return [n0(Number(v)), name]
                      }}
                    />
                    <Line type="monotone" dataKey="inventory" name="On-hand" stroke="#6366f1" dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="reorderPoint" name="Reorder point" stroke="#f59e0b" dot={false} strokeDasharray="4 3" strokeWidth={1.5} />
                    {/* Star at each reorder-trigger point */}
                    <Line type="monotone" dataKey="reorderMarker" name="Reorder placed" stroke="none"
                          isAnimationActive={false} dot={<ReorderStar />} activeDot={false} legendType="none" />
                    <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="2 2" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-gray-600">
                Indigo = projected on-hand · amber dashed = reorder point (lead-time demand + safety stock) ·
                <span className="text-amber-400"> ★ = reorder placed</span> (hover for the order qty).
                Each jump up is a shipment arriving — your inbound POs, plus auto-reorders landing after the lead time.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Amber star drawn at each reorder-trigger point (recharts custom dot)
function ReorderStar(props: { cx?: number; cy?: number; payload?: { reorderMarker?: number | null } }) {
  const { cx, cy, payload } = props
  if (cx == null || cy == null || payload?.reorderMarker == null) return null
  return (
    <text x={cx} y={cy} dy={5} textAnchor="middle" fontSize={16} fill="#f59e0b" stroke="#111827" strokeWidth={0.5}>★</text>
  )
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
      <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${accent ?? 'text-white'}`}>{value}</p>
      <p className="text-xs text-gray-600">{sub}</p>
    </div>
  )
}

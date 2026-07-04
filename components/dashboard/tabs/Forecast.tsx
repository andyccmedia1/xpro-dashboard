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
  seasonality: number[]   // per-SKU override: 12 monthly multipliers, or [] = use global
  demand_cv: number       // per-SKU demand CV override; 0 = use global
  history_days: number    // days the SKU has actually been selling; 0 = use full window
  last_forecasted: string | null   // 'YYYY-MM-DD' — when this SKU was last forecast/reviewed
  has_params: boolean
}

type Policy = 'R_S' | 's_Q' | 'EOQ'
type SafetyMethod = 'days' | 'service'

// Service-level → z-score
const Z: Record<string, number> = { '90': 1.28, '95': 1.65, '97': 1.88, '99': 2.33 }

// Seasonality: month labels, localStorage key, and a few starter curves (Jan..Dec)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const SEASON_PRESETS: Record<string, number[]> = {
  Flat:          [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  // E-commerce Q4 lift: soft Q1, build into Black Friday / December
  'Q4 holiday':  [0.85, 0.85, 0.9, 0.95, 1, 1, 1.05, 1, 1, 1.15, 1.6, 1.7],
  // Summer-peak (outdoor/seasonal goods)
  'Summer peak': [0.8, 0.8, 0.9, 1.1, 1.3, 1.5, 1.5, 1.3, 1.1, 0.9, 0.8, 0.8],
}

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

// A SKU looks recently-stocked (long windows diluted) when its 90-day units total
// equals a shorter window's — i.e. no sales that far back. history_days corrects it.
const isDiluted = (s: Sku) =>
  s.history_days === 0 && s.units_90 > 0 && (s.units_90 === s.units_30 || s.units_90 === s.units_60)

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
// 12 monthly multipliers (Jan..Dec). on=false → flat demand.
type Seasonality = { on: boolean; factors: number[] }

// Build the engine's month→multiplier map, normalised so the CURRENT month = 1.0.
// baseVelocity already reflects the current month's run-rate (trailing windows),
// so anchoring the current month to 1.0 keeps day-0 demand equal to baseVelocity
// and scales every other month relative to it.
function seasonalityMap(season: Seasonality, today: Date): Record<number, number> | undefined {
  if (!season.on) return undefined
  const cur = today.getMonth()                  // 0-11
  const anchor = season.factors[cur] || 1
  const map: Record<number, number> = {}
  for (let m = 0; m < 12; m++) map[m + 1] = (season.factors[m] || 0) / (anchor || 1)
  return map
}

function computeFor(sku: Sku, weights: PeriodWeights, horizon: number, policy: Policy, today: Date, safety: Safety, season: Seasonality) {
  // History correction: for a recently-stocked SKU, windows longer than its
  // selling history are diluted by pre-stock zero-demand days. Divide by the
  // actual days selling instead of the full window so the rate isn't dragged
  // down (units_N / min(N, history_days)). history_days = 0 → no correction.
  const hd = sku.history_days
  const ev = (unitsN: number, vN: number, N: number) => (hd > 0 && hd < N ? unitsN / hd : vN)
  const base = weightedVelocity({
    v7:  ev(sku.units_7,  sku.v7,  7),
    v14: ev(sku.units_14, sku.v14, 14),
    v30: ev(sku.units_30, sku.v30, 30),
    v60: ev(sku.units_60, sku.v60, 60),
    v90: ev(sku.units_90, sku.v90, 90),
  }, weights)
  const deliveries = (sku.inbounds ?? [])
    .map(s => ({ day: inboundDayOffset(s.date, today), qty: s.qty }))
    .filter((d): d is { day: number; qty: number } => d.day != null && d.qty > 0)
  const useService = safety.method === 'service'
  const cv = sku.demand_cv > 0 ? sku.demand_cv : safety.cv   // per-SKU override else global
  const sigmaD = cv * base          // daily demand std as a fraction of velocity
  // Per-SKU curve overrides the global one; global toggle still gates whether any applies.
  const effFactors = sku.seasonality?.length === 12 ? sku.seasonality : season.factors
  const seasonalityFactors = seasonalityMap({ on: season.on, factors: effFactors }, today)
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
    useSeasonality: season.on,
    seasonalityFactors,
  })
  const analytics = analyzeForecast(rows)
  const daysOfCover = base > 0 ? sku.on_hand / base : Infinity
  // Safety stock figure for display (mirrors the engine)
  const safetyStock = useService
    ? safety.z * Math.sqrt(sigmaD * sigmaD * sku.lead_time_days + base * base * sku.lead_time_std_days * sku.lead_time_std_days)
    : base * sku.safety_stock_days
  return { base, rows, analytics, daysOfCover, safetyStock, cv }
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

  // ── Global seasonality: 12 monthly multipliers (persisted server-side) ──────
  const [seasonOn,      setSeasonOn]      = useState(false)
  const [seasonFactors, setSeasonFactors] = useState<number[]>(() => Array(12).fill(1))
  const season: Seasonality = useMemo(() => ({ on: seasonOn, factors: seasonFactors }), [seasonOn, seasonFactors])
  const setMonth = (i: number, v: number) =>
    setSeasonFactors(f => f.map((x, idx) => (idx === i ? Math.max(0, v) : x)))

  // ── Global forecast settings (blend + policy/horizon/safety + global
  //    seasonality) persisted to the forecast_settings table. Auto-saves 800ms
  //    after the last change (plus a manual Save button), so tabbing away
  //    never loses changes. Failures are surfaced, never silent. "Dirty" is a
  //    snapshot compare, so "✓ Saved" is accurate without wiring every
  //    change handler.
  const currentSnapshot = JSON.stringify({
    weights, horizon, policy, safetyMethod, serviceLvl, demandCv, seasonOn, seasonFactors,
  })
  const [savedSnapshot,  setSavedSnapshot]  = useState<string | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsErr,    setSettingsErr]    = useState('')
  const settingsLoaded = useRef(false)   // don't auto-save until the initial GET settles
  const settingsSaved = savedSnapshot !== null && savedSnapshot === currentSnapshot

  // Load persisted settings once on mount
  useEffect(() => {
    fetch('/api/forecast/settings')
      .then(r => r.json())
      .then(({ settings: v, error }) => {
        if (error) { setSettingsErr(String(error)); return }
        if (!v) return
        const nWeights  = { ...DEFAULT_WEIGHTS, ...(v.weights ?? {}) }
        const nHorizon  = v.horizon ? Number(v.horizon) : 180
        const nPolicy   = (v.policy ?? 'R_S') as Policy
        const nMethod   = (v.safety_method ?? 'days') as SafetyMethod
        const nSvc      = v.service_lvl ? String(v.service_lvl) : '95'
        const nCv       = typeof v.demand_cv === 'number' ? v.demand_cv : 0.4
        const nSeasonOn = !!v.seasonality_on
        const nFactors  = Array.isArray(v.seasonality) && v.seasonality.length === 12
          ? v.seasonality.map(Number) : Array(12).fill(1)
        setWeights(nWeights); setHorizon(nHorizon); setPolicy(nPolicy)
        setSafetyMethod(nMethod); setServiceLvl(nSvc); setDemandCv(nCv)
        setSeasonOn(nSeasonOn); setSeasonFactors(nFactors)
        setSavedSnapshot(JSON.stringify({
          weights: nWeights, horizon: nHorizon, policy: nPolicy, safetyMethod: nMethod,
          serviceLvl: nSvc, demandCv: nCv, seasonOn: nSeasonOn, seasonFactors: nFactors,
        }))
      })
      .catch(() => { /* defaults stand */ })
      .finally(() => { settingsLoaded.current = true })
  }, [])

  const saveSettings = useCallback(async () => {
    const snap = currentSnapshot
    setSettingsSaving(true)
    setSettingsErr('')
    try {
      const res = await fetch('/api/forecast/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weights, horizon, policy, safety_method: safetyMethod, service_lvl: serviceLvl,
          demand_cv: demandCv, seasonality_on: seasonOn, seasonality: seasonFactors,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${res.status}`)
      }
      setSavedSnapshot(snap)
    } catch (e) {
      setSettingsErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSettingsSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSnapshot])

  // Auto-save: 800ms after the last settings change (once the initial load settled)
  useEffect(() => {
    if (!settingsLoaded.current) return
    if (savedSnapshot === currentSnapshot) return
    const t = setTimeout(() => { saveSettings() }, 800)
    return () => clearTimeout(t)
  }, [currentSnapshot, savedSnapshot, saveSettings])

  const [edits,    setEdits]    = useState<Record<string, Partial<Sku>>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveErr,   setSaveErr]   = useState('')
  const [cvBusy,    setCvBusy]    = useState<string | null>(null)   // msku currently calculating CV
  const [cvInfo,    setCvInfo]    = useState<Record<string, { cv: number; days: number; mean: number; std: number } | string>>({})
  const [histBusy,  setHistBusy]  = useState<string | null>(null)   // msku currently detecting history
  const [histInfo,  setHistInfo]  = useState<Record<string, { history_days: number; selling_days: number; first_sale: string | null } | string>>({})
  const detailRef = useRef<HTMLDivElement>(null)

  // Scroll the detail panel into view when a SKU is selected (it renders below the table)
  useEffect(() => {
    setSaveState('idle')
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
      return { sku: eff, ...computeFor(eff, weights, horizon, policy, today, safety, season) }
    })
  }, [skus, edits, weights, horizon, policy, today, effective, safety, season])

  // Sort: most urgent first (fewest days of cover)
  const rows = useMemo(
    () => [...computed].sort((a, b) => a.daysOfCover - b.daysOfCover),
    [computed],
  )

  const sel = computed.find(c => c.sku.msku === selected) ?? null
  const selCustomSeason = (sel?.sku.seasonality?.length ?? 0) === 12

  function setEdit(msku: string, key: keyof Sku, value: number | string | null | Inbound[] | number[]) {
    setEdits(e => ({ ...e, [msku]: { ...e[msku], [key]: value } }))
    setSaveState('idle')
  }
  // Inbound shipment list editors
  const setInbounds = (s: Sku, list: Inbound[]) => setEdit(s.msku, 'inbounds', list)
  const addInbound    = (s: Sku) => setInbounds(s, [...(s.inbounds ?? []), { date: '', qty: 0 }])
  const removeInbound = (s: Sku, i: number) => setInbounds(s, (s.inbounds ?? []).filter((_, idx) => idx !== i))
  const updateInbound = (s: Sku, i: number, field: keyof Inbound, value: string | number) =>
    setInbounds(s, (s.inbounds ?? []).map((sh, idx) => (idx === i ? { ...sh, [field]: value } : sh)))

  // Per-SKU seasonality override editors (empty [] = inherit the global curve)
  const enableSkuSeason = (s: Sku) => setEdit(s.msku, 'seasonality', [...seasonFactors])   // seed from global
  const clearSkuSeason  = (s: Sku) => setEdit(s.msku, 'seasonality', [])
  const updateSkuSeason = (s: Sku, i: number, v: number) =>
    setEdit(s.msku, 'seasonality',
      (s.seasonality?.length === 12 ? s.seasonality : seasonFactors).map((x, idx) => (idx === i ? Math.max(0, v) : x)))

  // Compute this SKU's demand CV from its own daily history (Amazon + MCF) and
  // set it as a per-SKU override (auto-saves via setEdit).
  async function calcCv(s: Sku) {
    setCvBusy(s.msku)
    try {
      const r = await fetch(`/api/forecast/cv?msku=${encodeURIComponent(s.msku)}`)
      const d = await r.json()
      if (!r.ok) {
        setCvInfo(prev => ({ ...prev, [s.msku]: d.error === 'not enough daily history'
          ? `Not enough history (${d.days ?? 0} days)` : (d.error || 'Could not calculate') }))
      } else {
        setEdit(s.msku, 'demand_cv', d.cv)
        setCvInfo(prev => ({ ...prev, [s.msku]: { cv: d.cv, days: d.days, mean: d.mean, std: d.std } }))
      }
    } catch {
      setCvInfo(prev => ({ ...prev, [s.msku]: 'Could not calculate' }))
    } finally {
      setCvBusy(null)
    }
  }

  // Detect how long this SKU has actually been selling (first sale → yesterday)
  // and set it as history_days, which corrects diluted 60/90-day windows.
  async function detectHistory(s: Sku) {
    setHistBusy(s.msku)
    try {
      const r = await fetch(`/api/forecast/cv?msku=${encodeURIComponent(s.msku)}`)
      const d = await r.json()
      if (!r.ok || d.history_days == null) {
        setHistInfo(prev => ({ ...prev, [s.msku]: d.error === 'not enough daily history'
          ? `Not enough history (${d.days ?? 0} days)` : (d.error || 'Could not detect') }))
      } else {
        setEdit(s.msku, 'history_days', d.history_days)
        setHistInfo(prev => ({ ...prev, [s.msku]: { history_days: d.history_days, selling_days: d.selling_days, first_sale: d.first_sale } }))
      }
    } catch {
      setHistInfo(prev => ({ ...prev, [s.msku]: 'Could not detect' }))
    } finally {
      setHistBusy(null)
    }
  }

  // Refs so saveSku always reads the latest state without being re-created
  // (a stable identity keeps the auto-save effect from looping).
  const editsRef = useRef(edits); editsRef.current = edits
  const skusRef  = useRef(skus);  skusRef.current  = skus

  // Persist one SKU's params to the DB. The merged values are folded into the
  // base SKU on a confirmed 200, and the pending edits are cleared ONLY if the
  // user hasn't typed since the snapshot — so nothing is ever lost. On failure
  // the edits are left in place and the error is surfaced (the old bug silently
  // cleared inputs and reloaded blank rows even when the save had 500'd, e.g. a
  // missing column).
  const saveSku = useCallback(async (msku: string) => {
    const base = skusRef.current.find(s => s.msku === msku)
    if (!base) return
    const snapshot = editsRef.current[msku] ?? {}
    const merged = { ...base, ...snapshot } as Sku
    setSaveState('saving')
    setSaveErr('')
    try {
      const res = await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msku: merged.msku,
          on_hand: merged.on_hand, inbounds: merged.inbounds,
          lead_time_days: merged.lead_time_days, lead_time_std_days: merged.lead_time_std_days,
          safety_stock_days: merged.safety_stock_days,
          moq: merged.moq, casepack: merged.casepack, cycle_cover_days: merged.cycle_cover_days,
          seasonality: merged.seasonality, demand_cv: merged.demand_cv,
          history_days: merged.history_days, last_forecasted: merged.last_forecasted,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `Save failed (HTTP ${res.status})`)
      }
      // Fold saved values into the base row (display unchanged; reload-safe).
      setSkus(prev => prev.map(x => x.msku === msku ? { ...x, ...snapshot, has_params: true } : x))
      // Clear pending edits only if untouched during the save (else a follow-up
      // auto-save catches the newer keystrokes).
      setEdits(e => { if (e[msku] === snapshot) { const c = { ...e }; delete c[msku]; return c } return e })
      setSaveState('saved')
    } catch (e) {
      setSaveState('error')
      setSaveErr(e instanceof Error ? e.message : 'Save failed')
    }
  }, [])

  // Auto-save: 800 ms after the last edit to the selected SKU, persist it.
  // Edits live in component state keyed by msku, so switching SKUs never loses
  // them in-session; this makes the persistence durable across reloads too.
  useEffect(() => {
    if (!selected) return
    const pending = edits[selected]
    if (!pending || Object.keys(pending).length === 0) return
    const t = setTimeout(() => { saveSku(selected) }, 800)
    return () => clearTimeout(t)
  }, [edits, selected, saveSku])

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
          <div className="flex items-center gap-3">
            <span className={`text-xs ${Math.abs(weightSum - 1) < 0.001 ? 'text-gray-600' : 'text-amber-400'}`}>
              sum {weightSum.toFixed(2)} {Math.abs(weightSum - 1) >= 0.001 && '(auto-normalised)'}
            </span>
            {settingsErr && (
              <span className="text-xs text-rose-400" title={settingsErr}>⚠ Settings not saving: {settingsErr}</span>
            )}
            <button
              onClick={saveSettings}
              disabled={settingsSaved || settingsSaving}
              title="Settings auto-save as you change them; this forces a save now. Stored in the database — restored on every device."
              className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-700 text-indigo-400 hover:bg-gray-800 hover:text-indigo-300 disabled:border-transparent disabled:hover:bg-transparent disabled:text-emerald-400"
            >
              {settingsSaving ? 'Saving…' : settingsSaved ? '✓ Saved' : 'Save settings'}
            </button>
          </div>
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

      {/* ── Seasonality (monthly demand curve) ──────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={seasonOn}
              onChange={e => setSeasonOn(e.target.checked)}
              className="accent-indigo-500 w-4 h-4"
            />
            <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Seasonality</span>
          </label>
          <div className="flex items-center gap-1.5">
            {Object.keys(SEASON_PRESETS).map(name => (
              <button
                key={name}
                onClick={() => { setSeasonFactors([...SEASON_PRESETS[name]]); if (name !== 'Flat') setSeasonOn(true) }}
                className="text-xs px-2 py-1 rounded-md border border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Monthly demand multiplier — <span className="text-gray-400">1.0 = your current run-rate</span>.
          {' '}Normalised so <span className="text-amber-400">{MONTHS[today.getMonth()]}</span> (the period your velocity is measured in) anchors to 1.0;
          other months scale relative to it. Applied to reorder timing &amp; stockout dates.
        </p>
        <div className={`grid grid-cols-6 sm:grid-cols-12 gap-2 ${seasonOn ? '' : 'opacity-40 pointer-events-none'}`}>
          {seasonFactors.map((f, i) => {
            const maxF = Math.max(1, ...seasonFactors)
            const isCur = i === today.getMonth()
            return (
              <div key={i} className="flex flex-col items-center gap-1">
                <div className="h-10 w-full flex items-end justify-center">
                  <div
                    className={`w-3 rounded-t ${isCur ? 'bg-amber-400' : 'bg-indigo-500/70'}`}
                    style={{ height: `${Math.max(2, (f / maxF) * 40)}px` }}
                  />
                </div>
                <label className={`text-[10px] ${isCur ? 'text-amber-400' : 'text-gray-500'}`}>{MONTHS[i]}</label>
                <input
                  type="number" min={0} max={5} step={0.05}
                  value={f}
                  onChange={e => setMonth(i, parseFloat(e.target.value) || 0)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-1 text-xs text-white text-center"
                />
              </div>
            )
          })}
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
                    <th className="px-3 py-3 font-medium text-right">Last forecast</th>
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
                          <div className="text-white flex items-center gap-1.5">
                            {sku.msku}
                            {sku.seasonality?.length === 12 && (
                              <span className="text-emerald-400 text-xs" title="Custom seasonality curve">✦</span>
                            )}
                            {isDiluted(sku) && (
                              <span className="text-amber-400 text-[10px] font-medium px-1 rounded bg-amber-400/10" title="Recently stocked — 60/90-day windows diluted. Open and set sales history.">NEW</span>
                            )}
                          </div>
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
                        <td className="px-3 py-3 text-right tabular-nums text-xs text-gray-400">
                          {sku.last_forecasted ?? <span className="text-gray-600">—</span>}
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
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <label className="block text-[10px] text-gray-500 uppercase tracking-wider">Last forecasted</label>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <input
                        type="date"
                        value={sel.sku.last_forecasted ?? ''}
                        onChange={e => setEdit(sel.sku.msku, 'last_forecasted', e.target.value || null)}
                        className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white"
                      />
                      <button
                        onClick={() => setEdit(sel.sku.msku, 'last_forecasted', new Date().toLocaleDateString('en-CA'))}
                        className="text-xs font-medium text-indigo-400 hover:text-indigo-300 px-1.5 py-1 rounded border border-gray-700 hover:bg-gray-800"
                        title="Set to today's date"
                      >
                        Today
                      </button>
                    </div>
                  </div>
                  <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300 text-sm self-start">✕</button>
                </div>
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

              {/* Sales history correction — fixes diluted windows on recently-stocked SKUs */}
              <div className="border-t border-gray-800 pt-4">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                  <label className="text-xs text-gray-500 uppercase tracking-wider">Sales history · this SKU</label>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => detectHistory(sel.sku)}
                      disabled={histBusy === sel.sku.msku}
                      className="text-xs font-medium text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                    >
                      {histBusy === sel.sku.msku ? 'Detecting…' : '↻ Detect from sales'}
                    </button>
                    {sel.sku.history_days > 0 && (
                      <button
                        onClick={() => { setEdit(sel.sku.msku, 'history_days', 0); setHistInfo(prev => { const c = { ...prev }; delete c[sel.sku.msku]; return c }) }}
                        className="text-xs text-gray-500 hover:text-rose-400"
                      >
                        use full window
                      </button>
                    )}
                  </div>
                </div>
                {isDiluted(sel.sku) && (
                  <p className="text-xs text-amber-400 mb-2">
                    ⚠ Looks recently stocked — no sales before ~{sel.sku.units_90 === sel.sku.units_30 ? 30 : 60} days ago,
                    so the 60/90-day windows are diluted and under-state velocity. Click <span className="text-amber-300">Detect from sales</span> to correct it.
                  </p>
                )}
                <div className="flex items-center gap-3 flex-wrap">
                  <input
                    type="number" min={0}
                    value={sel.sku.history_days || ''}
                    placeholder="full"
                    onChange={e => setEdit(sel.sku.msku, 'history_days', Math.max(0, parseInt(e.target.value) || 0))}
                    className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-center"
                  />
                  <span className="text-xs text-gray-500">
                    {sel.sku.history_days > 0 ? `days selling — windows capped to ${sel.sku.history_days}d` : 'days selling (blank = use full 90-day window)'}
                  </span>
                  {(() => {
                    const info = histInfo[sel.sku.msku]
                    if (!info) return null
                    if (typeof info === 'string') return <span className="text-xs text-amber-400">{info}</span>
                    return <span className="text-xs text-gray-400">First sale {info.first_sale} · {info.history_days}d ago · {info.selling_days} days with sales</span>
                  })()}
                </div>
                <p className="text-xs text-gray-600 mt-1">
                  Divides each window by <span className="text-gray-400">min(window, history)</span> instead of the full window — so a SKU that came into stock N days ago isn&apos;t averaged against the empty days before it.
                </p>
              </div>

              {/* Demand variability (CV) — used by the service-level safety method */}
              <div className="border-t border-gray-800 pt-4">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                  <label className="text-xs text-gray-500 uppercase tracking-wider">Demand variability · CV</label>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => calcCv(sel.sku)}
                      disabled={cvBusy === sel.sku.msku}
                      className="text-xs font-medium text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                    >
                      {cvBusy === sel.sku.msku ? 'Calculating…' : '↻ Calculate from history'}
                    </button>
                    {sel.sku.demand_cv > 0 && (
                      <button
                        onClick={() => { setEdit(sel.sku.msku, 'demand_cv', 0); setCvInfo(prev => { const c = { ...prev }; delete c[sel.sku.msku]; return c }) }}
                        className="text-xs text-gray-500 hover:text-rose-400"
                      >
                        use global
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <input
                    type="number" min={0} max={3} step={0.05}
                    value={sel.sku.demand_cv > 0 ? sel.sku.demand_cv : demandCv}
                    onChange={e => setEdit(sel.sku.msku, 'demand_cv', Math.max(0, parseFloat(e.target.value) || 0))}
                    className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-center"
                  />
                  <span className="text-xs text-gray-500">
                    {sel.sku.demand_cv > 0 ? 'custom (this SKU)' : `inherited from global (${demandCv})`}
                  </span>
                  {(() => {
                    const info = cvInfo[sel.sku.msku]
                    if (!info) return null
                    if (typeof info === 'string') return <span className="text-xs text-amber-400">{info}</span>
                    return <span className="text-xs text-gray-400">From {info.days} days: mean {n0(info.mean)}/day · σ {n0(info.std)}/day → CV {info.cv}</span>
                  })()}
                </div>
                <p className="text-xs text-gray-600 mt-1">
                  Daily demand swing as a fraction of average (Amazon + MCF). Used by the <span className="text-gray-400">Service-level</span> safety method
                  {safetyMethod !== 'service' ? ' — currently off; switch “Safety stock” to Service level to apply' : ''}.
                </p>
              </div>

              {/* Per-SKU seasonality override */}
              <div className="border-t border-gray-800 pt-4">
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                  <label className="text-xs text-gray-500 uppercase tracking-wider">Seasonality · this SKU</label>
                  {selCustomSeason ? (
                    <button onClick={() => clearSkuSeason(sel.sku)} className="text-xs text-gray-400 hover:text-rose-400">
                      Clear → use global curve
                    </button>
                  ) : (
                    <button onClick={() => enableSkuSeason(sel.sku)} className="text-xs font-medium text-emerald-400 hover:text-emerald-300">
                      + Custom curve for this SKU
                    </button>
                  )}
                </div>
                {!selCustomSeason ? (
                  <p className="text-xs text-gray-600">
                    Using the global curve{seasonOn ? '' : ' (master toggle currently off)'}. Add a custom curve to override demand seasonality for just this SKU.
                  </p>
                ) : (
                  <>
                    {!seasonOn && (
                      <p className="text-xs text-amber-400 mb-2">
                        Master Seasonality toggle is off — turn it on above for this curve to affect the forecast.
                      </p>
                    )}
                    <div className="grid grid-cols-6 sm:grid-cols-12 gap-2">
                      {sel.sku.seasonality.map((f, i) => {
                        const maxF = Math.max(1, ...sel.sku.seasonality)
                        const isCur = i === today.getMonth()
                        return (
                          <div key={i} className="flex flex-col items-center gap-1">
                            <div className="h-8 w-full flex items-end justify-center">
                              <div
                                className={`w-3 rounded-t ${isCur ? 'bg-amber-400' : 'bg-emerald-500/70'}`}
                                style={{ height: `${Math.max(2, (f / maxF) * 32)}px` }}
                              />
                            </div>
                            <label className={`text-[10px] ${isCur ? 'text-amber-400' : 'text-gray-500'}`}>{MONTHS[i]}</label>
                            <input
                              type="number" min={0} max={5} step={0.05}
                              value={f}
                              onChange={e => updateSkuSeason(sel.sku, i, parseFloat(e.target.value) || 0)}
                              className="w-full bg-gray-800 border border-gray-700 rounded px-1 py-1 text-xs text-white text-center"
                            />
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => saveSku(sel.sku.msku)}
                  disabled={saveState === 'saving'}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white"
                >
                  {saveState === 'saving' ? 'Saving…' : 'Save now'}
                </button>
                {saveState === 'saving' && <span className="text-xs text-gray-400">Auto-saving…</span>}
                {saveState === 'saved'  && <span className="text-xs text-emerald-400">✓ Saved — will reload next time</span>}
                {saveState === 'error'  && <span className="text-xs text-rose-400">⚠ Save failed: {saveErr}</span>}
                {saveState === 'idle' && edits[sel.sku.msku] &&
                  <span className="text-xs text-amber-400">editing… auto-saves shortly</span>}
              </div>

              {/* Safety stock readout */}
              <p className="text-xs text-gray-500">
                {safetyMethod === 'service' ? (
                  <>Safety stock <span className="text-gray-300">{n0(sel.safetyStock)} units</span> @ {serviceLvl}% service ·
                    CV <span className="text-gray-300">{n2(sel.cv)}</span>{sel.sku.demand_cv > 0 && <span className="text-gray-600"> (custom)</span>} —
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

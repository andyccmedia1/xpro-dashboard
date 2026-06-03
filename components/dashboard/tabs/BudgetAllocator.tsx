'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────
type Campaign = {
  campaign_id: string
  campaign_name: string
  ad_product: string
  impressions: number
  clicks: number
  cost: number
  orders: number
  sales: number
  active_days: number
  capped_days: number
  current_budget: number | null
}

type Bucket = 'starved' | 'satisfied' | 'leak' | 'test'

type Derived = Campaign & {
  acos: number | null
  roas: number | null
  avg_daily_spend: number
  capped_rate: number
  is_capped: boolean
  bucket: Bucket
  recommended_budget: number | null
  delta: number | null
}

// ── Bucket metadata ───────────────────────────────────────────────────────────
const BUCKETS: Record<Bucket, { label: string; action: string; color: string; bg: string; order: number }> = {
  starved:   { label: 'Starved winner', action: 'Raise budget', color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-600/30',  order: 0 },
  satisfied: { label: 'Satisfied',      action: 'Hold',         color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-600/30', order: 1 },
  leak:      { label: 'Leak',           action: 'Fix / cut',    color: 'text-rose-400',    bg: 'bg-rose-500/10 border-rose-600/30',     order: 2 },
  test:      { label: 'Testing',        action: 'Monitor',      color: 'text-gray-400',    bg: 'bg-gray-500/10 border-gray-600/30',     order: 3 },
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const usd = (v: number | null) =>
  v == null ? '—' : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`
const usdExact = (v: number | null) =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`)

function classify(c: Campaign, targetAcos: number): Derived {
  const acos = c.sales > 0 ? c.cost / c.sales : null
  const roas = c.cost > 0 ? c.sales / c.cost : null
  const avg_daily_spend = c.active_days > 0 ? c.cost / c.active_days : 0
  const capped_rate = c.active_days > 0 ? c.capped_days / c.active_days : 0
  const is_capped = c.current_budget != null && c.current_budget > 0 && capped_rate >= 0.4

  const hasData = c.clicks >= 5 || c.sales > 0
  const profitable = acos != null && acos <= targetAcos

  let bucket: Bucket
  if (!hasData) bucket = 'test'
  else if (profitable && is_capped) bucket = 'starved'
  else if (profitable) bucket = 'satisfied'
  else bucket = 'leak'

  // Recommended daily budget
  let recommended_budget: number | null = null
  const cur = c.current_budget
  if (bucket === 'starved') {
    recommended_budget = Math.max((cur ?? 0) * 1.5, avg_daily_spend * 2)
  } else if (bucket === 'satisfied') {
    recommended_budget = Math.max(cur ?? 0, avg_daily_spend * 1.3)
  } else if (bucket === 'leak') {
    recommended_budget = cur != null && cur > 0 ? cur * 0.7 : avg_daily_spend
  } else {
    recommended_budget = cur
  }
  if (recommended_budget != null) recommended_budget = Math.round(recommended_budget)

  const delta = recommended_budget != null && cur != null ? recommended_budget - cur : null

  return { ...c, acos, roas, avg_daily_spend, capped_rate, is_capped, bucket, recommended_budget, delta }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function BudgetAllocator() {
  const [periodDays, setPeriodDays] = useState<7 | 14 | 30>(30)
  const [targetAcos, setTargetAcos] = useState(0.35)
  const [campaigns,  setCampaigns]  = useState<Campaign[]>([])
  const [loading,    setLoading]    = useState(true)
  const [filter,     setFilter]     = useState<Bucket | 'all'>('all')

  const load = useCallback((days: number) => {
    setLoading(true)
    fetch(`/api/campaigns?days=${days}`)
      .then(r => r.json())
      .then(d => { setCampaigns(d.campaigns ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { load(periodDays) }, [periodDays, load])

  const derived = useMemo(
    () => campaigns.map(c => classify(c, targetAcos))
      .sort((a, b) => BUCKETS[a.bucket].order - BUCKETS[b.bucket].order || b.cost - a.cost),
    [campaigns, targetAcos],
  )

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { starved: 0, satisfied: 0, leak: 0, test: 0 }
    for (const d of derived) c[d.bucket]++
    return c
  }, [derived])

  const totals = useMemo(() => {
    const spend = derived.reduce((s, d) => s + d.cost, 0)
    const sales = derived.reduce((s, d) => s + d.sales, 0)
    const starvedExtra = derived
      .filter(d => d.bucket === 'starved' && d.delta != null)
      .reduce((s, d) => s + (d.delta ?? 0), 0)
    return { spend, sales, acos: sales > 0 ? spend / sales : null, starvedExtra }
  }, [derived])

  const rows = filter === 'all' ? derived : derived.filter(d => d.bucket === filter)

  return (
    <div className="space-y-6">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Budget Allocator</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Per-campaign performance ranked into action buckets — recommendations only, nothing is changed on Amazon.
          </p>
        </div>

        <div className="flex gap-2 flex-wrap items-center">
          {/* Target ACOS */}
          <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-1.5">
            <span className="text-xs text-gray-400">Target ACOS</span>
            <input
              type="number"
              min={1}
              max={100}
              value={Math.round(targetAcos * 100)}
              onChange={e => setTargetAcos(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)) / 100)}
              className="w-12 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-sm text-white text-center focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <span className="text-xs text-gray-400">%</span>
          </div>

          {/* Period */}
          <div className="flex bg-gray-800 rounded-lg p-0.5">
            {([7, 14, 30] as const).map(d => (
              <button
                key={d}
                onClick={() => setPeriodDays(d)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  periodDays === d ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64 text-gray-500 text-sm">Loading campaigns…</div>
      ) : campaigns.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-center space-y-2">
          <p className="text-gray-300 text-sm font-medium">No campaign data yet</p>
          <p className="text-gray-600 text-xs max-w-sm">
            Run the workflow with “campaigns_only” checked to populate campaign_daily, then come back here.
          </p>
        </div>
      ) : (
        <>
          {/* ── Summary cards ─────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card label="Spend"        value={usdExact(totals.spend)} sub={`${periodDays}d · ${derived.length} campaigns`} />
            <Card label="Blended ACOS" value={pct(totals.acos)}       sub={`Target ${Math.round(targetAcos * 100)}%`} />
            <Card label="Starved winners" value={String(counts.starved)} sub="Profitable but capped" accent="text-amber-400" />
            <Card label="Suggested budget lift" value={`+${usdExact(totals.starvedExtra)}/day`} sub="Across starved winners" accent="text-amber-400" />
          </div>

          {/* ── Bucket filter chips ───────────────────────────── */}
          <div className="flex gap-2 flex-wrap">
            <Chip active={filter === 'all'} onClick={() => setFilter('all')} label={`All (${derived.length})`} />
            {(Object.keys(BUCKETS) as Bucket[]).map(b => (
              <Chip
                key={b}
                active={filter === b}
                onClick={() => setFilter(b)}
                label={`${BUCKETS[b].label} (${counts[b]})`}
                color={BUCKETS[b].color}
              />
            ))}
          </div>

          {/* ── Table ─────────────────────────────────────────── */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                    <th className="px-4 py-3 font-medium">Campaign</th>
                    <th className="px-3 py-3 font-medium text-right">Spend</th>
                    <th className="px-3 py-3 font-medium text-right">Sales</th>
                    <th className="px-3 py-3 font-medium text-right">ACOS</th>
                    <th className="px-3 py-3 font-medium text-right">Orders</th>
                    <th className="px-3 py-3 font-medium text-center">Capped</th>
                    <th className="px-3 py-3 font-medium text-right">Budget</th>
                    <th className="px-3 py-3 font-medium text-right">Suggested</th>
                    <th className="px-4 py-3 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(d => (
                    <tr key={d.campaign_id} className="border-b border-gray-800/60 hover:bg-gray-800/30">
                      <td className="px-4 py-3 max-w-xs">
                        <div className="text-white truncate" title={d.campaign_name}>{d.campaign_name}</div>
                        <div className="text-xs text-gray-600">{d.ad_product}</div>
                      </td>
                      <td className="px-3 py-3 text-right text-gray-200">{usd(d.cost)}</td>
                      <td className="px-3 py-3 text-right text-gray-200">{usd(d.sales)}</td>
                      <td className={`px-3 py-3 text-right ${d.acos != null && d.acos <= targetAcos ? 'text-emerald-400' : d.acos != null ? 'text-rose-400' : 'text-gray-600'}`}>
                        {pct(d.acos)}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-300">{d.orders}</td>
                      <td className="px-3 py-3 text-center">
                        {d.current_budget == null ? (
                          <span className="text-gray-600 text-xs">n/a</span>
                        ) : d.is_capped ? (
                          <span className="text-amber-400 text-xs font-medium">{pct(d.capped_rate)}</span>
                        ) : (
                          <span className="text-gray-600 text-xs">{pct(d.capped_rate)}</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-300">{usdExact(d.current_budget)}</td>
                      <td className="px-3 py-3 text-right">
                        <span className="text-white font-medium">{usdExact(d.recommended_budget)}</span>
                        {d.delta != null && d.delta !== 0 && (
                          <span className={`ml-1 text-xs ${d.delta > 0 ? 'text-amber-400' : 'text-rose-400'}`}>
                            {d.delta > 0 ? '↑' : '↓'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${BUCKETS[d.bucket].bg} ${BUCKETS[d.bucket].color}`}>
                          {BUCKETS[d.bucket].action}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── How to read this ──────────────────────────────── */}
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 text-xs text-gray-400 space-y-1.5">
            <p><span className="text-amber-400 font-medium">Starved winner</span> — profitable (ACOS ≤ target) and hitting budget ≥ 40% of active days. These are leaving profit on the table; raise their budgets first.</p>
            <p><span className="text-emerald-400 font-medium">Satisfied</span> — profitable but not budget-limited. Already capturing demand; keep a small buffer so they never cap.</p>
            <p><span className="text-rose-400 font-medium">Leak</span> — ACOS above target. Fix bids/targeting before adding budget.</p>
            <p><span className="text-gray-400 font-medium">Testing</span> — too little data (&lt;5 clicks, no sales) to judge yet.</p>
            <p className="text-gray-600 pt-1">“Capped %” = share of active days the campaign spent ≥92% of its daily budget. Budget data is available for Sponsored Products only.</p>
          </div>
        </>
      )}
    </div>
  )
}

// ── Small UI pieces ───────────────────────────────────────────────────────────
function Card({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wider font-medium">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${accent ?? 'text-white'}`}>{value}</p>
      <p className="text-xs text-gray-600 mt-0.5">{sub}</p>
    </div>
  )
}

function Chip({ active, onClick, label, color }: { active: boolean; onClick: () => void; label: string; color?: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
        active
          ? 'bg-gray-700 border-gray-600 text-white'
          : `bg-gray-900 border-gray-800 hover:border-gray-700 ${color ?? 'text-gray-400'}`
      }`}
    >
      {label}
    </button>
  )
}

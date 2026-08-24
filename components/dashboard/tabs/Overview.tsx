'use client'

import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

interface Props {
  start: string
  end: string
  brand?: string
}

async function fetchOverview(start: string, end: string, brand: string) {
  const res = await fetch(`/api/overview?start=${start}&end=${end}&brand=${brand}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

const fmt$ = (v: number | null) =>
  v == null ? '—' : '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 })

const fmtX = (v: number | null) =>
  v == null ? '—' : v.toFixed(2) + 'x'

const fmtPct = (v: number | null) =>
  v == null ? '—' : (v * 100).toFixed(1) + '%'

const fmtDate = (d: unknown) => {
  const dt = new Date(String(d) + 'T00:00:00')
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function Overview({ start, end, brand = 'xpro' }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['overview', start, end, brand],
    queryFn: () => fetchOverview(start, end, brand),
  })

  // ── AI Insights (Claude) ──────────────────────────────────────────────────
  const [aiText,    setAiText]    = useState('')
  const [aiState,   setAiState]   = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [aiErr,     setAiErr]     = useState('')
  const [aiModel,   setAiModel]   = useState('')
  const aiPanelRef = useRef<HTMLDivElement>(null)

  async function runInsights() {
    setAiState('running')
    setAiText('')
    setAiErr('')
    setTimeout(() => aiPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100)
    try {
      const res = await fetch('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start, end, brand }),
      })
      if (!res.ok || !res.body) {
        throw new Error(await res.text().catch(() => `HTTP ${res.status}`))
      }
      setAiModel(res.headers.get('X-Model') ?? '')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        setAiText(t => t + decoder.decode(value, { stream: true }))
      }
      setAiState('done')
    } catch (e) {
      setAiState('error')
      setAiErr(e instanceof Error ? e.message : 'Analysis failed')
    }
  }

  const kpis = data?.kpis
  const series = data?.series ?? []

  const KPI_ROWS = [
    { label: 'Total Revenue',    value: fmt$(kpis?.total_revenue),    sub: 'All channels',           highlight: true },
    { label: 'Total Ad Spend',   value: fmt$(kpis?.total_spend),      sub: 'Amazon + TikTok + Meta', highlight: false },
    { label: 'Blended ROAS',     value: fmtX(kpis?.blended_roas),     sub: 'Revenue ÷ Spend',        highlight: false },
    { label: 'TACOS',            value: fmtPct(kpis?.tacos),          sub: 'PPC Spend ÷ Amazon Rev', highlight: false },
    { label: 'Amazon Revenue',   value: fmt$(kpis?.amazon_revenue),   sub: 'Ordered product sales',  highlight: false },
    { label: 'Shopify Revenue',  value: fmt$(kpis?.shopify_revenue),  sub: 'Net sales',              highlight: false },
    { label: 'TikTok Revenue',   value: fmt$(kpis?.tiktok_revenue),   sub: 'Settled orders',         highlight: false },
    { label: 'Amazon PPC Spend', value: fmt$(kpis?.amazon_ppc_spend), sub: 'Campaign spend',         highlight: false },
  ]

  return (
    <div className="space-y-8">

      {/* ── Header ── */}
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Overview</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            {start} → {end} · All channels
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isLoading && (
            <span className="text-xs text-gray-500 animate-pulse">Loading…</span>
          )}
          {error && (
            <span className="text-xs text-red-400">Failed to load data</span>
          )}
          <button
            onClick={runInsights}
            disabled={aiState === 'running'}
            title="Send this period's data to Claude for analysis and recommendations"
            className="px-3.5 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {aiState === 'running' ? '✦ Analysing…' : '✦ AI Insights'}
          </button>
        </div>
      </div>

      {/* ── AI Insights panel ── */}
      {aiState !== 'idle' && (
        <div ref={aiPanelRef} className="bg-gray-900 border border-indigo-900/60 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <span className="text-indigo-400">✦</span> AI Insights
              <span className="text-xs font-normal text-gray-500">{start} → {end} · {aiModel || 'Claude'}</span>
            </h3>
            {aiState === 'running' && <span className="text-xs text-indigo-400 animate-pulse">thinking…</span>}
            {aiState === 'done' && (
              <button onClick={runInsights} className="text-xs text-gray-500 hover:text-gray-300">↻ Regenerate</button>
            )}
          </div>
          {aiState === 'error' ? (
            <p className="text-sm text-rose-400">⚠ {aiErr}</p>
          ) : aiText === '' ? (
            <p className="text-sm text-gray-500 animate-pulse">Reading the period&apos;s data and thinking — this can take a minute…</p>
          ) : (
            <div className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{aiText}</div>
          )}
        </div>
      )}

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {KPI_ROWS.map((card) => (
          <div
            key={card.label}
            className={`rounded-xl border p-5 space-y-1 ${
              card.highlight
                ? 'bg-indigo-950/40 border-indigo-700/50'
                : 'bg-gray-900 border-gray-800'
            }`}
          >
            <p className="text-xs text-gray-500 uppercase tracking-wider font-medium">
              {card.label}
            </p>
            <p className={`text-2xl font-bold ${isLoading ? 'animate-pulse text-gray-600' : 'text-white'}`}>
              {isLoading ? '···' : card.value}
            </p>
            <p className="text-xs text-gray-600">{card.sub}</p>
          </div>
        ))}
      </div>

      {/* ── Revenue chart ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-gray-300 mb-6">Daily Revenue by Channel</h3>

        {series.length === 0 && !isLoading ? (
          <p className="text-sm text-gray-500 text-center py-16">
            No data for this date range yet. Run the backfill to populate data.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={series} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="amz" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="shop" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="ttk" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#f59e0b" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="date"
                tickFormatter={fmtDate}
                tick={{ fill: '#6b7280', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={(v) => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v)}
                tick={{ fill: '#6b7280', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={52}
              />
              <Tooltip
                contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
                labelStyle={{ color: '#9ca3af', fontSize: 12 }}
                formatter={(value: unknown, name: unknown) => [
                  '$' + Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 }),
                  String(name),
                ]}
                labelFormatter={fmtDate}
              />
              <Legend
                wrapperStyle={{ fontSize: 12, color: '#9ca3af', paddingTop: 12 }}
              />

              <Area
                type="monotone"
                dataKey="amazon_revenue"
                name="Amazon"
                stroke="#6366f1"
                strokeWidth={2}
                fill="url(#amz)"
                dot={false}
              />
              <Area
                type="monotone"
                dataKey="shopify_revenue"
                name="Shopify"
                stroke="#10b981"
                strokeWidth={2}
                fill="url(#shop)"
                dot={false}
              />
              <Area
                type="monotone"
                dataKey="tiktok_shop_revenue"
                name="TikTok"
                stroke="#f59e0b"
                strokeWidth={2}
                fill="url(#ttk)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

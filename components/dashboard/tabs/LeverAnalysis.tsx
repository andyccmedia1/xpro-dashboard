'use client'

import { useQuery } from '@tanstack/react-query'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'

interface Props { start: string; end: string; brand?: string }

async function fetchLevers(start: string, end: string, brand: string) {
  const res = await fetch(`/api/levers?start=${start}&end=${end}&brand=${brand}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

const fmt$  = (v: number | null) => v == null ? '—' : '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 })
const fmtX  = (v: number | null) => v == null ? '—' : v.toFixed(2) + 'x'
const fmtPct= (v: number | null) => v == null ? '—' : (v * 100).toFixed(1) + '%'
const fmtDate = (d: string) => { const dt = new Date(d + 'T00:00:00'); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }

function roasColor(v: number | null) {
  if (v == null) return 'text-gray-400'
  if (v > 20)   return 'text-gray-400'   // likely data gap — don't show as green
  if (v >= 4)   return 'text-emerald-400'
  if (v >= 2)   return 'text-amber-400'
  return 'text-red-400'
}
function tacosColor(v: number | null) {
  if (v == null) return 'text-gray-400'
  if (v <= 0.10) return 'text-emerald-400'
  if (v <= 0.18) return 'text-amber-400'
  return 'text-red-400'
}

export default function LeverAnalysis({ start, end, brand = 'xpro' }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['levers', start, end, brand],
    queryFn:  () => fetchLevers(start, end, brand),
  })

  const totals = data?.totals
  const series = data?.series ?? []

  const SUMMARY = [
    { label: 'Blended ROAS',  value: fmtX(totals?.period_roas),   color: roasColor(totals?.period_roas),  sub: 'Total Rev ÷ Total Spend' },
    { label: 'Amazon TACOS',  value: fmtPct(totals?.period_tacos), color: tacosColor(totals?.period_tacos), sub: 'PPC Spend ÷ Amazon Rev' },
    { label: 'Total Revenue', value: fmt$(totals?.total_revenue),  color: 'text-white', sub: 'All channels' },
    { label: 'Total Spend',   value: fmt$(totals?.total_spend),    color: 'text-white', sub: 'All ad platforms' },
    { label: 'Amazon Rev',    value: fmt$(totals?.amazon_revenue), color: 'text-white', sub: 'Ordered product sales' },
    { label: 'Amazon PPC',    value: fmt$(totals?.amazon_ppc_spend), color: 'text-white', sub: 'Campaign spend' },
  ]

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Lever Analysis</h2>
          <p className="text-gray-400 text-sm mt-0.5">{start} → {end} · How spend drives revenue</p>
        </div>
        {isLoading && <span className="text-xs text-gray-500 animate-pulse">Loading…</span>}
        {error    && <span className="text-xs text-red-400">Failed to load data</span>}
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {SUMMARY.map((s) => (
          <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-1">
            <p className="text-xs text-gray-500 uppercase tracking-wider font-medium truncate">{s.label}</p>
            <p className={`text-xl font-bold ${isLoading ? 'animate-pulse text-gray-600' : s.color}`}>
              {isLoading ? '···' : s.value}
            </p>
            <p className="text-xs text-gray-600 truncate">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Revenue vs Spend chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-gray-300 mb-1">Daily Revenue vs Ad Spend</h3>
        <p className="text-xs text-gray-500 mb-6">Bars = spend · Line = total revenue</p>
        {series.length === 0 && !isLoading ? (
          <p className="text-sm text-gray-500 text-center py-16">No data for this date range.</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={series} margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis yAxisId="left" tickFormatter={(v) => '$' + (v >= 1000 ? (v/1000).toFixed(0)+'k' : v)} tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
              <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => '$' + (v >= 1000 ? (v/1000).toFixed(0)+'k' : v)} tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
              <Tooltip
                contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
                labelStyle={{ color: '#9ca3af', fontSize: 12 }}
                formatter={(v: unknown, name: string) => ['$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }), name]}
                labelFormatter={fmtDate}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: '#9ca3af', paddingTop: 12 }} />
              <Bar yAxisId="left" dataKey="amazon_ppc_spend" name="Amazon PPC" fill="#6366f1" opacity={0.8} stackId="spend" />
              <Bar yAxisId="left" dataKey="tiktok_ads_spend" name="TikTok Ads" fill="#f59e0b" opacity={0.8} stackId="spend" />
              <Bar yAxisId="left" dataKey="meta_ads_spend"   name="Meta Ads"   fill="#ec4899" opacity={0.8} stackId="spend" radius={[2,2,0,0]} />
              <Line yAxisId="right" type="monotone" dataKey="total_revenue" name="Total Revenue" stroke="#10b981" strokeWidth={2.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ROAS & TACOS trend */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-gray-300 mb-1">Daily ROAS & TACOS</h3>
        <p className="text-xs text-gray-500 mb-6">ROAS target ≥ 4x · TACOS target ≤ 10%</p>
        {series.length === 0 && !isLoading ? (
          <p className="text-sm text-gray-500 text-center py-16">No data for this date range.</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={series} margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis yAxisId="roas" tickFormatter={(v) => v + 'x'} tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
              <YAxis yAxisId="tacos" orientation="right" tickFormatter={(v) => (v*100).toFixed(0)+'%'} tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
              <Tooltip
                contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
                labelStyle={{ color: '#9ca3af', fontSize: 12 }}
                formatter={(v: unknown, name: string) => {
                  const n = Number(v)
                  return name === 'ROAS' ? [n.toFixed(2) + 'x', name] : [(n*100).toFixed(1)+'%', name]
                }}
                labelFormatter={fmtDate}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: '#9ca3af', paddingTop: 12 }} />
              <ReferenceLine yAxisId="roas"  y={4}    stroke="#10b981" strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: '4x', fill: '#10b981', fontSize: 10, position: 'insideTopRight' }} />
              <ReferenceLine yAxisId="tacos" y={0.10} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: '10%', fill: '#f59e0b', fontSize: 10, position: 'insideTopRight' }} />
              <Line yAxisId="roas"  type="monotone" dataKey="roas"  name="ROAS"  stroke="#6366f1" strokeWidth={2} dot={false} connectNulls />
              <Line yAxisId="tacos" type="monotone" dataKey="tacos" name="TACOS" stroke="#f59e0b" strokeWidth={2} dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Daily breakdown table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-gray-300">Daily Breakdown</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {['Date','Amz Revenue','PPC Spend','ROAS','TACOS','Total Rev','Total Spend'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-800 rounded animate-pulse w-16" /></td>
                    ))}
                  </tr>
                ))
              ) : series.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No data</td></tr>
              ) : (
                [...series].reverse().map((row: any) => (
                  <tr key={row.date} className="hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">{fmtDate(row.date)}</td>
                    <td className="px-4 py-2.5 text-white font-medium">{fmt$(row.amazon_revenue)}</td>
                    <td className="px-4 py-2.5 text-indigo-400">{fmt$(row.amazon_ppc_spend)}</td>
                    <td className={`px-4 py-2.5 font-medium ${roasColor(row.amz_roas)}`}>{fmtX(row.amz_roas)}</td>
                    <td className={`px-4 py-2.5 font-medium ${tacosColor(row.tacos)}`}>{fmtPct(row.tacos)}</td>
                    <td className="px-4 py-2.5 text-emerald-400 font-medium">{fmt$(row.total_revenue)}</td>
                    <td className="px-4 py-2.5 text-gray-300">{fmt$(row.total_spend)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  )
}

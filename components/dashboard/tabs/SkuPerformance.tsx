'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts'

interface Props { start: string; end: string; brand?: string }

async function fetchSkus(start: string, end: string, brand: string) {
  const res = await fetch(`/api/skus?start=${start}&end=${end}&brand=${brand}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

const fmt$   = (v: number) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 })
const fmtPct = (v: number | null) => v == null ? '—' : (v * 100).toFixed(1) + '%'
const fmtNum = (v: number) => v.toLocaleString('en-US')
const fmtDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

type SortKey = 'ordered_product_sales' | 'sessions' | 'units_ordered' | 'avg_cvr' | 'avg_buy_box_pct'

function cvrColor(v: number | null) {
  if (v == null) return 'text-gray-500'
  if (v >= 0.05) return 'text-emerald-400'
  if (v >= 0.02) return 'text-amber-400'
  return 'text-red-400'
}
function bbColor(v: number | null) {
  if (v == null) return 'text-gray-500'
  if (v >= 0.90) return 'text-emerald-400'
  if (v >= 0.70) return 'text-amber-400'
  return 'text-red-400'
}

function Sparkline({ data, dataKey, color }: { data: any[]; dataKey: string; color: string }) {
  return (
    <ResponsiveContainer width={80} height={32}>
      <LineChart data={data}>
        <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

export default function SkuPerformance({ start, end, brand = 'xpro' }: Props) {
  const [sortKey, setSortKey]   = useState<SortKey>('ordered_product_sales')
  const [sortDir, setSortDir]   = useState<'desc' | 'asc'>('desc')
  const [search, setSearch]     = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['skus', start, end, brand],
    queryFn:  () => fetchSkus(start, end, brand),
  })

  const summary = data?.summary
  const rawSkus: any[] = data?.skus ?? []

  // Filter + sort
  const skus = rawSkus
    .filter(s => s.asin.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const av = a[sortKey] ?? -1
      const bv = b[sortKey] ?? -1
      return sortDir === 'desc' ? bv - av : av - bv
    })

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const SortTh = ({ label, k }: { label: string; k: SortKey }) => (
    <th
      onClick={() => toggleSort(k)}
      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-300 whitespace-nowrap select-none"
    >
      {label}
      {sortKey === k && <span className="ml-1">{sortDir === 'desc' ? '↓' : '↑'}</span>}
    </th>
  )

  const SUMMARY_CARDS = [
    { label: 'Active SKUs',    value: isLoading ? '···' : (summary?.sku_count ?? 0).toString() },
    { label: 'Total Sessions', value: isLoading ? '···' : fmtNum(summary?.total_sessions ?? 0) },
    { label: 'Total Units',    value: isLoading ? '···' : fmtNum(summary?.total_units ?? 0) },
    { label: 'ASIN Revenue',   value: isLoading ? '···' : fmt$(summary?.total_revenue ?? 0) },
    { label: 'Avg CVR',        value: isLoading ? '···' : fmtPct(summary?.avg_cvr ?? null) },
  ]

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">SKU Performance</h2>
          <p className="text-gray-400 text-sm mt-0.5">{start} → {end} · Per-ASIN sessions, CVR & revenue</p>
        </div>
        {isLoading && <span className="text-xs text-gray-500 animate-pulse">Loading…</span>}
        {error     && <span className="text-xs text-red-400">Failed to load data</span>}
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {SUMMARY_CARDS.map(c => (
          <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider font-medium mb-1">{c.label}</p>
            <p className={`text-xl font-bold ${isLoading ? 'animate-pulse text-gray-600' : 'text-white'}`}>{c.value}</p>
          </div>
        ))}
      </div>

      {/* Search + table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center gap-3">
          <input
            type="text"
            placeholder="Filter by ASIN…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-52"
          />
          <span className="text-xs text-gray-500">{skus.length} ASINs</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-8" />
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ASIN</th>
                <SortTh label="Sessions"  k="sessions" />
                <SortTh label="Units"     k="units_ordered" />
                <SortTh label="Revenue"   k="ordered_product_sales" />
                <SortTh label="Avg CVR"   k="avg_cvr" />
                <SortTh label="Buy Box"   k="avg_buy_box_pct" />
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sessions Trend</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">CVR Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-800 rounded animate-pulse w-16" /></td>
                    ))}
                  </tr>
                ))
              ) : skus.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-500">No SKU data for this date range.</td></tr>
              ) : (
                skus.map((sku: any) => (
                  <>
                    <tr
                      key={sku.asin}
                      className="hover:bg-gray-800/40 transition-colors cursor-pointer"
                      onClick={() => setExpanded(expanded === sku.asin ? null : sku.asin)}
                    >
                      <td className="px-4 py-3 text-gray-500 text-xs">{expanded === sku.asin ? '▼' : '▶'}</td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-indigo-400 text-xs font-medium">{sku.asin}</div>
                        {sku.parent_asin && sku.parent_asin !== sku.asin && (
                          <div className="text-gray-600 text-xs">↳ {sku.parent_asin}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-200">{fmtNum(sku.sessions)}</td>
                      <td className="px-4 py-3 text-gray-200">{fmtNum(sku.units_ordered)}</td>
                      <td className="px-4 py-3 text-white font-medium">{fmt$(sku.ordered_product_sales)}</td>
                      <td className={`px-4 py-3 font-medium ${cvrColor(sku.avg_cvr)}`}>{fmtPct(sku.avg_cvr)}</td>
                      <td className={`px-4 py-3 font-medium ${bbColor(sku.avg_buy_box_pct)}`}>{fmtPct(sku.avg_buy_box_pct)}</td>
                      <td className="px-4 py-3"><Sparkline data={sku.daily} dataKey="sessions" color="#6366f1" /></td>
                      <td className="px-4 py-3"><Sparkline data={sku.daily} dataKey="unit_session_pct" color="#10b981" /></td>
                    </tr>

                    {/* Expanded daily breakdown */}
                    {expanded === sku.asin && (
                      <tr key={sku.asin + '-exp'} className="bg-gray-800/20">
                        <td colSpan={9} className="px-6 py-4">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Daily Breakdown — {sku.asin}</p>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b border-gray-700">
                                  {['Date','Sessions','Units','Revenue','CVR','Buy Box'].map(h => (
                                    <th key={h} className="px-3 py-2 text-left text-gray-500 font-medium uppercase tracking-wider">{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-700/40">
                                {[...sku.daily].reverse().map((d: any) => (
                                  <tr key={d.date} className="hover:bg-gray-700/20">
                                    <td className="px-3 py-1.5 text-gray-400">{fmtDate(d.date)}</td>
                                    <td className="px-3 py-1.5 text-gray-300">{fmtNum(d.sessions)}</td>
                                    <td className="px-3 py-1.5 text-gray-300">{fmtNum(d.units_ordered)}</td>
                                    <td className="px-3 py-1.5 text-white font-medium">{fmt$(d.ordered_product_sales)}</td>
                                    <td className={`px-3 py-1.5 font-medium ${cvrColor(d.unit_session_pct)}`}>{fmtPct(d.unit_session_pct)}</td>
                                    <td className={`px-3 py-1.5 font-medium ${bbColor(d.buy_box_pct)}`}>{fmtPct(d.buy_box_pct)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

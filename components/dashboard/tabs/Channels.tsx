'use client'

import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from 'recharts'

interface Props { start: string; end: string; brand?: string }

async function fetchChannels(start: string, end: string, brand: string) {
  const res = await fetch(`/api/channels?start=${start}&end=${end}&brand=${brand}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

const fmt$   = (v: number) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 })
const fmtPct = (v: number) => (v * 100).toFixed(1) + '%'
const fmtX   = (v: number | null) => v == null ? '—' : v.toFixed(2) + 'x'
const fmtDate = (d: string) => {
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const CHANNEL_COLORS = {
  amazon:  '#6366f1',
  shopify: '#10b981',
  tiktok:  '#f59e0b',
}
const SPEND_COLORS = {
  amazon: '#6366f1',
  tiktok: '#f59e0b',
  meta:   '#ec4899',
}

// Custom pie label
const renderPieLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, value, name }: any) => {
  if (value < 0.03) return null   // skip tiny slices
  const RADIAN = Math.PI / 180
  const r  = innerRadius + (outerRadius - innerRadius) * 0.5
  const x  = cx + r * Math.cos(-midAngle * RADIAN)
  const y  = cy + r * Math.sin(-midAngle * RADIAN)
  return (
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600}>
      {(value * 100).toFixed(0)}%
    </text>
  )
}

export default function Channels({ start, end, brand = 'xpro' }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['channels', start, end, brand],
    queryFn:  () => fetchChannels(start, end, brand),
  })

  const ch     = data?.channels
  const series = data?.series ?? []

  // Pie data
  const revPie = ch ? [
    { name: 'Amazon',  value: ch.revenue.amazon.share,  color: CHANNEL_COLORS.amazon  },
    { name: 'Shopify', value: ch.revenue.shopify.share, color: CHANNEL_COLORS.shopify },
    { name: 'TikTok',  value: ch.revenue.tiktok.share,  color: CHANNEL_COLORS.tiktok  },
  ].filter(d => d.value > 0) : []

  const spendPie = ch ? [
    { name: 'Amazon PPC', value: ch.spend.amazon.share, color: SPEND_COLORS.amazon },
    { name: 'TikTok Ads', value: ch.spend.tiktok.share, color: SPEND_COLORS.tiktok },
    { name: 'Meta Ads',   value: ch.spend.meta.share,   color: SPEND_COLORS.meta   },
  ].filter(d => d.value > 0) : []

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Channels</h2>
          <p className="text-gray-400 text-sm mt-0.5">{start} → {end} · Revenue & spend by platform</p>
        </div>
        {isLoading && <span className="text-xs text-gray-500 animate-pulse">Loading…</span>}
        {error     && <span className="text-xs text-red-400">Failed to load data</span>}
      </div>

      {/* Revenue channel cards */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Revenue by Channel</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            { key: 'amazon',  label: 'Amazon',  icon: '📦', color: 'border-indigo-700/50 bg-indigo-950/30',  textColor: 'text-indigo-400' },
            { key: 'shopify', label: 'Shopify', icon: '🛍️', color: 'border-emerald-700/50 bg-emerald-950/30', textColor: 'text-emerald-400' },
            { key: 'tiktok',  label: 'TikTok',  icon: '🎵', color: 'border-amber-700/50 bg-amber-950/30',    textColor: 'text-amber-400'   },
          ].map(({ key, label, icon, color, textColor }) => {
            const rev = ch?.revenue[key as keyof typeof ch.revenue] as any
            return (
              <div key={key} className={`rounded-xl border p-5 space-y-3 ${color}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-300">{icon} {label}</span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full bg-black/20 ${textColor}`}>
                    {isLoading ? '…' : fmtPct(rev?.share ?? 0)} of total
                  </span>
                </div>
                <p className={`text-3xl font-bold ${isLoading ? 'animate-pulse text-gray-600' : 'text-white'}`}>
                  {isLoading ? '···' : fmt$(rev?.total ?? 0)}
                </p>
                {/* Share bar */}
                <div className="h-1.5 bg-black/30 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${textColor.replace('text-', 'bg-')}`}
                    style={{ width: isLoading ? '0%' : fmtPct(rev?.share ?? 0) }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Spend channel cards */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Ad Spend by Platform</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            { key: 'amazon', label: 'Amazon PPC', color: 'border-indigo-700/50 bg-indigo-950/30', textColor: 'text-indigo-400' },
            { key: 'tiktok', label: 'TikTok Ads', color: 'border-amber-700/50 bg-amber-950/30',   textColor: 'text-amber-400'  },
            { key: 'meta',   label: 'Meta Ads',   color: 'border-pink-700/50 bg-pink-950/30',     textColor: 'text-pink-400'   },
          ].map(({ key, label, color, textColor }) => {
            const sp = ch?.spend[key as keyof typeof ch.spend] as any
            return (
              <div key={key} className={`rounded-xl border p-5 ${color}`}>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-300">{label}</span>
                  <span className={`text-xs font-semibold ${textColor}`}>{isLoading ? '…' : fmtPct(sp?.share ?? 0)}</span>
                </div>
                <p className={`text-3xl font-bold mb-1 ${isLoading ? 'animate-pulse text-gray-600' : 'text-white'}`}>
                  {isLoading ? '···' : fmt$(sp?.total ?? 0)}
                </p>
                <p className={`text-sm ${textColor}`}>
                  ROAS {isLoading ? '…' : fmtX(sp?.roas ?? null)}
                </p>
              </div>
            )
          })}
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Stacked daily revenue bar chart */}
        <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-gray-300 mb-6">Daily Revenue by Channel</h3>
          {series.length === 0 && !isLoading ? (
            <p className="text-sm text-gray-500 text-center py-16">No data for this date range.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={series} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tickFormatter={(v) => '$' + (v >= 1000 ? (v/1000).toFixed(0)+'k' : v)} tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
                <Tooltip
                  contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
                  labelStyle={{ color: '#9ca3af', fontSize: 12 }}
                  formatter={(v: unknown, name: unknown) => ['$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }), String(name)]}
                  labelFormatter={fmtDate}
                />
                <Legend wrapperStyle={{ fontSize: 12, color: '#9ca3af', paddingTop: 12 }} />
                <Bar dataKey="amazon_revenue"      name="Amazon"  fill={CHANNEL_COLORS.amazon}  stackId="rev" />
                <Bar dataKey="shopify_revenue"     name="Shopify" fill={CHANNEL_COLORS.shopify} stackId="rev" />
                <Bar dataKey="tiktok_shop_revenue" name="TikTok"  fill={CHANNEL_COLORS.tiktok}  stackId="rev" radius={[2,2,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Revenue mix pie */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Revenue Mix</h3>
          {revPie.length === 0 && !isLoading ? (
            <p className="text-sm text-gray-500 text-center py-16">No data.</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={revPie} dataKey="value" cx="50%" cy="50%" outerRadius={80} innerRadius={40} labelLine={false} label={renderPieLabel}>
                    {revPie.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip formatter={(v: unknown) => fmtPct(v as number)} contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-auto space-y-2">
                {revPie.map((d) => (
                  <div key={d.name} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />
                      <span className="text-gray-400">{d.name}</span>
                    </div>
                    <span className="text-white font-medium">{fmtPct(d.value)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Channel efficiency table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-gray-300">Channel Efficiency Summary</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              {['Channel', 'Revenue', '% of Total', 'Ad Spend', 'Channel ROAS'].map(h => (
                <th key={h} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {isLoading ? (
              [1,2,3].map(i => (
                <tr key={i}>{[1,2,3,4,5].map(j => (
                  <td key={j} className="px-6 py-3"><div className="h-4 bg-gray-800 rounded animate-pulse w-20" /></td>
                ))}</tr>
              ))
            ) : (
              <>
                {[
                  { label: 'Amazon',  rev: ch?.revenue.amazon.total,  share: ch?.revenue.amazon.share,  spend: ch?.spend.amazon.total,  roas: ch?.spend.amazon.roas,  dot: CHANNEL_COLORS.amazon  },
                  { label: 'Shopify', rev: ch?.revenue.shopify.total, share: ch?.revenue.shopify.share, spend: null,                    roas: null,                   dot: CHANNEL_COLORS.shopify },
                  { label: 'TikTok', rev: ch?.revenue.tiktok.total,  share: ch?.revenue.tiktok.share,  spend: ch?.spend.tiktok.total,  roas: ch?.spend.tiktok.roas,  dot: CHANNEL_COLORS.tiktok  },
                  { label: 'Meta Ads (all channels)', rev: null, share: null, spend: ch?.spend.meta.total, roas: ch?.spend.meta.roas, dot: SPEND_COLORS.meta },
                ].map(row => (
                  <tr key={row.label} className="hover:bg-gray-800/40 transition-colors">
                    <td className="px-6 py-3 flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: row.dot }} />
                      <span className="text-gray-200">{row.label}</span>
                    </td>
                    <td className="px-6 py-3 text-white font-medium">{row.rev != null ? fmt$(row.rev) : '—'}</td>
                    <td className="px-6 py-3 text-gray-400">{row.share != null ? fmtPct(row.share) : '—'}</td>
                    <td className="px-6 py-3 text-gray-300">{row.spend != null ? fmt$(row.spend) : '—'}</td>
                    <td className="px-6 py-3 font-medium text-gray-300">{fmtX(row.roas ?? null)}</td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>

    </div>
  )
}

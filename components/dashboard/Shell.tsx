'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Overview        from '@/components/dashboard/tabs/Overview'
import LeverAnalysis   from '@/components/dashboard/tabs/LeverAnalysis'
import Channels        from '@/components/dashboard/tabs/Channels'
import SkuPerformance  from '@/components/dashboard/tabs/SkuPerformance'
import DataManager     from '@/components/dashboard/tabs/DataManager'
import Heatmap         from '@/components/dashboard/tabs/Heatmap'
import BudgetAllocator from '@/components/dashboard/tabs/BudgetAllocator'
import Inventory       from '@/components/dashboard/tabs/Inventory'
import Forecast        from '@/components/dashboard/tabs/Forecast'
import ScenarioPlanner from '@/components/dashboard/tabs/ScenarioPlanner'

const TABS = [
  { id: 'overview',  label: 'Overview' },
  { id: 'channels',  label: 'Channels' },
  { id: 'levers',    label: 'Lever Analysis' },
  { id: 'skus',      label: 'SKU Performance' },
  { id: 'heatmap',   label: 'Sales Heatmap' },
  { id: 'budget',    label: 'Budget Allocator' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'forecast',  label: 'Forecast' },
  { id: 'scenarios', label: 'Scenario Planner' },
  { id: 'data',      label: 'Data Manager' },
]

// Default to last 30 days
function defaultDates() {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(start.getDate() - 29)
  return {
    start: start.toISOString().slice(0, 10),
    end:   end.toISOString().slice(0, 10),
  }
}

export default function DashboardShell({ userEmail }: { userEmail: string }) {
  const [activeTab, setActiveTab] = useState('overview')
  const [dates, setDates] = useState(defaultDates)
  const supabase = createClient()

  async function signOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">

      {/* ── Top header ───────────────────────────────────── */}
      <header className="border-b border-gray-800 bg-gray-900/60 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-screen-xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-14 items-center justify-between gap-4">

            {/* Brand */}
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-base font-bold text-white tracking-tight">X PRO</span>
              <span className="text-gray-600">|</span>
              <span className="text-sm text-gray-400">Analytics</span>
            </div>

            {/* Date range */}
            <div className="flex items-center gap-2 text-sm">
              <input
                type="date"
                value={dates.start}
                max={dates.end}
                onChange={(e) => setDates((d) => ({ ...d, start: e.target.value }))}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
              />
              <span className="text-gray-500">→</span>
              <input
                type="date"
                value={dates.end}
                min={dates.start}
                onChange={(e) => setDates((d) => ({ ...d, end: e.target.value }))}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
              />
            </div>

            {/* User */}
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-sm text-gray-400 hidden sm:block">{userEmail}</span>
              <button
                onClick={signOut}
                className="text-sm text-gray-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-gray-800"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* ── Tab navigation ───────────────────────────────── */}
      <nav className="border-b border-gray-800 bg-gray-900/30">
        <div className="mx-auto max-w-screen-xl px-4 sm:px-6 lg:px-8">
          <div className="flex gap-0 overflow-x-auto">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  activeTab === tab.id
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-600'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* ── Page content ─────────────────────────────────── */}
      <main className="mx-auto max-w-screen-xl px-4 py-8 sm:px-6 lg:px-8">
        {activeTab === 'overview' && <Overview start={dates.start} end={dates.end} />}
        {activeTab === 'channels' && <Channels start={dates.start} end={dates.end} />}
        {activeTab === 'levers'   && <LeverAnalysis start={dates.start} end={dates.end} />}
        {activeTab === 'skus'     && <SkuPerformance start={dates.start} end={dates.end} />}
        {activeTab === 'heatmap'  && <Heatmap />}
        {activeTab === 'budget'   && <BudgetAllocator />}
        {activeTab === 'inventory'&& <Inventory />}
        {activeTab === 'forecast' && <Forecast />}
        {activeTab === 'scenarios'&& <ScenarioPlanner />}
        {activeTab === 'data'     && <DataManager />}
      </main>
    </div>
  )
}

/* ── Placeholder tab content ───────────────────────────────── */

function OverviewPlaceholder({ dates }: { dates: { start: string; end: string } }) {
  const KPI_CARDS = [
    { label: 'Total Revenue',    value: '—', sub: 'All channels' },
    { label: 'Total Ad Spend',   value: '—', sub: 'Amazon + TikTok + Meta' },
    { label: 'Blended ROAS',     value: '—', sub: 'Revenue ÷ Spend' },
    { label: 'TACOS',            value: '—', sub: 'Spend ÷ Amazon Rev' },
    { label: 'Amazon Revenue',   value: '—', sub: 'Ordered product sales' },
    { label: 'Shopify Revenue',  value: '—', sub: 'Net sales' },
    { label: 'TikTok Revenue',   value: '—', sub: 'Settled orders' },
    { label: 'Amazon PPC Spend', value: '—', sub: 'Campaign spend' },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white">Overview</h2>
        <p className="text-gray-400 text-sm mt-1">
          {dates.start} → {dates.end} · All channels
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {KPI_CARDS.map((card) => (
          <div
            key={card.label}
            className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-1"
          >
            <p className="text-xs text-gray-500 uppercase tracking-wider font-medium">
              {card.label}
            </p>
            <p className="text-2xl font-bold text-white">{card.value}</p>
            <p className="text-xs text-gray-600">{card.sub}</p>
          </div>
        ))}
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <p className="text-sm text-gray-400 text-center py-12">
          Revenue chart will appear here once data is connected.
        </p>
      </div>
    </div>
  )
}

function ComingSoon({ title }: { title: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-32 text-center">
      <h2 className="text-xl font-bold text-white">{title}</h2>
      <p className="text-gray-500 text-sm mt-2">This tab is being built. Check back soon.</p>
    </div>
  )
}

'use client'

import { useState, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

interface UploadResult { inserted: number; errors: string[] }

const CHANNELS = [
  { id: 'shopify',      label: 'Shopify Revenue',   color: 'emerald', hint: 'Needs columns: Date, Net Sales (or Revenue)' },
  { id: 'tiktok',       label: 'TikTok Shop Revenue', color: 'amber', hint: 'Needs columns: Date, Revenue (or Net Revenue)' },
  { id: 'tiktok_spend', label: 'TikTok Ads Spend',  color: 'amber',   hint: 'Needs columns: Date, Spend (or Cost)' },
  { id: 'meta_spend',   label: 'Meta Ads Spend',    color: 'pink',    hint: 'Needs columns: Date, Amount Spent' },
]

// ── CSV parser ────────────────────────────────────────────────────────────────
// Handles exports that have metadata rows before the real header (e.g. TikTok Shop).
// Scans the first 25 rows to find the line where "date" or "day" appears as an
// exact column name, then treats everything after it as data.

function parseDate(raw: string): Date | null {
  if (!raw) return null
  // DD/MM/YYYY or D/M/YYYY — TikTok Shop exports European format
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) {
    const [, d, m, y] = dmy
    const dt = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00`)
    return isNaN(dt.getTime()) ? null : dt
  }
  // YYYY-MM-DD, MM/DD/YYYY, "May 12, 2026", etc.
  const dt = new Date(raw + (raw.includes('T') ? '' : 'T00:00:00'))
  return isNaN(dt.getTime()) ? null : dt
}

function parseCSV(text: string, channel: string): { rows: {date:string,value:number}[]; errors: string[] } {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return { rows: [], errors: ['CSV has no data rows'] }

  // Scan up to 25 rows to find the actual header row.
  // TikTok Shop exports have 8 rows of metadata before the real "Date,GMV,…" header.
  let headerLineIdx = -1
  let headers: string[] = []
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const cols = lines[i].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase())
    // Require an exact "date" or "day" column (not "analysis date: …" metadata)
    if (cols.some(h => h === 'date' || h === 'day')) {
      headerLineIdx = i
      headers = cols
      break
    }
  }
  if (headerLineIdx === -1) return { rows: [], errors: ['Could not find a header row with a Date column'] }

  const dateIdx = headers.findIndex(h => h === 'date' || h === 'day')

  // Find value column — preference order varies by channel
  const valueCandidates: Record<string, string[]> = {
    shopify:      ['net sales', 'net revenue', 'revenue', 'total sales', 'gross sales'],
    tiktok:       ['gmv', 'revenue', 'net revenue', 'settled gmv', 'total revenue'],
    tiktok_spend: ['spend', 'cost', 'total cost', 'amount spent', 'total spend'],
    meta_spend:   ['amount spent', 'spend', 'cost', 'total cost'],
  }
  const candidates = valueCandidates[channel] ?? ['revenue', 'amount', 'value']
  let valueIdx = -1
  for (const c of candidates) {
    valueIdx = headers.findIndex(h => h === c || h.startsWith(c))
    if (valueIdx !== -1) break
  }
  if (valueIdx === -1) {
    // Fall back to first non-date column
    valueIdx = headers.findIndex((_, i) => i !== dateIdx)
  }

  const rows: {date:string,value:number}[] = []
  const errors: string[] = []

  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const cells = lines[i].split(',').map(c => c.replace(/"/g, '').trim())
    const rawDate  = cells[dateIdx]  ?? ''
    const rawValue = cells[valueIdx] ?? ''

    // Skip obvious non-data rows (subtotals, footers)
    if (!rawDate || rawDate.toLowerCase().includes('total') || rawDate.toLowerCase().includes('change')) continue

    const parsed = parseDate(rawDate)
    if (!parsed) { errors.push(`Row ${i + 1}: bad date "${rawDate}"`); continue }
    const date = parsed.toISOString().slice(0, 10)

    // Strip currency symbols, commas, dashes (TikTok uses "-" for zero)
    const cleanValue = rawValue.replace(/[$,\s]/g, '')
    if (cleanValue === '-' || cleanValue === '') { continue } // skip zero/blank rows silently
    const value = parseFloat(cleanValue)
    if (isNaN(value)) { errors.push(`Row ${i + 1}: bad value "${rawValue}"`); continue }

    rows.push({ date, value })
  }

  return { rows, errors }
}

// ── Upload card ───────────────────────────────────────────────────────────────
function UploadCard({ channel, onSuccess }: { channel: typeof CHANNELS[0]; onSuccess: () => void }) {
  const [status, setStatus] = useState<'idle'|'parsing'|'uploading'|'done'|'error'>('idle')
  const [result, setResult] = useState<UploadResult | null>(null)
  const [parseErrors, setParseErrors] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const colorMap: Record<string, string> = {
    emerald: 'border-emerald-700/40 bg-emerald-950/20',
    amber:   'border-amber-700/40 bg-amber-950/20',
    pink:    'border-pink-700/40 bg-pink-950/20',
  }
  const badgeMap: Record<string, string> = {
    emerald: 'bg-emerald-900/60 text-emerald-400',
    amber:   'bg-amber-900/60 text-amber-400',
    pink:    'bg-pink-900/60 text-pink-400',
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setStatus('parsing')
    setResult(null)
    setParseErrors([])

    const text = await file.text()
    const { rows, errors } = parseCSV(text, channel.id)
    setParseErrors(errors)

    if (rows.length === 0) { setStatus('error'); return }

    setStatus('uploading')
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channel.id, rows }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResult({ inserted: data.inserted, errors })
      setStatus('done')
      onSuccess()
    } catch (err: any) {
      setParseErrors(prev => [...prev, err.message])
      setStatus('error')
    }

    // Reset file input so same file can be re-uploaded
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div className={`rounded-xl border p-5 space-y-4 ${colorMap[channel.color]}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white">{channel.label}</h3>
          <p className="text-xs text-gray-500 mt-0.5">{channel.hint}</p>
        </div>
        {status === 'done' && (
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${badgeMap[channel.color]}`}>
            ✓ {result?.inserted} rows
          </span>
        )}
      </div>

      <label className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg px-4 py-6 cursor-pointer transition-colors ${
        status === 'uploading' || status === 'parsing'
          ? 'border-gray-600 opacity-60'
          : 'border-gray-700 hover:border-gray-500'
      }`}>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={handleFile}
          disabled={status === 'uploading' || status === 'parsing'}
        />
        {status === 'idle' || status === 'done' || status === 'error' ? (
          <>
            <span className="text-2xl mb-1">📂</span>
            <span className="text-sm text-gray-400">
              {status === 'done' ? 'Upload another CSV' : 'Click to upload CSV'}
            </span>
          </>
        ) : (
          <>
            <span className="text-2xl mb-1 animate-spin">⏳</span>
            <span className="text-sm text-gray-400">
              {status === 'parsing' ? 'Parsing…' : 'Uploading to Supabase…'}
            </span>
          </>
        )}
      </label>

      {parseErrors.length > 0 && (
        <div className="space-y-1">
          {parseErrors.slice(0, 3).map((e, i) => (
            <p key={i} className="text-xs text-red-400">⚠ {e}</p>
          ))}
          {parseErrors.length > 3 && (
            <p className="text-xs text-red-400">…and {parseErrors.length - 3} more warnings</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Manual entry form ─────────────────────────────────────────────────────────
const MANUAL_FIELDS = [
  { key: 'shopify',      label: 'Shopify Revenue'    },
  { key: 'tiktok',       label: 'TikTok Revenue'     },
  { key: 'tiktok_spend', label: 'TikTok Ads Spend'   },
  { key: 'meta_spend',   label: 'Meta Ads Spend'     },
]

function ManualEntry({ onSuccess }: { onSuccess: () => void }) {
  const [date, setDate]     = useState(new Date().toISOString().slice(0, 10))
  const [values, setValues] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<'idle'|'saving'|'done'|'error'>('idle')
  const [msg, setMsg]       = useState('')

  async function handleSave() {
    const rows: {channel: string; rows: {date:string; value:number}[]}[] = []

    for (const [key, val] of Object.entries(values)) {
      const num = parseFloat(val.replace(/[$,]/g, ''))
      if (!isNaN(num) && val.trim() !== '') {
        rows.push({ channel: key, rows: [{ date, value: num }] })
      }
    }

    if (rows.length === 0) { setMsg('Enter at least one value.'); setStatus('error'); return }

    setStatus('saving')
    try {
      await Promise.all(rows.map(r =>
        fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r),
        })
      ))
      setMsg(`Saved ${rows.length} field${rows.length > 1 ? 's' : ''} for ${date}`)
      setStatus('done')
      setValues({})
      onSuccess()
    } catch (e: any) {
      setMsg(e.message)
      setStatus('error')
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-white">Manual Entry</h3>
        <p className="text-xs text-gray-500 mt-0.5">Enter values for a single day — leave blank to skip</p>
      </div>

      <div>
        <label className="text-xs text-gray-500 uppercase tracking-wider font-medium block mb-1.5">Date</label>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        {MANUAL_FIELDS.map(f => (
          <div key={f.key}>
            <label className="text-xs text-gray-500 uppercase tracking-wider font-medium block mb-1.5">{f.label}</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={values[f.key] ?? ''}
                onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={status === 'saving'}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <p className={`text-sm ${status === 'done' ? 'text-emerald-400' : 'text-red-400'}`}>{msg}</p>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function DataManager() {
  const queryClient = useQueryClient()

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ['overview'] })
    queryClient.invalidateQueries({ queryKey: ['channels'] })
    queryClient.invalidateQueries({ queryKey: ['levers'] })
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white">Data Manager</h2>
        <p className="text-gray-400 text-sm mt-0.5">Upload CSV exports or enter values manually — data syncs instantly to all tabs</p>
      </div>

      {/* CSV upload cards */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">CSV Upload</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {CHANNELS.map(ch => (
            <UploadCard key={ch.id} channel={ch} onSuccess={invalidateAll} />
          ))}
        </div>
      </div>

      {/* Manual entry */}
      <ManualEntry onSuccess={invalidateAll} />

      {/* CSV format guide */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300">CSV Format Guide</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs text-gray-400">
          <div>
            <p className="font-medium text-gray-300 mb-2">Shopify</p>
            <p className="text-gray-500 mb-1">Export from: Analytics → Reports → Sales over time</p>
            <code className="block bg-gray-800 rounded p-2 text-gray-300">
              Date,Net sales<br/>
              2026-05-01,4521.00<br/>
              2026-05-02,3890.50
            </code>
          </div>
          <div>
            <p className="font-medium text-gray-300 mb-2">TikTok Shop</p>
            <p className="text-gray-500 mb-1">Export from: Seller Center → Analytics → Revenue</p>
            <code className="block bg-gray-800 rounded p-2 text-gray-300">
              Date,Revenue<br/>
              2026-05-01,1200.00<br/>
              2026-05-02,980.00
            </code>
          </div>
          <div>
            <p className="font-medium text-gray-300 mb-2">TikTok Ads</p>
            <p className="text-gray-500 mb-1">Export from: TikTok Ads Manager → Reports</p>
            <code className="block bg-gray-800 rounded p-2 text-gray-300">
              Date,Spend<br/>
              2026-05-01,350.00<br/>
              2026-05-02,420.00
            </code>
          </div>
          <div>
            <p className="font-medium text-gray-300 mb-2">Meta Ads</p>
            <p className="text-gray-500 mb-1">Export from: Ads Manager → Reports → Export</p>
            <code className="block bg-gray-800 rounded p-2 text-gray-300">
              Date,Amount spent<br/>
              2026-05-01,280.00<br/>
              2026-05-02,310.00
            </code>
          </div>
        </div>
      </div>
    </div>
  )
}

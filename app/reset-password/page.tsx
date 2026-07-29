'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'

/**
 * Set-new-password page. The recovery email link signs the user in via
 * /auth/callback?next=/reset-password, so by the time they land here there is
 * an active (recovery) session and auth.updateUser can change the password.
 */
export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [done,     setDone]     = useState(false)
  const [hasSession, setHasSession] = useState<boolean | null>(null)

  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setHasSession(!!data.session))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) { setError(error.message); setLoading(false); return }
    setDone(true)
    setTimeout(() => { window.location.href = '/' }, 1500)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-white">X PRO Dashboard</h1>
          <p className="mt-1 text-sm text-gray-400">Set a new password</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 shadow-xl">
          {hasSession === false ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-gray-300">
                This link has expired or was already used.
              </p>
              <a href="/login" className="inline-block text-sm font-medium text-indigo-400 hover:text-indigo-300">
                ← Back to sign in (use “Forgot password?” for a fresh link)
              </a>
            </div>
          ) : done ? (
            <p className="text-sm text-emerald-400 text-center">
              ✓ Password updated — taking you to the dashboard…
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="new-password" className="block text-sm font-medium text-gray-300 mb-1.5">
                  New password
                </label>
                <input
                  id="new-password" type="password" required autoComplete="new-password"
                  value={password} onChange={e => setPassword(e.target.value)}
                  className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
                  placeholder="At least 8 characters"
                />
              </div>
              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-300 mb-1.5">
                  Confirm password
                </label>
                <input
                  id="confirm-password" type="password" required autoComplete="new-password"
                  value={confirm} onChange={e => setConfirm(e.target.value)}
                  className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
                  placeholder="Repeat the password"
                />
              </div>
              {error && (
                <p className="text-sm text-red-400 bg-red-950/50 border border-red-800 rounded-lg px-3.5 py-2.5">
                  {error}
                </p>
              )}
              <button
                type="submit" disabled={loading}
                className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-semibold text-white transition focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-900"
              >
                {loading ? 'Saving…' : 'Set new password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

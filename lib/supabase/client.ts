/**
 * Browser-side Supabase client.
 *
 * Use this in Client Components ("use client").
 * The anon key is safe here — Supabase RLS policies enforce access control.
 */
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

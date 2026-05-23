/**
 * Server-side Supabase client.
 *
 * Use this in Server Components, Route Handlers, and Server Actions.
 * Reads cookies so the user's session is available server-side.
 */
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // setAll is called from a Server Component — cookies can't be set
            // there; the middleware handles session refresh instead.
          }
        },
      },
    },
  )
}

/**
 * Admin client that bypasses RLS.
 * Only used in server-side cron jobs / data ingestion routes.
 * NEVER import this in a Client Component.
 */
export function createAdminClient() {
  const { createClient } = require('@supabase/supabase-js')
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

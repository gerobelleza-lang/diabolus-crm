import { createClient } from '@supabase/supabase-js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adminClient: any = null

/**
 * Devuelve un cliente Supabase con service_role key.
 * Singleton — se crea una sola vez por instancia de función.
 *
 * TODO: Generate database types with `supabase gen types typescript`
 * and replace `any` with the generated Database type.
 */
export function getSupabaseAdmin() {
  if (!adminClient) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!url || !key) {
      throw new Error(
        'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables'
      )
    }

    adminClient = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }
  return adminClient
}

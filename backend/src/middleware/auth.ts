import { createMiddleware } from 'hono/factory'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = {
  userId: string
  salonId: string
  userEmail: string
}

// Demo credentials (real UUIDs so FK constraints pass)
const DEMO_USER_ID = '43c8e1f2-0724-4cff-897b-77376c094017'
const DEMO_SALON_ID = 'e3cdcbf9-de82-44d8-81e4-e4348dce6714'
const DEMO_EMAIL = 'admin@diabolus.local'

export const authMiddleware = createMiddleware<{ Variables: Variables }>(
  async (c, next) => {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized: missing token' }, 401)
    }

    const token = auth.slice(7)
    const isDev = token.startsWith('dev_') || token.startsWith('demo_')

    // DEV MODE: accept demo token with real UUIDs — ONLY in non-production
    const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'
    if (isDev && !isProduction) {
      c.set('userId', DEMO_USER_ID)
      c.set('salonId', DEMO_SALON_ID)
      c.set('userEmail', DEMO_EMAIL)
      return next()
    }

    // SECURITY: Block dev tokens in production
    if (isDev && isProduction) {
      console.error(`[SECURITY] Dev token attempted in production: ${token.substring(0, 10)}...`)
      return c.json({ error: 'Unauthorized: dev tokens disabled in production' }, 401)
    }

    // PROD MODE: validate against Supabase
    const supabase = getSupabaseAdmin()

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token)

    if (error || !user) {
      return c.json({ error: 'Unauthorized: invalid token' }, 401)
    }

    // Resolver salon del usuario (columna: user_id)
    const { data: salon } = await supabase
      .from('salons')
      .select('id')
      .eq('user_id', user.id)
      .single()

    if (!salon) {
      return c.json({ error: 'Forbidden: no salon associated to this user' }, 403)
    }

    c.set('userId', user.id)
    c.set('salonId', salon.id)
    c.set('userEmail', user.email ?? '')

    await next()
  }
)

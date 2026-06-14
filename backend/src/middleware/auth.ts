// @ts-nocheck
import { createMiddleware } from 'hono/factory'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = {
  userId: string
  salonId: string
  userEmail: string
}

export const authMiddleware = createMiddleware<{ Variables: Variables }>(
  async (c, next) => {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized: missing token' }, 401)
    }

    const token = auth.slice(7)
    const isDev = token.startsWith('dev_') || token.startsWith('demo_')

    // DEV MODE: accept any demo token
    if (isDev) {
      c.set('userId', 'dev-user')
      c.set('salonId', 'dev-salon')
      c.set('userEmail', 'dev@diabolus.local')
      return next()
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

    // Resolver salon del usuario
    const { data: salon } = await supabase
      .from('salons')
      .select('id')
      .eq('owner_id', user.id)
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

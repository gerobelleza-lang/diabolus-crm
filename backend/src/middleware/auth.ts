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

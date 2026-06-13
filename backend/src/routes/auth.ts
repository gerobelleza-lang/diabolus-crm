import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

export const authRoutes = new Hono()

// POST /auth/login
authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.email || !body?.password) {
    return c.json({ error: 'Email and password are required' }, 400)
  }

  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase.auth.signInWithPassword({
    email: body.email,
    password: body.password,
  })

  if (error || !data.session) {
    return c.json({ error: error?.message ?? 'Invalid credentials' }, 401)
  }

  // Obtener salon del usuario
  const { data: salon } = await supabase
    .from('salons')
    .select('id, name')
    .eq('owner_id', data.user.id)
    .single()

  return c.json({
    token: data.session.access_token,
    user: {
      id: data.user.id,
      email: data.user.email,
    },
    salon: salon ?? null,
  })
})

// GET /auth/me
authRoutes.get('/me', async (c) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const token = auth.slice(7)
  const supabase = getSupabaseAdmin()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token)

  if (error || !user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const { data: salon } = await supabase
    .from('salons')
    .select('*')
    .eq('owner_id', user.id)
    .single()

  return c.json({
    user: { id: user.id, email: user.email },
    salon: salon ?? null,
  })
})

// POST /auth/logout
authRoutes.post('/logout', (c) => {
  return c.json({ message: 'Logged out' })
})

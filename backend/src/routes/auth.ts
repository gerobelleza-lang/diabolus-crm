// @ts-nocheck
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { sendWelcomeEmail } from '../integrations/email'

export const authRoutes = new Hono()

// ── POST /auth/register — BETA PRIVADA: registro desactivado ──────────────────
authRoutes.post('/register', async (c) => {
  return c.json({
    error: 'Registro cerrado — Diabolus está en beta privada. Contacta con el equipo para obtener acceso.',
    code: 'BETA_LOCKED',
  }, 423)
})

// ── POST /auth/login ──────────────────────────────────────────────────────────
authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.email || !body?.password) {
    return c.json({ error: 'Email y contraseña requeridos' }, 400)
  }

  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase.auth.signInWithPassword({
    email: body.email,
    password: body.password,
  })

  if (error || !data.session) {
    return c.json({ error: error?.message ?? 'Credenciales incorrectas' }, 401)
  }

  // Busca el salón del usuario (columna correcta: user_id)
  const { data: salon } = await supabase
    .from('salons')
    .select('id, name, onboarding_completed, onboarding_step')
    .eq('user_id', data.user.id)
    .maybeSingle()

  return c.json({
    token: data.session.access_token,
    user: {
      id: data.user.id,
      email: data.user.email,
    },
    salon: salon ?? null,
  })
})

// ── GET /auth/me ──────────────────────────────────────────────────────────────
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
    .eq('user_id', user.id)
    .maybeSingle()

  return c.json({
    user: { id: user.id, email: user.email },
    salon: salon ?? null,
  })
})

// ── POST /auth/logout ─────────────────────────────────────────────────────────
authRoutes.post('/logout', (c) => {
  return c.json({ message: 'Sesión cerrada' })
})

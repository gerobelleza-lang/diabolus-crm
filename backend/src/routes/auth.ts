// @ts-nocheck
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { sendWelcomeEmail } from '../integrations/email'

export const authRoutes = new Hono()

// ── POST /auth/register — BETA PRIVADA: solo con token de invitación ──────────
authRoutes.post('/register', async (c) => {
  const body = await c.req.json().catch(() => null)
  const betaToken = body?.beta_invite_token

  if (!betaToken) {
    return c.json({
      error: 'Registro cerrado — Diabolus está en beta privada. Necesitas una invitación.',
      code: 'BETA_LOCKED',
    }, 423)
  }

  const supabase = getSupabaseAdmin()

  // Validar token de invitación
  const { data: invite, error: inviteErr } = await supabase
    .from('beta_invites')
    .select('id, email_hint, expires_at, used_at')
    .eq('token', betaToken)
    .is('used_at', null)
    .maybeSingle()

  if (inviteErr || !invite) {
    return c.json({ error: 'Invitación inválida o ya utilizada', code: 'INVALID_INVITE' }, 403)
  }

  if (new Date(invite.expires_at) < new Date()) {
    return c.json({ error: 'Esta invitación ha caducado', code: 'INVITE_EXPIRED' }, 403)
  }

  if (!body?.email || !body?.password || !body?.businessName) {
    return c.json({ error: 'Email, contraseña y nombre del negocio son obligatorios' }, 400)
  }

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
  })

  if (authError || !authData?.user) {
    return c.json({ error: authError?.message ?? 'Error al crear la cuenta' }, 400)
  }

  const userId = authData.user.id

  const { data: salon, error: salonError } = await supabase
    .from('salons')
    .insert({
      user_id: userId,
      name: body.businessName,
      onboarding_completed: false,
      onboarding_step: 1,
      plan: 'basico',
    })
    .select()
    .single()

  if (salonError) {
    return c.json({ error: 'Error al crear el negocio' }, 500)
  }

  await supabase
    .from('beta_invites')
    .update({ used_at: new Date().toISOString(), used_by: userId })
    .eq('id', invite.id)

  const { data: loginData } = await supabase.auth.signInWithPassword({
    email: body.email,
    password: body.password,
  })

  try {
    await sendWelcomeEmail(body.email, body.businessName)
  } catch {}

  return c.json({
    token:         loginData?.session?.access_token ?? null,
    refresh_token: loginData?.session?.refresh_token ?? null,
    user:          { id: userId, email: body.email },
    salon:         { id: salon.id, name: salon.name },
  })
})

// ── GET /auth/invites/validate — validar token (público) ─────────────────────
authRoutes.get('/invites/validate', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ valid: false, error: 'Token requerido' }, 400)

  const supabase = getSupabaseAdmin()
  const { data: invite } = await supabase
    .from('beta_invites')
    .select('id, email_hint, expires_at, used_at')
    .eq('token', token)
    .is('used_at', null)
    .maybeSingle()

  if (!invite) return c.json({ valid: false, error: 'Invitación inválida o ya utilizada' })
  if (new Date(invite.expires_at) < new Date()) return c.json({ valid: false, error: 'Invitación caducada' })

  return c.json({ valid: true, email_hint: invite.email_hint ?? null })
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

  const { data: salon } = await supabase
    .from('salons')
    .select('id, name, onboarding_completed, onboarding_step')
    .eq('user_id', data.user.id)
    .maybeSingle()

  return c.json({
    token:         data.session.access_token,
    refresh_token: data.session.refresh_token,
    user:          { id: data.user.id, email: data.user.email },
    salon:         salon ?? null,
  })
})

// ── POST /auth/refresh — renovar access_token con refresh_token ───────────────
authRoutes.post('/refresh', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.refresh_token) {
    return c.json({ error: 'refresh_token requerido' }, 400)
  }

  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: body.refresh_token })

  if (error || !data.session) {
    return c.json({ error: 'Sesión caducada — inicia sesión de nuevo', code: 'SESSION_EXPIRED' }, 401)
  }

  const { data: salon } = await supabase
    .from('salons')
    .select('id, name')
    .eq('user_id', data.user.id)
    .maybeSingle()

  return c.json({
    token:         data.session.access_token,
    refresh_token: data.session.refresh_token,
    user:          { id: data.user.id, email: data.user.email },
    salon:         salon ?? null,
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
  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const { data: salon } = await supabase
    .from('salons')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()

  return c.json({ user: { id: user.id, email: user.email }, salon: salon ?? null })
})

// ── POST /auth/logout ─────────────────────────────────────────────────────────
authRoutes.post('/logout', (c) => {
  return c.json({ message: 'Sesión cerrada' })
})

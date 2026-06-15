// @ts-nocheck
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { sendWelcomeEmail } from '../integrations/email'

export const authRoutes = new Hono()

// POST /auth/register — Alta de nuevo tenant
authRoutes.post('/register', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.email || !body?.password || !body?.businessName) {
    return c.json({ error: 'Faltan campos requeridos: email, password, businessName' }, 400)
  }

  if (body.password.length < 6) {
    return c.json({ error: 'La contraseña debe tener al menos 6 caracteres' }, 400)
  }

  const supabase = getSupabaseAdmin()

  // Crear usuario en Supabase Auth (sin email confirmation)
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
  })

  if (authError || !authData.user) {
    const msg = authError?.message ?? 'Error al crear usuario'
    if (msg.includes('already registered')) {
      return c.json({ error: 'Este email ya está registrado' }, 409)
    }
    return c.json({ error: msg }, 400)
  }

  // Crear salon (negocio del tenant)
  const { data: salon, error: salonError } = await supabase
    .from('salons')
    .insert([{
      name: body.businessName,
      owner_id: authData.user.id,
      notify_channel: 'telegram',
    }])
    .select()
    .single()

  if (salonError) {
    // Rollback: eliminar usuario creado
    await supabase.auth.admin.deleteUser(authData.user.id)
    return c.json({ error: 'Error al crear el negocio. Inténtalo de nuevo.' }, 500)
  }

  // Hacer login automático para devolver el token
  const { data: signInData } = await supabase.auth.signInWithPassword({
    email: body.email,
    password: body.password,
  })

  // Enviar email de bienvenida (fire & forget — no bloquea la respuesta)
  sendWelcomeEmail(body.email, body.businessName).catch((err) =>
    console.error('[Email] Error en bienvenida:', err)
  )

  return c.json({
    token: signInData?.session?.access_token ?? null,
    user: {
      id: authData.user.id,
      email: authData.user.email,
    },
    salon,
    message: '¡Bienvenido a Diabolus! Tu negocio está listo.',
  }, 201)
})

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

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

export const salonsRoutes = new Hono()

// GET /api/salons/mine — lista todos los salones del usuario autenticado
salonsRoutes.get('/mine', async (c) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)

  const token = auth.slice(7)
  const supabase = getSupabaseAdmin()

  const { data: { user }, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !user) return c.json({ error: 'Unauthorized' }, 401)

  const { data: salons, error } = await supabase
    .from('salons')
    .select('id, name, plan, is_active, onboarding_completed')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)

  return c.json({ salons: salons ?? [] })
})

// POST /api/salons — crea un nuevo negocio bajo el mismo usuario
salonsRoutes.post('/', async (c) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)

  const token = auth.slice(7)
  const body = await c.req.json().catch(() => null)
  if (!body?.name?.trim()) return c.json({ error: 'El nombre del negocio es obligatorio' }, 400)

  const supabase = getSupabaseAdmin()
  const { data: { user }, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !user) return c.json({ error: 'Unauthorized' }, 401)

  const { data: salon, error } = await supabase
    .from('salons')
    .insert({
      user_id: user.id,
      name: body.name.trim(),
      onboarding_completed: false,
      onboarding_step: 1,
      plan: 'basico',
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)

  return c.json({ salon })
})

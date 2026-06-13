import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }

export const clientRoutes = new Hono<{ Variables: Variables }>()

// GET /api/clients
clientRoutes.get('/', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()
  const { search } = c.req.query()

  let query = supabase
    .from('clients')
    .select('*')
    .eq('salon_id', salonId)
    .order('created_at', { ascending: false })

  if (search) {
    query = query.ilike('name', `%${search}%`)
  }

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ clients: data })
})

// GET /api/clients/:id
clientRoutes.get('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()

  if (error) return c.json({ error: 'Client not found' }, 404)
  return c.json({ client: data })
})

// POST /api/clients
clientRoutes.post('/', async (c) => {
  const salonId = c.get('salonId')
  const body = await c.req.json()
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('clients')
    .insert({ ...body, salon_id: salonId })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ client: data }, 201)
})

// PATCH /api/clients/:id
clientRoutes.patch('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const body = await c.req.json()
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('clients')
    .update(body)
    .eq('salon_id', salonId)
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ client: data })
})

// DELETE /api/clients/:id
clientRoutes.delete('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  const { error } = await supabase
    .from('clients')
    .delete()
    .eq('salon_id', salonId)
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ message: 'Client deleted' })
})

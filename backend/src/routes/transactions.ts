import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }

export const transactionRoutes = new Hono<{ Variables: Variables }>()

// GET /api/transactions
transactionRoutes.get('/', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()
  const { page = '1', limit = '50', type } = c.req.query()
  const from = (parseInt(page) - 1) * parseInt(limit)
  const to = from + parseInt(limit) - 1

  let query = supabase
    .from('transactions')
    .select('*, clients(name)', { count: 'exact' })
    .eq('salon_id', salonId)
    .order('created_at', { ascending: false })
    .range(from, to)

  if (type) query = query.eq('type', type)

  const { data, error, count } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ transactions: data, total: count, page: parseInt(page), limit: parseInt(limit) })
})

// GET /api/transactions/:id
transactionRoutes.get('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('transactions')
    .select('*, clients(name)')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()

  if (error) return c.json({ error: 'Transaction not found' }, 404)
  return c.json({ transaction: data })
})

// POST /api/transactions
transactionRoutes.post('/', async (c) => {
  const salonId = c.get('salonId')
  const userId = c.get('userId')
  const body = await c.req.json()
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('transactions')
    .insert({
      ...body,
      salon_id: salonId,
      created_by_user_id: userId,
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ transaction: data }, 201)
})

// DELETE /api/transactions/:id
transactionRoutes.delete('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  const { error } = await supabase
    .from('transactions')
    .delete()
    .eq('salon_id', salonId)
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ message: 'Transaction deleted' })
})

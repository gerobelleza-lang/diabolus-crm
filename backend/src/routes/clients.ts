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


// GET /api/clients/:id/ficha — Ficha cliente 360°
clientRoutes.get('/:id/ficha', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  // Parallel fetch: client + invoices + transactions + audit_log (reminders)
  const [clientRes, invoicesRes, transactionsRes, auditRes] = await Promise.all([
    supabase
      .from('clients')
      .select('*')
      .eq('salon_id', salonId)
      .eq('id', id)
      .single(),
    supabase
      .from('invoices')
      .select('id, number, total, amount, status, date, due_date, description, iva_pct, sent_at, created_at')
      .eq('salon_id', salonId)
      .eq('client_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('transactions')
      .select('id, type, amount, concept, date, category, tags, status, created_at')
      .eq('salon_id', salonId)
      .eq('client_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('audit_log')
      .select('id, tool_name, payload, result, confirmed, created_at')
      .eq('salon_id', salonId)
      .or(`payload->>client_id.eq.${id},payload->>clientId.eq.${id}`)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  if (clientRes.error) return c.json({ error: 'Client not found' }, 404)

  const invoices = invoicesRes.data || []
  const transactions = transactionsRes.data || []
  const auditLog = auditRes.data || []

  // Compute summary stats
  const totalFacturado = invoices.reduce((s, i) => s + Number(i.total || 0), 0)
  const totalCobrado = invoices
    .filter(i => i.status === 'paid')
    .reduce((s, i) => s + Number(i.total || 0), 0)
  const deudaPendiente = invoices
    .filter(i => ['pending', 'sent', 'overdue'].includes(i.status))
    .reduce((s, i) => s + Number(i.total || 0), 0)
  const totalPagos = transactions
    .filter(t => t.type === 'income')
    .reduce((s, t) => s + Number(t.amount || 0), 0)
  const recordatoriosEnviados = auditLog.filter(a =>
    a.tool_name === 'send_reminder' || a.tool_name === 'cazador_reminder'
  ).length

  // Last interaction: most recent of any activity
  const dates = [
    ...invoices.map(i => i.created_at),
    ...transactions.map(t => t.created_at),
    ...auditLog.map(a => a.created_at),
  ].filter(Boolean).sort().reverse()
  const ultimaActividad = dates[0] || clientRes.data.created_at

  return c.json({
    client: clientRes.data,
    invoices,
    transactions,
    auditLog,
    summary: {
      totalFacturado,
      totalCobrado,
      deudaPendiente,
      totalPagos,
      facturas: invoices.length,
      pagos: transactions.length,
      recordatoriosEnviados,
      ultimaActividad,
    }
  })
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

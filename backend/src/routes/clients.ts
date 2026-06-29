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

  const [clientRes, invoicesRes, transactionsRes, cazadorRes] = await Promise.all([
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
      .order('date', { ascending: false }),
    supabase
      .from('transactions')
      .select('id, type, amount, concept, date, category, tags, status, created_at')
      .eq('salon_id', salonId)
      .eq('client_id', id)
      .order('date', { ascending: false }),
    supabase
      .from('cobros_cazador')
      .select('id, invoice_id, client_id, level, sent_at, channel, status, message_sent, tone')
      .eq('salon_id', salonId)
      .eq('client_id', id)
      .order('sent_at', { ascending: false }),
  ])

  if (clientRes.error || !clientRes.data) return c.json({ error: 'Client not found' }, 404)

  const invoices = invoicesRes.data || []
  const transactions = transactionsRes.data || []
  const cazador = cazadorRes.data || []

  const hoy = new Date()

  // ── KPIs ──
  const totalFacturado = invoices.reduce((s, i) => s + Number(i.total || i.amount || 0), 0)
  const pagadas = invoices.filter(i => i.status === 'paid')
  const totalCobrado = pagadas.reduce((s, i) => s + Number(i.total || i.amount || 0), 0)

  const pendientes = invoices.filter(i => i.status !== 'paid')
  const saldoPendiente = pendientes.reduce((s, i) => s + Number(i.total || i.amount || 0), 0)

  const vencidas = pendientes.filter(i => i.due_date && new Date(i.due_date) < hoy)
  const numVencidas = vencidas.length
  const importeVencido = vencidas.reduce((s, i) => s + Number(i.total || i.amount || 0), 0)

  // DSO: approximate using income transactions after invoice date
  let dso = null
  if (pagadas.length > 0) {
    const incomeTxns = transactions.filter(t => t.type === 'income').sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    let totalDays = 0
    let counted = 0
    for (const inv of pagadas) {
      const invDate = new Date(inv.date)
      const matchingTxn = incomeTxns.find(t => new Date(t.date) >= invDate)
      if (matchingTxn) {
        const days = Math.round((new Date(matchingTxn.date).getTime() - invDate.getTime()) / 86400000)
        totalDays += Math.max(0, days)
        counted++
      }
    }
    dso = counted > 0 ? Math.round(totalDays / counted) : null
  }

  // Semáforo de salud
  const maxDiasVencido = vencidas.length > 0
    ? Math.max(...vencidas.map(i => Math.round((hoy.getTime() - new Date(i.due_date!).getTime()) / 86400000)))
    : 0
  const salud = numVencidas >= 2 || maxDiasVencido > 60 ? 'rojo'
    : numVencidas === 1 ? 'amarillo'
    : 'verde'

  const totalPagos = transactions
    .filter(t => t.type === 'income')
    .reduce((s, t) => s + Number(t.amount || 0), 0)

  // Última actividad
  const dates = [
    ...invoices.map(i => i.created_at),
    ...transactions.map(t => t.created_at),
    ...cazador.map(r => r.sent_at),
  ].filter(Boolean).sort().reverse()
  const ultimaActividad = dates[0] || clientRes.data.created_at

  // Timeline unificado
  const timeline = [
    ...invoices.map(i => ({
      type: 'invoice' as const,
      date: i.date || i.created_at,
      id: i.id,
      number: i.number,
      amount: Number(i.total || i.amount || 0),
      status: i.status,
      due_date: i.due_date,
    })),
    ...transactions.filter(t => t.type === 'income').map(t => ({
      type: 'payment' as const,
      date: t.date || t.created_at,
      id: t.id,
      amount: Number(t.amount || 0),
      concept: t.concept,
      category: t.category,
    })),
    ...cazador.map(r => ({
      type: 'reminder' as const,
      date: r.sent_at,
      id: r.id,
      level: r.level,
      channel: r.channel,
      tone: r.tone,
      status: r.status,
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  return c.json({
    client: clientRes.data,
    kpis: {
      totalFacturado,
      totalCobrado,
      saldoPendiente,
      importeVencido,
      numFacturas: invoices.length,
      numVencidas,
      dso,
      salud,
      totalPagos,
      ultimaActividad,
    },
    timeline,
    invoices,
    transactions,
    cazador,
  })
})

// PUT /api/clients/:id/cazador-pause — Pause/resume Cazador reminders
clientRoutes.put('/:id/cazador-pause', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const body = await c.req.json()
  const supabase = getSupabaseAdmin()

  const { paused_until } = body

  const { data, error } = await supabase
    .from('clients')
    .update({ cazador_paused_until: paused_until })
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

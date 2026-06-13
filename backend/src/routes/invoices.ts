import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { getSignatureProvider } from '../integrations/signature/factory'

type Variables = { userId: string; salonId: string }

export const invoiceRoutes = new Hono<{ Variables: Variables }>()

// GET /api/invoices
invoiceRoutes.get('/', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('invoices')
    .select('*, clients(name, email)')
    .eq('salon_id', salonId)
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ invoices: data })
})

// GET /api/invoices/:id
invoiceRoutes.get('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('invoices')
    .select('*, clients(name, email)')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()

  if (error) return c.json({ error: 'Invoice not found' }, 404)
  return c.json({ invoice: data })
})

// POST /api/invoices — Crear + Firmar
invoiceRoutes.post('/', async (c) => {
  const salonId = c.get('salonId')
  const userId = c.get('userId')
  const body = await c.req.json()
  const supabase = getSupabaseAdmin()

  // Validar cliente
  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('name, email')
    .eq('id', body.client_id)
    .eq('salon_id', salonId)
    .single()

  if (clientError || !client) {
    return c.json({ error: 'Client not found' }, 404)
  }

  // Firmar con SignatureProvider
  const provider = getSignatureProvider()
  const signed = await provider.sign({
    invoiceId: crypto.randomUUID(),
    amount: body.amount,
    currency: 'EUR',
    clientName: client.name,
    clientEmail: client.email ?? '',
    description: body.description,
    timestamp: new Date(),
    salonId,
  })

  // Guardar en DB
  const { data, error } = await supabase
    .from('invoices')
    .insert({
      salon_id: salonId,
      client_id: body.client_id,
      amount: body.amount,
      description: body.description,
      status: 'signed',
      signed_document: signed.signedDocument,
      hash: signed.hash,
      signature: signed.signature,
      provider_reference: signed.providerReference,
      created_by_user_id: userId,
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)

  return c.json(
    {
      invoice: data,
      signature: {
        hash: signed.hash,
        provider: provider.getInfo().name,
        timestamp: signed.timestamp,
      },
    },
    201
  )
})

// PATCH /api/invoices/:id/status
invoiceRoutes.patch('/:id/status', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const { status } = await c.req.json()
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('invoices')
    .update({ status })
    .eq('salon_id', salonId)
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ invoice: data })
})

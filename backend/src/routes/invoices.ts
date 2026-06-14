// @ts-nocheck
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
    .select('*, clients(name, email, phone)')
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
    .select('*, clients(name, email, phone)')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()

  if (error) return c.json({ error: 'Invoice not found' }, 404)
  return c.json({ invoice: data })
})

// POST /api/invoices
invoiceRoutes.post('/', async (c) => {
  const salonId = c.get('salonId')
  const userId = c.get('userId')
  const body = await c.req.json()
  const supabase = getSupabaseAdmin()

  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('name, email, phone')
    .eq('id', body.client_id)
    .eq('salon_id', salonId)
    .single()

  if (clientError || !client) {
    return c.json({ error: 'Client not found' }, 404)
  }

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

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      salon_id: salonId,
      client_id: body.client_id,
      status: 'draft',
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)

  return c.json({ invoice: data }, 201)
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

// POST /api/invoices/:id/send-whatsapp
// Envia factura por WhatsApp al cliente via Twilio (texto, sin PDF por ahora)
invoiceRoutes.post('/:id/send-whatsapp', async (c) => {
  try {
    const salonId = c.get('salonId')
    const { id } = c.req.param()
    const supabase = getSupabaseAdmin()

    // 1. Obtener factura
    const { data: invoice, error } = await supabase
      .from('invoices')
      .select('*, clients(name, email, phone), salons(name)')
      .eq('salon_id', salonId)
      .eq('id', id)
      .single()

    if (error || !invoice) return c.json({ error: 'Invoice not found' }, 404)

    const clientPhone = invoice.clients?.phone
    if (!clientPhone) {
      return c.json({ error: 'Client has no phone number' }, 400)
    }

    // 2. Preparar mensaje
    const invoiceNum = invoice.number || `INV-${invoice.id.slice(0, 8).toUpperCase()}`
    const amount = invoice.amount ?? invoice.total ?? 0
    const invoiceDate = new Date(invoice.created_at).toLocaleDateString('es-ES')

    const messageBody =
      `\ud83e\uddfe *Factura de ${invoice.salons?.name || 'Diabolus CRM'}*\n\n` +
      `Hola ${invoice.clients?.name || 'cliente'},\n\n` +
      `Te enviamos tu factura:\n` +
      `\ud83d\udcc4 *${invoiceNum}*\n` +
      `\ud83d\udcb0 Importe: *\u20ac${Number(amount).toFixed(2)}*\n` +
      `\ud83d\udcc5 Fecha: ${invoiceDate}\n\n` +
      `_Enviado desde Diabolus CRM_`

    // 3. Limpiar telefono
    let toPhone = clientPhone.replace(/\s/g, '')
    if (!toPhone.startsWith('+')) toPhone = '+34' + toPhone
    const twilioTo = `whatsapp:${toPhone}`

    // 4. Credenciales Twilio
    const twilioSid = process.env.TWILIO_ACCOUNT_SID
    const twilioToken = process.env.TWILIO_AUTH_TOKEN
    const twilioFrom = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'

    let whatsappResult

    if (twilioSid && twilioToken) {
      const twilioPayload = new URLSearchParams({
        From: twilioFrom,
        To: twilioTo,
        Body: messageBody,
      })

      const twilioResponse = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + btoa(`${twilioSid}:${twilioToken}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: twilioPayload.toString(),
        }
      )

      const twilioData = await twilioResponse.json()

      if (!twilioResponse.ok) {
        return c.json({
          error: 'Twilio error',
          details: twilioData?.message || JSON.stringify(twilioData),
          code: twilioData?.code,
        }, 500)
      }

      whatsappResult = { status: 'sent', messageId: twilioData.sid }

      // Actualizar estado
      await supabase
        .from('invoices')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', id)
        .eq('salon_id', salonId)
    } else {
      whatsappResult = { status: 'demo', messageId: `demo_${Date.now()}`, mock: true }
    }

    return c.json({
      success: true,
      invoice_id: id,
      invoice_number: invoiceNum,
      client: invoice.clients?.name,
      phone: toPhone,
      whatsapp: whatsappResult,
    })

  } catch (err) {
    console.error('[send-whatsapp] Unexpected error:', err)
    return c.json({ error: 'Internal error', details: String(err) }, 500)
  }
})

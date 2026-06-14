// @ts-nocheck
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { generateInvoicePDF } from '../utils/invoice-pdf'

type Variables = { userId: string; salonId: string }

export const invoiceRoutes = new Hono<{ Variables: Variables }>()

// GET /api/invoices/ping
invoiceRoutes.get('/ping', async (c) => {
  return c.json({ ok: true, ts: Date.now(), env: {
    twilio_sid: !!process.env.TWILIO_ACCOUNT_SID,
    twilio_token: !!process.env.TWILIO_AUTH_TOKEN,
    twilio_from: process.env.TWILIO_WHATSAPP_FROM || 'not set',
    supabase_url: !!process.env.SUPABASE_URL,
  }})
})

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
  const body = await c.req.json().catch(() => ({}))
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('invoices')
    .insert({
      salon_id: salonId,
      client_id: body.client_id,
      number: body.number || `FAC-${Date.now()}`,
      total: body.total || body.amount || 0,
      status: 'draft',
      date: new Date().toISOString().split('T')[0],
      description: body.description || '',
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

// GET /api/invoices/:id/pdf
invoiceRoutes.get('/:id/pdf', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()
  const { data: invoice, error } = await supabase
    .from('invoices')
    .select('*, clients(name, email, phone), salons(name)')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()
  if (error || !invoice) return c.json({ error: 'Invoice not found' }, 404)
  try {
    const pdfBytes = await generateInvoicePDF(invoice)
    const invoiceNum = invoice.number || `INV-${invoice.id.slice(0, 8).toUpperCase()}`
    return new Response(pdfBytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${invoiceNum}.pdf"`,
        'Content-Length': String(pdfBytes.length),
      },
    })
  } catch (err) {
    return c.json({ error: 'Error generating PDF', details: String(err) }, 500)
  }
})

// POST /api/invoices/:id/send-whatsapp
invoiceRoutes.post('/:id/send-whatsapp', async (c) => {
  try {
    const salonId = c.get('salonId')
    const { id } = c.req.param()
    const supabase = getSupabaseAdmin()

    const { data: invoice, error } = await supabase
      .from('invoices')
      .select('*, clients(name, email, phone), salons(name)')
      .eq('salon_id', salonId)
      .eq('id', id)
      .single()

    if (error || !invoice) return c.json({ error: 'Invoice not found' }, 404)

    const clientPhone = invoice.clients?.phone
    if (!clientPhone) return c.json({ error: 'Client has no phone number' }, 400)

    // Generar PDF
    let pdfUrl = null
    try {
      const pdfBytes = await generateInvoicePDF(invoice)
      const invoiceNum = invoice.number || `INV-${invoice.id.slice(0, 8).toUpperCase()}`
      const fileName = `${salonId}/${invoiceNum}.pdf`
      const { error: uploadError } = await supabase.storage
        .from('invoices')
        .upload(fileName, pdfBytes, { contentType: 'application/pdf', upsert: true })
      if (!uploadError) {
        const { data: urlData } = supabase.storage.from('invoices').getPublicUrl(fileName)
        pdfUrl = urlData?.publicUrl || null
      } else {
        console.error('[Storage]', uploadError.message)
      }
    } catch (pdfErr) {
      console.error('[PDF]', String(pdfErr))
    }

    const invoiceNum = invoice.number || `INV-${invoice.id.slice(0, 8).toUpperCase()}`
    const total = Number(invoice.total ?? invoice.amount ?? 0)
    const invoiceDate = invoice.date
      ? new Date(invoice.date).toLocaleDateString('es-ES')
      : new Date(invoice.created_at).toLocaleDateString('es-ES')

    let messageBody =
      `Factura de ${invoice.salons?.name || 'Diabolus CRM'}\n` +
      `Hola ${invoice.clients?.name || 'cliente'},\n` +
      `Factura: ${invoiceNum}\n` +
      `Importe: EUR${total.toFixed(2)}\n` +
      `Fecha: ${invoiceDate}\n`
    if (pdfUrl) messageBody += `PDF: ${pdfUrl}\n`
    messageBody += `Enviado desde Diabolus CRM`

    let toPhone = clientPhone.replace(/\s/g, '')
    if (!toPhone.startsWith('+')) toPhone = '+34' + toPhone
    const twilioTo = `whatsapp:${toPhone}`

    const twilioSid = process.env.TWILIO_ACCOUNT_SID
    const twilioToken = process.env.TWILIO_AUTH_TOKEN
    const twilioFrom = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'

    if (!twilioSid || !twilioToken) {
      return c.json({ status: 'demo', mock: true, phone: toPhone, pdf_url: pdfUrl })
    }

    const twilioPayload = new URLSearchParams({ From: twilioFrom, To: twilioTo, Body: messageBody })
    if (pdfUrl) twilioPayload.append('MediaUrl', pdfUrl)

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
      return c.json({ error: 'Twilio error', details: twilioData?.message, code: twilioData?.code }, 500)
    }

    await supabase
      .from('invoices')
      .update({ status: 'sent', sent_at: new Date().toISOString(), ...(pdfUrl ? { pdf_url: pdfUrl } : {}) })
      .eq('id', id)

    return c.json({
      success: true,
      invoice_id: id,
      invoice_number: invoiceNum,
      client: invoice.clients?.name,
      phone: toPhone,
      pdf_url: pdfUrl,
      pdf_attached: !!pdfUrl,
      whatsapp_message_id: twilioData.sid,
    })
  } catch (err) {
    return c.json({ error: 'Internal error', details: String(err) }, 500)
  }
})

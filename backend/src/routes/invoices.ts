// @ts-nocheck
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { generateInvoicePDF } from '../utils/invoice-pdf'
import { sendInvoiceSentEmail, sendReminderSentEmail } from '../integrations/email'

type Variables = { userId: string; salonId: string }

export const invoiceRoutes = new Hono<{ Variables: Variables }>()

// Obtiene el email del propietario de un salon
async function getSalonOwnerEmail(salonId: string): Promise<string | null> {
  try {
    const supabase = getSupabaseAdmin()
    const { data: salon } = await supabase
      .from('salons')
      .select('user_id')
      .eq('id', salonId)
      .single()
    if (!salon?.user_id) return null
    const { data } = await supabase.auth.admin.getUserById(salon.user_id)
    return data?.user?.email ?? null
  } catch {
    return null
  }
}

// SELECT de salon completo para PDF
const SALON_PDF_SELECT = 'name, nombre_fiscal, nif, address, email, phone'

// GET /api/invoices/ping
invoiceRoutes.get('/ping', async (c) => {
  return c.json({ ok: true, ts: Date.now() })
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
  if (id === 'ping') return c.json({ ok: true })
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

  const amount  = Number(body.amount  ?? 0)
  const ivaPct  = Number(body.iva_pct ?? 21)
  const total   = Number(body.total   ?? 0) || amount * (1 + ivaPct / 100)

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      salon_id:    salonId,
      client_id:   body.client_id,
      number:      body.number || body.invoice_number || `FAC-${Date.now()}`,
      amount,
      iva_pct:     ivaPct,
      total,
      status:      body.status   || 'pending',
      date:        new Date().toISOString().split('T')[0],
      due_date:    body.due_date || null,
      description: body.description || '',
    })
    .select('*, clients(name, email, phone)')
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

// PATCH /api/invoices/:id — actualización general
invoiceRoutes.patch('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const body = await c.req.json().catch(() => ({}))
  const supabase = getSupabaseAdmin()
  const allowed = ['status', 'description', 'total', 'amount', 'iva_pct', 'due_date', 'number', 'pdf_url']
  const update: Record<string, any> = {}
  for (const k of allowed) {
    if (k in body) update[k] = body[k]
  }
  if (!Object.keys(update).length) return c.json({ error: 'Nothing to update' }, 400)
  const { data, error } = await supabase
    .from('invoices')
    .update(update)
    .eq('salon_id', salonId)
    .eq('id', id)
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ invoice: data })
})

// GET /api/invoices/:id/pdf  — genera y devuelve el PDF directamente (stream)
invoiceRoutes.get('/:id/pdf', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()
  const { data: invoice, error } = await supabase
    .from('invoices')
    .select(`*, clients(name, email, phone), salons(${SALON_PDF_SELECT})`)
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()
  if (error || !invoice) return c.json({ error: 'Invoice not found' }, 404)
  try {
    const pdfBytes = await generateInvoicePDF(invoice)
    const invoiceNum = invoice.number || `FAC-${invoice.id.slice(0, 8).toUpperCase()}`
    return new Response(pdfBytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${invoiceNum}.pdf"`,
        'Content-Length': String(pdfBytes.length),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err) {
    console.error('[PDF] Error:', err)
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
      .select(`*, clients(name, email, phone), salons(${SALON_PDF_SELECT})`)
      .eq('salon_id', salonId)
      .eq('id', id)
      .single()

    if (error || !invoice) return c.json({ error: 'Invoice not found' }, 404)

    const clientPhone = invoice.clients?.phone
    if (!clientPhone) return c.json({ error: 'Client has no phone number' }, 400)

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
      `Importe: ${total.toFixed(2)}€\n` +
      `Fecha: ${invoiceDate}\n`
    if (pdfUrl) messageBody += `PDF: ${pdfUrl}\n`
    messageBody += `Enviado desde Diabolus CRM`

    let toPhone = clientPhone.replace(/\s/g, '')
    if (!toPhone.startsWith('+')) toPhone = '+34' + toPhone
    const twilioTo = `whatsapp:${toPhone}`

    const twilioSid   = process.env.TWILIO_ACCOUNT_SID
    const twilioToken = process.env.TWILIO_AUTH_TOKEN
    const twilioFrom  = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'

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

    getSalonOwnerEmail(salonId).then((ownerEmail) => {
      if (ownerEmail) {
        sendInvoiceSentEmail(
          ownerEmail,
          invoiceNum,
          invoice.clients?.name || 'cliente',
          total,
          invoice.salons?.name || 'Diabolus CRM'
        ).catch((e) => console.error('[Email] send-whatsapp confirmation:', e))
      }
    }).catch(() => {})

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

// ─── Helper compartido para enviar recordatorio de cobro ─────────────────────
async function sendReminderWhatsApp(invoice: any) {
  const clientPhone = invoice.clients?.phone
  if (!clientPhone) return { sent: false, error: 'Sin teléfono' }

  const invoiceNum = invoice.number || `FAC-${invoice.id.slice(0, 8).toUpperCase()}`
  const total      = Number(invoice.total ?? 0)
  const dueDate    = invoice.due_date
    ? new Date(invoice.due_date).toLocaleDateString('es-ES')
    : 'Sin fecha'
  const clientName = invoice.clients?.name || 'cliente'
  const salonName  = invoice.salons?.name  || 'Diabolus CRM'

  const reminderMessage =
    `Hola ${clientName},\n\n` +
    `Te recordamos que tienes una factura pendiente de pago:\n\n` +
    `📄 Factura: ${invoiceNum}\n` +
    `💶 Importe: ${total.toFixed(2)}€\n` +
    `📅 Vencimiento: ${dueDate}\n\n` +
    `Por favor, realiza el pago para evitar cargos adicionales.\n\n` +
    `Gracias,\n${salonName}`

  let toPhone = clientPhone.replace(/\s/g, '')
  if (!toPhone.startsWith('+')) toPhone = '+34' + toPhone
  const twilioTo = `whatsapp:${toPhone}`

  const twilioSid   = process.env.TWILIO_ACCOUNT_SID
  const twilioToken = process.env.TWILIO_AUTH_TOKEN
  const twilioFrom  = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'

  if (!twilioSid || !twilioToken) {
    return { sent: false, error: 'Sin credenciales Twilio', phone: toPhone, mock: true }
  }

  const twilioPayload = new URLSearchParams({ From: twilioFrom, To: twilioTo, Body: reminderMessage })
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
    return { sent: false, error: twilioData?.message || 'Twilio error', phone: toPhone }
  }
  return { sent: true, phone: toPhone, sid: twilioData.sid }
}

export { sendReminderWhatsApp }

// POST /api/invoices/:id/send-reminder — recordatorio de cobro
invoiceRoutes.post('/:id/send-reminder', async (c) => {
  try {
    const salonId = c.get('salonId')
    const { id } = c.req.param()
    const supabase = getSupabaseAdmin()

    const { data: invoice, error } = await supabase
      .from('invoices')
      .select('*, clients(name, phone), salons(name)')
      .eq('salon_id', salonId)
      .eq('id', id)
      .single()

    if (error || !invoice) return c.json({ error: 'Factura no encontrada' }, 404)
    if (!['pending', 'sent', 'overdue'].includes(invoice.status)) {
      return c.json({ error: 'Solo se pueden enviar recordatorios de facturas pendientes' }, 400)
    }

    const result     = await sendReminderWhatsApp(invoice)
    const invoiceNum = invoice.number || `FAC-${invoice.id.slice(0, 8).toUpperCase()}`
    const total      = Number(invoice.total ?? 0)
    const clientName = invoice.clients?.name || 'cliente'
    const salonName  = invoice.salons?.name  || 'Diabolus CRM'

    const botToken = process.env.TELEGRAM_BOT_TOKEN
    const chatId   = process.env.TELEGRAM_CHAT_ID
    if (botToken && chatId) {
      const tgMsg = result.sent
        ? `📤 <b>Recordatorio enviado</b>\n\n👤 Cliente: <b>${clientName}</b>\n📄 Factura: ${invoiceNum}\n💶 Importe: <b>${total.toFixed(2)}€</b>\n📱 WhatsApp: ${result.phone}`
        : `⚠️ <b>Recordatorio no enviado</b>\n\n👤 Cliente: <b>${clientName}</b>\n📄 Factura: ${invoiceNum}\n❌ Motivo: ${result.error}`
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: tgMsg, parse_mode: 'HTML' }),
      })
    }

    if (result.sent) {
      getSalonOwnerEmail(salonId).then((ownerEmail) => {
        if (ownerEmail) {
          sendReminderSentEmail(ownerEmail, invoiceNum, clientName, total, salonName)
            .catch((e) => console.error('[Email] reminder confirmation:', e))
        }
      }).catch(() => {})
    }

    return c.json({
      success: result.sent,
      invoice_number: invoiceNum,
      client: clientName,
      phone: result.phone,
      whatsapp_sent: result.sent,
      error: result.error || null,
    })
  } catch (err) {
    return c.json({ error: 'Internal error', details: String(err) }, 500)
  }
})

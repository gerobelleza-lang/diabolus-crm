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

// ─── POST /api/invoices/:id/send — Email + WhatsApp (Meta) + Telegram ────────
invoiceRoutes.post('/:id/send', async (c) => {
  try {
    const salonId = c.get('salonId')
    const { id }  = c.req.param()
    const body    = await c.req.json().catch(() => ({}))
    const channels: string[] = body.channels || ['email', 'whatsapp', 'telegram']

    const supabase = getSupabaseAdmin()
    const { data: invoice, error } = await supabase
      .from('invoices')
      .select(`*, clients(name, email, phone, telegram_chat_id), salons(${SALON_PDF_SELECT}, telegram_chat_id)`)
      .eq('salon_id', salonId)
      .eq('id', id)
      .single()
    if (error || !invoice) return c.json({ error: 'Invoice not found' }, 404)

    const invoiceNum  = invoice.number || `FAC-${invoice.id.slice(0, 8).toUpperCase()}`
    const total       = Number(invoice.total ?? invoice.amount ?? 0)
    const clientName  = invoice.clients?.name || 'cliente'
    const salonName   = invoice.salons?.name  || 'Diabolus CRM'
    const invoiceDate = invoice.date
      ? new Date(invoice.date).toLocaleDateString('es-ES')
      : new Date(invoice.created_at).toLocaleDateString('es-ES')
    const dueDate     = invoice.due_date
      ? new Date(invoice.due_date).toLocaleDateString('es-ES')
      : null

    // 1. Generar PDF y subir a Supabase Storage
    let pdfBytes: Uint8Array | null = null
    let pdfUrl: string | null = null
    try {
      pdfBytes = await generateInvoicePDF(invoice)
      const filePath = `${salonId}/${invoiceNum}.pdf`
      const { error: uploadErr } = await supabase.storage
        .from('invoices')
        .upload(filePath, pdfBytes, { contentType: 'application/pdf', upsert: true })
      if (!uploadErr) {
        const { data: signed } = await supabase.storage
          .from('invoices')
          .createSignedUrl(filePath, 900) // 15 min
        pdfUrl = signed?.signedUrl ?? null
      }
    } catch (pdfErr) {
      console.error('[PDF]', String(pdfErr))
    }

    const results: Record<string, any> = {}

    // 2. Email con Resend + adjunto PDF
    if (channels.includes('email') && invoice.clients?.email) {
      try {
        const pdfB64 = pdfBytes
          ? Buffer.from(pdfBytes).toString('base64')
          : null
        const attachments = pdfB64
          ? [{ filename: `${invoiceNum}.pdf`, content: pdfB64 }]
          : []
        const emailHtml = `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#8B5CF6;">Factura de ${salonName}</h2>
            <p>Hola <strong>${clientName}</strong>,</p>
            <p>Adjuntamos tu factura con los siguientes detalles:</p>
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Número</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${invoiceNum}</strong></td></tr>
              <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Fecha</td><td style="padding:8px;border-bottom:1px solid #eee;">${invoiceDate}</td></tr>
              <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#666;">Importe</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong style="color:#8B5CF6;">${total.toFixed(2)}€</strong></td></tr>
              ${dueDate ? `<tr><td style="padding:8px;color:#666;">Vencimiento</td><td style="padding:8px;">${dueDate}</td></tr>` : ''}
            </table>
            ${pdfUrl ? `<p style="margin-top:16px;"><a href="${pdfUrl}" style="background:#8B5CF6;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Descargar PDF</a></p>` : ''}
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="color:#999;font-size:12px;">Enviado desde Diabolus CRM · <a href="https://diabolus.es">diabolus.es</a></p>
          </div>`
        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `${salonName} <noreply@diabolus.es>`,
            to: [invoice.clients.email],
            subject: `Factura ${invoiceNum} — ${total.toFixed(2)}€`,
            html: emailHtml,
            attachments,
          }),
        })
        const resendData = await resendRes.json()
        results.email = resendRes.ok
          ? { sent: true, id: resendData.id }
          : { sent: false, error: resendData.message }
      } catch (e) {
        results.email = { sent: false, error: String(e) }
      }
    } else if (channels.includes('email')) {
      results.email = { sent: false, error: 'Cliente sin email' }
    }

    // 3. WhatsApp via Meta Cloud API
    if (channels.includes('whatsapp') && invoice.clients?.phone) {
      try {
        let toPhone = (invoice.clients.phone as string).replace(/\s/g, '')
        if (!toPhone.startsWith('+')) toPhone = '+34' + toPhone
        const waPhone = toPhone.replace('+', '')
        const waToken   = process.env.WHATSAPP_TOKEN
        const waPhoneId = process.env.WHATSAPP_PHONE_ID
        if (!waToken || !waPhoneId) {
          results.whatsapp = { sent: false, error: 'Sin credenciales WhatsApp' }
        } else {
          const waText =
            `🧾 *Factura de ${salonName}*\n\n` +
            `Hola ${clientName},\n` +
            `Te enviamos tu factura:\n\n` +
            `📄 Nº: ${invoiceNum}\n` +
            `📅 Fecha: ${invoiceDate}\n` +
            `💶 Importe: *${total.toFixed(2)}€*\n` +
            (dueDate ? `⏰ Vencimiento: ${dueDate}\n` : '') +
            (pdfUrl ? `\n📥 PDF: ${pdfUrl}` : '')
          const waRes = await fetch(
            `https://graph.facebook.com/v21.0/${waPhoneId}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${waToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: waPhone,
                type: 'text',
                text: { body: waText },
              }),
            }
          )
          const waData = await waRes.json()
          results.whatsapp = waRes.ok
            ? { sent: true, message_id: waData.messages?.[0]?.id }
            : { sent: false, error: waData.error?.message }
        }
      } catch (e) {
        results.whatsapp = { sent: false, error: String(e) }
      }
    } else if (channels.includes('whatsapp')) {
      results.whatsapp = { sent: false, error: 'Cliente sin teléfono' }
    }

    // 4. Telegram — al cliente (si tiene chat_id) + confirmación al owner del salón
    if (channels.includes('telegram')) {
      const tgToken = process.env.TELEGRAM_BOT_TOKEN
      if (!tgToken) {
        results.telegram = { sent: false, error: 'TELEGRAM_BOT_TOKEN no configurado' }
      } else {
      const tgSendMessage = async (chatId: string, text: string) => {
        return fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        })
      }
      const tgSendDocument = async (chatId: string, docUrl: string, caption: string) => {
        return fetch(`https://api.telegram.org/bot${tgToken}/sendDocument`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, document: docUrl, caption, parse_mode: 'HTML' }),
        })
      }

      const tgResults: any[] = []

      // Al cliente si tiene telegram_chat_id
      const clientTgId = invoice.clients?.telegram_chat_id
      if (clientTgId) {
        try {
          const clientText =
            `🧾 <b>Factura de ${salonName}</b>\n\n` +
            `Hola ${clientName},\n` +
            `📄 Nº: <b>${invoiceNum}</b>\n` +
            `📅 Fecha: ${invoiceDate}\n` +
            `💶 Importe: <b>${total.toFixed(2)}€</b>\n` +
            (dueDate ? `⏰ Vencimiento: ${dueDate}\n` : '')
          if (pdfUrl) {
            const r = await tgSendDocument(clientTgId, pdfUrl, clientText)
            tgResults.push({ to: 'client', sent: r.ok })
          } else {
            const r = await tgSendMessage(clientTgId, clientText)
            tgResults.push({ to: 'client', sent: r.ok })
          }
        } catch (e) {
          tgResults.push({ to: 'client', sent: false, error: String(e) })
        }
      }

      // Confirmación al owner del salón
      const ownerTgId = invoice.salons?.telegram_chat_id
      if (ownerTgId) {
        try {
          const ownerText =
            `✅ <b>Factura enviada</b>\n\n` +
            `👤 Cliente: ${clientName}\n` +
            `📄 Factura: ${invoiceNum}\n` +
            `💶 Importe: <b>${total.toFixed(2)}€</b>\n\n` +
            `📧 Email: ${results.email?.sent ? '✅' : '❌'}\n` +
            `📱 WhatsApp: ${results.whatsapp?.sent ? '✅' : '❌'}\n` +
            `📬 Telegram: ${clientTgId ? '✅' : 'Sin chat_id'}`
          const r = await tgSendMessage(ownerTgId, ownerText)
          tgResults.push({ to: 'owner', sent: r.ok })
        } catch (e) {
          tgResults.push({ to: 'owner', sent: false, error: String(e) })
        }
      }
      results.telegram = tgResults.length > 0 ? tgResults : { sent: false, error: 'Sin chat_ids configurados' }
      } // end else tgToken
    }

    // Marcar factura como enviada
    const anyOk = [results.email, results.whatsapp].some((r: any) => r?.sent)
    if (anyOk) {
      await supabase
        .from('invoices')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          ...(pdfUrl ? { pdf_url: pdfUrl } : {}),
        })
        .eq('id', id)
    }

    return c.json({
      ok: true,
      invoice_id: id,
      invoice_number: invoiceNum,
      client: clientName,
      pdf_url: pdfUrl,
      channels: results,
    })
  } catch (err) {
    return c.json({ error: 'Internal error', details: String(err) }, 500)
  }
})

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

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

// GET /api/invoices/:id/pdf
// Descarga el PDF de la factura
invoiceRoutes.get('/:id/pdf', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  const { data: invoice, error } = await supabase
    .from('invoices')
    .select('*, clients(name, email, phone), salons(name, email, phone, address, nif)')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()

  if (error || !invoice) return c.json({ error: 'Invoice not found' }, 404)

  try {
    // Dynamic import to avoid Edge runtime issues
    const { generateInvoicePDF } = await import('../utils/invoice-pdf')
    const pdfBuffer = await generateInvoicePDF(invoice)
    const invoiceNum = `INV-${invoice.id.slice(0, 8).toUpperCase()}`

    return new Response(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${invoiceNum}.pdf"`,
        'Content-Length': String(pdfBuffer.length),
      },
    })
  } catch (err) {
    console.error('[PDF] Error generando PDF:', err)
    return c.json({ error: 'Error generating PDF', details: String(err) }, 500)
  }
})

// POST /api/invoices/:id/send-whatsapp
// Genera PDF (opcional) y lo envia por WhatsApp al cliente via Twilio
invoiceRoutes.post('/:id/send-whatsapp', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  // 1. Obtener factura con datos completos
  const { data: invoice, error } = await supabase
    .from('invoices')
    .select('*, clients(name, email, phone), salons(name)')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()

  if (error || !invoice) return c.json({ error: 'Invoice not found' }, 404)

  const clientPhone = invoice.clients?.phone
  if (!clientPhone) {
    return c.json({ error: 'Client has no phone number. Add it in the client profile.' }, 400)
  }

  // 2. Intentar generar PDF (opcional - no bloquea si falla)
  let pdfUrl: string | null = null
  try {
    const { generateInvoicePDF } = await import('../utils/invoice-pdf')
    const pdfBuffer = await generateInvoicePDF({
      ...invoice,
      amount: invoice.amount ?? invoice.total ?? 0,
    })

    const invoiceNum = `INV-${invoice.id.slice(0, 8).toUpperCase()}`
    const fileName = `${salonId}/${invoiceNum}.pdf`

    const { error: uploadError } = await supabase.storage
      .from('invoices')
      .upload(fileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      })

    if (!uploadError) {
      const { data: urlData } = supabase.storage.from('invoices').getPublicUrl(fileName)
      pdfUrl = urlData?.publicUrl ?? null

      // Guardar URL en factura
      await supabase.from('invoices').update({ pdf_url: pdfUrl }).eq('id', id)
    } else {
      console.warn('[Storage] Upload error:', uploadError.message)
    }
  } catch (pdfErr) {
    console.warn('[PDF] Generation skipped (non-fatal):', String(pdfErr))
  }

  // 3. Preparar mensaje WhatsApp
  const invoiceNum = `INV-${invoice.id.slice(0, 8).toUpperCase()}`
  const invoiceDate = new Date(invoice.created_at).toLocaleDateString('es-ES')
  const amount = invoice.amount ?? invoice.total ?? 0

  let messageBody = `🧾 *Factura de ${invoice.salons?.name || 'tu proveedor'}*\n\n` +
    `Hola ${invoice.clients?.name},\n\n` +
    `Te enviamos tu factura:\n` +
    `📄 *${invoiceNum}*\n` +
    `💰 Importe: *€${Number(amount).toFixed(2)}*\n` +
    `📅 Fecha: ${invoiceDate}\n\n`

  if (pdfUrl) {
    messageBody += `Descarga el PDF:\n${pdfUrl}\n\n`
  }
  messageBody += `_Enviado desde Diabolus CRM_`

  // 4. Limpiar telefono y enviar por Twilio
  let toPhone = clientPhone.replace(/\s/g, '')
  if (!toPhone.startsWith('+')) {
    toPhone = '+34' + toPhone
  }
  const twilioTo = `whatsapp:${toPhone}`

  const twilioSid = process.env.TWILIO_ACCOUNT_SID
  const twilioToken = process.env.TWILIO_AUTH_TOKEN
  const twilioFrom = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'

  let whatsappResult: { status: string; messageId?: string; mock?: boolean; error?: string }

  if (twilioSid && twilioToken) {
    try {
      const twilioPayload = new URLSearchParams({
        From: twilioFrom,
        To: twilioTo,
        Body: messageBody,
        ...(pdfUrl ? { MediaUrl: pdfUrl } : {}),
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
        throw new Error(`Twilio error: ${twilioData?.message || JSON.stringify(twilioData)}`)
      }

      whatsappResult = { status: 'sent', messageId: twilioData.sid }

      // Actualizar estado de la factura
      await supabase
        .from('invoices')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', id)
        .eq('salon_id', salonId)

    } catch (twilioErr) {
      console.error('[Twilio] Error:', twilioErr)
      whatsappResult = { status: 'error', error: String(twilioErr) }
      return c.json({ error: `WhatsApp send failed: ${twilioErr}` }, 500)
    }
  } else {
    // Sin credenciales Twilio: modo demo
    console.warn('[WhatsApp] Twilio credentials not set — running in demo mode')
    whatsappResult = {
      status: 'demo',
      messageId: `demo_${Date.now()}`,
      mock: true,
    }
  }

  return c.json({
    success: true,
    invoice_id: id,
    invoice_number: invoiceNum,
    client: invoice.clients?.name,
    phone: toPhone,
    pdf_url: pdfUrl,
    whatsapp: whatsappResult,
  })
})

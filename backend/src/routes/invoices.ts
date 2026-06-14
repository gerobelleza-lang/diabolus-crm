// @ts-nocheck
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { getSignatureProvider } from '../integrations/signature/factory'
import { generateInvoicePDF } from '../utils/invoice-pdf'

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
    return c.json({ error: 'Error generating PDF' }, 500)
  }
})

// POST /api/invoices/:id/send-whatsapp
// Genera PDF y lo envía por WhatsApp al cliente
invoiceRoutes.post('/:id/send-whatsapp', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  // 1. Obtener factura con datos completos
  const { data: invoice, error } = await supabase
    .from('invoices')
    .select('*, clients(name, email, phone), salons(name, email, phone, address, nif)')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()

  if (error || !invoice) return c.json({ error: 'Invoice not found' }, 404)

  const clientPhone = invoice.clients?.phone
  if (!clientPhone) {
    return c.json({ error: 'Client has no phone number. Add it in the client profile.' }, 400)
  }

  // 2. Generar PDF
  let pdfBuffer: Buffer
  try {
    pdfBuffer = await generateInvoicePDF(invoice)
  } catch (err) {
    console.error('[PDF] Error:', err)
    return c.json({ error: 'Error generating PDF' }, 500)
  }

  // 3. Subir PDF a Supabase Storage
  const invoiceNum = `INV-${invoice.id.slice(0, 8).toUpperCase()}`
  const fileName = `${salonId}/${invoiceNum}.pdf`

  const { error: uploadError } = await supabase.storage
    .from('invoices')
    .upload(fileName, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    })

  if (uploadError) {
    console.error('[Storage] Error subiendo PDF:', uploadError)
    return c.json({ error: 'Error uploading PDF to storage' }, 500)
  }

  // 4. Obtener URL pública
  const { data: urlData } = supabase.storage
    .from('invoices')
    .getPublicUrl(fileName)

  const pdfUrl = urlData?.publicUrl

  // 5. Enviar por WhatsApp (Twilio)
  const twilioSid = process.env.TWILIO_ACCOUNT_SID
  const twilioToken = process.env.TWILIO_AUTH_TOKEN
  const twilioFrom = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'

  // Limpiar teléfono: añadir +34 si no tiene prefijo
  let toPhone = clientPhone.replace(/\s/g, '')
  if (!toPhone.startsWith('+')) {
    toPhone = '+34' + toPhone
  }
  const twilioTo = `whatsapp:${toPhone}`

  const invoiceDate = new Date(invoice.created_at).toLocaleDateString('es-ES')
  const messageBody = `🧾 *Factura de ${invoice.salons?.name || 'tu proveedor'}*\n\n` +
    `Hola ${invoice.clients?.name},\n\n` +
    `Te adjuntamos tu factura:\n` +
    `📄 *${invoiceNum}*\n` +
    `💰 Importe: *€${Number(invoice.amount).toFixed(2)}*\n` +
    `📅 Fecha: ${invoiceDate}\n\n` +
    `Puedes descargar el PDF aquí:\n${pdfUrl}\n\n` +
    `_Enviado desde Diabolus CRM_`

  let whatsappResult: { status: string; messageId?: string; mock?: boolean }

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

      const twilioData = await twilioResponse.json() as any

      if (!twilioResponse.ok) {
        throw new Error(`Twilio error: ${twilioData?.message || JSON.stringify(twilioData)}`)
      }

      whatsappResult = { status: 'sent', messageId: twilioData.sid }
    } catch (twilioErr) {
      console.error('[Twilio] Error:', twilioErr)
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

  // 6. Actualizar estado de la factura
  await supabase
    .from('invoices')
    .update({ status: 'sent', pdf_url: pdfUrl })
    .eq('id', id)
    .eq('salon_id', salonId)

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

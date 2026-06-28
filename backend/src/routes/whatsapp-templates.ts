/**
 * whatsapp-templates.ts — WhatsApp Message Templates
 *
 * Templates pre-aprobados por Meta para envío sin rate-limiting
 * Actualmente en DEVELOPMENT MODE — requiere Meta Business verificación
 *
 * Endpoint: POST /api/whatsapp/send-template
 * Body: { phone, template_name, parameters }
 *
 * TODO: Una vez Meta apruebe los templates, cambiar a producción
 */

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase.js'

type Variables = { userId: string; salonId: string }

export const whatsappTemplatesRoutes = new Hono<{ Variables: Variables }>()

// Defined templates for Diabolus (waiting for Meta approval)
const TEMPLATES = {
  'invoice_reminder': {
    components: [
      {
        type: 'body',
        text: 'Hola {{1}}, 👋\n\nLa factura {{2}} por €{{3}} está pendiente de pago (vencida desde {{4}}).\n\nPodés pagarla desde aquí 👉 {{5}}\n\n¡Gracias!'
      }
    ],
    parameters: ['client_name', 'invoice_number', 'amount', 'days_overdue', 'payment_link']
  },
  'client_welcome': {
    components: [
      {
        type: 'body',
        text: '¡Hola {{1}}! 🎉\n\nBienvenido a {{2}}. Estamos emocionados de trabajar contigo.\n\nSi tienes preguntas, responde este mensaje.\n\n📲 Diabolus CRM'
      }
    ],
    parameters: ['client_name', 'business_name']
  },
  'appointment_reminder': {
    components: [
      {
        type: 'body',
        text: '📅 Recordatorio: Tu cita en {{1}} mañana a las {{2}}.\n\nSi necesitas reprogramar, escribe "cambiar cita".\n\n¡Hasta mañana!'
      }
    ],
    parameters: ['business_name', 'time']
  },
  'payment_confirmation': {
    components: [
      {
        type: 'body',
        text: '✅ Pago recibido\n\nFactura: {{1}}\nMonto: €{{2}}\nFecha: {{3}}\n\n¡Muchas gracias {{4}}!'
      }
    ],
    parameters: ['invoice_number', 'amount', 'date', 'client_name']
  }
}

/**
 * GET /api/whatsapp/templates
 * Listar templates disponibles (públicos)
 */
whatsappTemplatesRoutes.get('/templates', (c) => {
  const list = Object.entries(TEMPLATES).map(([name, config]) => ({
    name,
    status: 'pending_approval',
    parameters: config.parameters,
    body: config.components[0]?.text || ''
  }))
  return c.json({ templates: list, total: list.length })
})

/**
 * POST /api/whatsapp/send-template
 * Envía un template de WhatsApp
 *
 * Body: {
 *   phone: "34123456789",
 *   template_name: "invoice_reminder",
 *   parameters: ["Juan", "INV-001", "150.00", "5", "https://pay.example.com"]
 * }
 */
whatsappTemplatesRoutes.post('/send-template', async (c) => {
  try {
    const salonId = c.get('salonId')
    const body = await c.req.json().catch(() => ({})) as any

    const { phone, template_name, parameters } = body

    if (!phone || !template_name) {
      return c.json({ error: 'phone y template_name requeridos' }, 400)
    }

    const template = TEMPLATES[template_name as keyof typeof TEMPLATES]
    if (!template) {
      return c.json({ error: `Template '${template_name}' no existe` }, 404)
    }

    if (!Array.isArray(parameters) || parameters.length !== template.parameters.length) {
      return c.json({
        error: `Parámetros inválidos. Se esperan: ${template.parameters.join(', ')}`
      }, 400)
    }

    const WA_TOKEN = process.env.WHATSAPP_TOKEN
    const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '1214990365020353'

    if (!WA_TOKEN) {
      console.warn('[WA Templates] WHATSAPP_TOKEN not configured')
      return c.json({ error: 'WhatsApp no configurado' }, 500)
    }

    // Build template message
    const bodyText = template.components[0].text
    let finalBody = bodyText
    for (let i = 0; i < parameters.length; i++) {
      finalBody = finalBody.replace(`{{${i + 1}}}`, parameters[i])
    }

    // Send via WhatsApp API
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: finalBody }
        })
      }
    )

    const result = await response.json() as any

    if (!response.ok) {
      console.error('[WA Templates] Send failed:', result)
      return c.json({
        error: result.error?.message || 'Error enviando mensaje',
        details: result.error
      }, 400)
    }

    // Log in audit
    const supabase = getSupabaseAdmin()
    await supabase.from('audit_log').insert([{
      salon_id: salonId,
      action: 'whatsapp_template_sent',
      changes: {
        template_name,
        phone,
        message_id: result.messages?.[0]?.id
      },
      created_at: new Date().toISOString()
    }]).catch(() => {})

    return c.json({
      ok: true,
      message_id: result.messages?.[0]?.id,
      template: template_name,
      phone
    })
  } catch (err: any) {
    console.error('[WA /send-template]', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

/**
 * POST /api/whatsapp/create-templates (Admin only)
 * Instrucciones para crear templates en Meta Business Platform
 * (No implementado aquí — requiere UI en Meta)
 */
whatsappTemplatesRoutes.post('/create-templates', (c) => {
  return c.json({
    message: 'Use Meta Business Platform to create templates',
    instruction: 'https://developers.facebook.com/docs/whatsapp/cloud-api/reference/message-templates',
    templates_to_create: Object.entries(TEMPLATES).map(([name, config]) => ({
      name: `diabolus_${name}`,
      language: 'es_ES',
      category: 'TRANSACTIONAL',
      body: config.components[0]?.text,
      parameters: config.parameters
    }))
  })
})

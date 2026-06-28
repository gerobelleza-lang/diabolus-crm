/**
 * whatsapp-templates.ts — Gestión de plantillas WhatsApp Meta
 * Edge Runtime ONLY — fetch directo a Graph API
 */
import { Hono } from 'hono'

export const waTemplateRoutes = new Hono()

function waToken(): string { return process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || '' }
function waBAId(): string  { return process.env.WHATSAPP_WABA_ID || '' }
function waPhoneId(): string { return process.env.WHATSAPP_PHONE_NUMBER_ID || '' }

// ── Plantillas predefinidas de Diabolus ────────────────────────────────────
const DIABOLUS_TEMPLATES = [
  {
    name: 'invoice_reminder',
    display: 'Recordatorio de factura',
    description: 'Envía recordatorio de cobro pendiente al cliente',
    variables: ['nombre_cliente', 'concepto', 'importe', 'fecha_vencimiento'],
    body: 'Hola {{1}}, te recordamos que tienes pendiente el pago de {{2}} por {{3}}€, vencido el {{4}}. ¿Puedes confirmarnos el pago?',
  },
  {
    name: 'client_welcome',
    display: 'Bienvenida cliente',
    description: 'Mensaje de bienvenida a nuevo cliente',
    variables: ['nombre_cliente', 'nombre_negocio'],
    body: '¡Hola {{1}}! 👋 Bienvenido/a a {{2}}. Estamos encantados de tenerte. Si necesitas algo, escríbenos por aquí.',
  },
  {
    name: 'appointment_reminder',
    display: 'Recordatorio de cita',
    description: 'Recuerda al cliente su próxima cita',
    variables: ['nombre_cliente', 'fecha', 'hora', 'servicio'],
    body: 'Hola {{1}}, te recordamos tu cita el {{2}} a las {{3}} para {{4}}. ¡Te esperamos! 😊',
  },
  {
    name: 'payment_confirmation',
    display: 'Confirmación de pago',
    description: 'Confirma recepción de pago',
    variables: ['nombre_cliente', 'importe', 'concepto'],
    body: '¡Hola {{1}}! ✅ Hemos recibido tu pago de {{2}}€ por {{3}}. ¡Gracias!',
  },
]

// ── GET /templates — listar plantillas ─────────────────────────────────────
waTemplateRoutes.get('/templates', async (c) => {
  try {
    const waba = waBAId()
    const token = waToken()

    // Si tenemos WABA ID, consultamos plantillas reales de Meta
    let metaTemplates: any[] = []
    if (waba && token) {
      try {
        const res = await fetch(
          `https://graph.facebook.com/v19.0/${waba}/message_templates?limit=100`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        const data = await res.json()
        metaTemplates = data.data || []
      } catch { /* fall through to predefined */ }
    }

    return c.json({
      predefined: DIABOLUS_TEMPLATES,
      meta: metaTemplates,
      waba_configured: !!waba,
    })
  } catch (err: any) {
    console.error('[WA Templates]', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

// ── POST /send-template — enviar plantilla a un número ─────────────────────
waTemplateRoutes.post('/send-template', async (c) => {
  try {
    const token   = waToken()
    const phoneId = waPhoneId()
    if (!token || !phoneId) {
      return c.json({ error: 'WhatsApp no configurado' }, 500)
    }

    const body = await c.req.json().catch(() => ({}))
    const { to, template_name, language, components } = body as any

    if (!to || !template_name) {
      return c.json({ error: 'Faltan campos: to, template_name' }, 400)
    }

    // Normalizar número
    let phone = to.replace(/[^0-9]/g, '')
    if (phone.startsWith('34') && phone.length === 11) phone = phone
    else if (phone.length === 9) phone = '34' + phone

    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: template_name,
          language: { code: language || 'es' },
          components: components || [],
        },
      }),
    })

    const result = await res.json()
    if (result.error) {
      return c.json({ error: result.error.message, code: result.error.code }, 400)
    }

    return c.json({ ok: true, message_id: result.messages?.[0]?.id })
  } catch (err: any) {
    console.error('[WA Send Template]', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

// ── POST /send-direct — enviar mensaje directo (no template) ───────────────
waTemplateRoutes.post('/send-direct', async (c) => {
  try {
    const token   = waToken()
    const phoneId = waPhoneId()
    if (!token || !phoneId) {
      return c.json({ error: 'WhatsApp no configurado' }, 500)
    }

    const body = await c.req.json().catch(() => ({}))
    const { to, message } = body as any
    if (!to || !message) {
      return c.json({ error: 'Faltan campos: to, message' }, 400)
    }

    let phone = to.replace(/[^0-9]/g, '')
    if (phone.length === 9) phone = '34' + phone

    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: message },
      }),
    })

    const result = await res.json()
    if (result.error) {
      return c.json({ error: result.error.message }, 400)
    }

    return c.json({ ok: true, message_id: result.messages?.[0]?.id })
  } catch (err: any) {
    console.error('[WA Send Direct]', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

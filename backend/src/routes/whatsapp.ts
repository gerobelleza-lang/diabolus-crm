import { Hono } from 'hono'

export const whatsappRoutes = new Hono()

interface WhatsAppMessage {
  to: string
  type: 'text' | 'template'
  text?: string
  template?: {
    name: string
    language: { code: string }
    parameters?: { body: { parameters: string[] } }
  }
}

/**
 * POST /api/whatsapp/send
 * Envía mensaje a cliente (recordatorio de pago, confirmación, etc)
 */
whatsappRoutes.post('/send', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))

    const { clientPhoneId, messageType, invoiceId, amount, dueDate } = body as {
      clientPhoneId?: string
      messageType?: 'payment_reminder' | 'payment_confirmed' | 'custom'
      invoiceId?: string
      amount?: number
      dueDate?: string
    }

    if (!clientPhoneId || !messageType) {
      return c.json({
        error: 'Missing: clientPhoneId, messageType'
      }, 400)
    }

    const message = buildMessage(messageType, {
      invoiceId,
      amount,
      dueDate
    })

    // TODO: Implementar llamada real a WhatsApp Business API
    // const response = await callWhatsAppAPI(clientPhoneId, message)

    // Por ahora, retornamos éxito mock
    return c.json({
      status: 'success',
      messageId: `msg_${Date.now()}`,
      to: clientPhoneId,
      type: messageType,
      message: message.text || message.template?.name,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('[WhatsApp] Error:', err)
    return c.json({ error: 'WhatsApp error' }, 500)
  }
})

/**
 * POST /api/whatsapp/webhook
 * Webhook para recibir confirmaciones de entrega / mensajes entrantes
 */
whatsappRoutes.post('/webhook', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))

    // TODO: Validar webhook signature (X-Hub-Signature)
    // const signature = c.req.header('X-Hub-Signature')

    const event = body as {
      object?: string
      entry?: Array<{
        changes: Array<{
          value: {
            messages?: Array<{
              id: string
              from: string
              text?: { body: string }
              type: string
            }>
            statuses?: Array<{
              id: string
              status: 'delivered' | 'read' | 'failed'
              timestamp: string
            }>
          }
        }>
      }>
    }

    if (event.object === 'whatsapp_business_account') {
      // Handle messages received from clients
      const messages = event.entry?.[0]?.changes[0]?.value?.messages || []
      for (const msg of messages) {
        console.log(`📨 Message from ${msg.from}: ${msg.text?.body}`)
        // TODO: Parse message and potentially trigger action
        // Examples: "Confirmo pago", "Quiero info de factura", etc
      }

      // Handle delivery status
      const statuses = event.entry?.[0]?.changes[0]?.value?.statuses || []
      for (const status of statuses) {
        console.log(`✓ Message ${status.id} → ${status.status}`)
        // TODO: Update message status in database
      }
    }

    return c.json({ received: true })
  } catch (err) {
    console.error('[WhatsApp Webhook] Error:', err)
    return c.json({ error: 'Webhook error' }, 500)
  }
})

/**
 * GET /api/whatsapp/status/:messageId
 * Obtiene estado de un mensaje enviado
 */
whatsappRoutes.get('/status/:messageId', async (c) => {
  try {
    const { messageId } = c.req.param()

    // TODO: Obtener estado real de WhatsApp API
    return c.json({
      messageId,
      status: 'delivered',
      sentAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString()
    })
  } catch (err) {
    console.error('[WhatsApp Status] Error:', err)
    return c.json({ error: 'Status check failed' }, 500)
  }
})

/**
 * Construye mensaje según tipo
 */
function buildMessage(
  type: 'payment_reminder' | 'payment_confirmed' | 'custom',
  data: {
    invoiceId?: string
    amount?: number
    dueDate?: string
  }
): WhatsAppMessage {
  switch (type) {
    case 'payment_reminder':
      return {
        to: '',
        type: 'template',
        template: {
          name: 'payment_reminder',
          language: { code: 'es' },
          parameters: {
            body: {
              parameters: [
                data.invoiceId || 'Factura',
                `€${data.amount || '0'}`,
                data.dueDate || 'hoy'
              ]
            }
          }
        }
      }

    case 'payment_confirmed':
      return {
        to: '',
        type: 'template',
        template: {
          name: 'payment_confirmed',
          language: { code: 'es' },
          parameters: {
            body: {
              parameters: [
                data.invoiceId || 'Factura',
                `€${data.amount || '0'}`
              ]
            }
          }
        }
      }

    case 'custom':
    default:
      return {
        to: '',
        type: 'text',
        text: 'Hola, este es un mensaje personalizado'
      }
  }
}

/**
 * Llamaría a WhatsApp Business API
 * (Implementación futura)
 */
// async function callWhatsAppAPI(phoneId: string, message: WhatsAppMessage) {
//   const apiKey = process.env.WHATSAPP_API_TOKEN
//   const response = await fetch(`https://graph.instagram.com/v18.0/${phoneId}/messages`, {
//     method: 'POST',
//     headers: {
//       'Authorization': `Bearer ${apiKey}`,
//       'Content-Type': 'application/json'
//     },
//     body: JSON.stringify(message)
//   })
//   return response.json()
// }

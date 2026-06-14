import { Hono } from 'hono'

export const webhookRoutes = new Hono()

/**
 * POST /webhooks/gmail
 * Webhook para recibir notificaciones de nuevos emails en carpeta "Facturas"
 * Google Cloud Pub/Sub → nuestra API
 */
webhookRoutes.post('/gmail', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))

    // Google Cloud Pub/Sub format
    const message = body.message as {
      data?: string
      attributes?: Record<string, string>
    }

    if (!message || !message.data) {
      return c.json({ error: 'Invalid message format' }, 400)
    }

    // Decode base64 payload
    const decodedData = Buffer.from(message.data, 'base64').toString('utf-8')
    const gmailData = JSON.parse(decodedData) as {
      emailAddress?: string
      messagesAdded?: Array<{ id: string }>
    }

    console.log(`📧 Gmail webhook: ${gmailData.messagesAdded?.length || 0} messages`)

    // TODO: Fetch email details from Gmail API
    // TODO: Parse invoice data (amount, vendor, date)
    // TODO: Register as expense in Diabolus

    return c.json({
      status: 'success',
      processed: gmailData.messagesAdded?.length || 0,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('[Gmail Webhook] Error:', err)
    return c.json({ error: 'Webhook error' }, 500)
  }
})

/**
 * POST /webhooks/stripe (alternative to /api/stripe/webhook)
 * Stripe webhook handler
 */
webhookRoutes.post('/stripe', async (c) => {
  try {
    const signature = c.req.header('stripe-signature')
    const body = await c.req.text()

    if (!signature) {
      return c.json({ error: 'Missing stripe-signature' }, 400)
    }

    // TODO: Verify signature with stripe.webhooks.constructEvent()
    // const event = stripe.webhooks.constructEvent(body, signature, secret)

    console.log('💳 Stripe webhook received')

    return c.json({ received: true })
  } catch (err) {
    console.error('[Stripe Webhook] Error:', err)
    return c.json({ error: 'Webhook error' }, 500)
  }
})

/**
 * Parsea email de factura y extrae datos
 * (Implementación futura con Gmail API + IA)
 */
// async function parseInvoiceEmail(messageId: string) {
//   const gmail = google.gmail({ version: 'v1', auth: authClient })
//   const message = await gmail.users.messages.get({ userId: 'me', id: messageId })
//   const payload = message.data.payload
//
//   // Extract headers
//   const from = payload?.headers?.find((h: any) => h.name === 'From')?.value
//   const subject = payload?.headers?.find((h: any) => h.name === 'Subject')?.value
//
//   // TODO: Use IA to parse:
//   // - Vendor name
//   // - Invoice number
//   // - Amount
//   // - Due date
//   // - Category (tinturas, suministros, etc)
//
//   return {
//     vendor: from,
//     subject: subject,
//     amount: 0,
//     dueDate: new Date(),
//     category: 'general'
//   }
// }
//
// async function registerExpense(expense: {
//   vendor: string
//   amount: number
//   category: string
//   dueDate: Date
// }) {
//   // Insert into Supabase transactions table
//   // const { data, error } = await supabase
//   //   .from('transactions')
//   //   .insert({
//   //     salon_id: salonId,
//   //     type: 'expense',
//   //     amount: expense.amount,
//   //     concept: expense.vendor,
//   //     category: expense.category,
//   //     created_at: new Date()
//   //   })
// }

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase.js'

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
      snippet?: string
    }

    console.log(`📧 Gmail webhook: ${gmailData.messagesAdded?.length || 0} messages`)

    // Procesar cada email
    const processed: Array<{ id?: string; status: string; error?: string }> = []

    for (const msg of gmailData.messagesAdded || []) {
      try {
        // Mock: usar snippet como contenido del email
        const emailContent = gmailData.snippet || 'Invoice email'

        // Parse con IA
        const invoiceData = await parseInvoiceEmail(emailContent)

        // TODO: Obtener salonId desde contexto de auth o header
        // Por ahora, usar un valor default para testing
        const salonId = message.attributes?.['salon_id'] || 'default-salon'

        // Registrar en Supabase
        await registerExpense(salonId, invoiceData)

        processed.push({
          id: msg.id,
          status: 'success'
        })
      } catch (msgErr) {
        console.error(`Failed to process message ${msg.id}:`, msgErr)
        processed.push({
          id: msg.id,
          status: 'error',
          error: String(msgErr)
        })
      }
    }

    return c.json({
      status: 'success',
      processed: processed.length,
      results: processed,
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
 * Parsea email de factura con IA y extrae datos
 */
async function parseInvoiceEmail(emailBody: string): Promise<{
  vendor: string
  amount: number
  category: string
  dueDate: Date
  invoiceNumber?: string
}> {
  const openrouterKey = process.env.OPENROUTER_API_KEY

  if (!openrouterKey) {
    throw new Error('OPENROUTER_API_KEY not configured')
  }

  const systemPrompt = `You are a financial assistant that extracts invoice data from emails.
Extract from the provided email:
- vendor name (proveedor)
- amount in EUR (monto numérico)
- category (suministros, tinturas, servicios, etc)
- due date (fecha de vencimiento, formato ISO)
- invoice number (número de factura, si existe)

Return JSON only: {"vendor":"name","amount":123.45,"category":"category","dueDate":"2026-06-30T00:00:00Z","invoiceNumber":"INV-123"}`

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openrouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://diabolus-crm.vercel.app'
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Parse this invoice email:\n\n${emailBody}`
        }
      ],
      temperature: 0.3,
      max_tokens: 500
    })
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(`OpenRouter error: ${JSON.stringify(error)}`)
  }

  const result = await response.json() as {
    choices?: Array<{ message?: { content: string } }>
  }
  const content = result.choices?.[0]?.message?.content || '{}'

  const parsed = JSON.parse(content)

  return {
    vendor: parsed.vendor || 'Unknown',
    amount: parseFloat(parsed.amount) || 0,
    category: parsed.category || 'general',
    dueDate: new Date(parsed.dueDate || new Date()),
    invoiceNumber: parsed.invoiceNumber
  }
}

/**
 * Registra gasto en Supabase
 */
async function registerExpense(
  salonId: string,
  expense: {
    vendor: string
    amount: number
    category: string
    dueDate: Date
    invoiceNumber?: string
  }
) {
  try {
    const supabase = getSupabaseAdmin()

    const { error } = await supabase.from('transactions').insert([{
      salon_id: salonId,
      type: 'expense',
      amount: expense.amount,
      concept: `${expense.vendor}${expense.invoiceNumber ? ` (${expense.invoiceNumber})` : ''}`,
      category: expense.category,
      due_date: expense.dueDate.toISOString(),
      created_at: new Date().toISOString()
    }] as any)

    if (error) {
      console.error('Database error:', error)
      throw error
    }

    console.log(`✅ Expense registered: €${expense.amount} from ${expense.vendor}`)
  } catch (err) {
    console.error('Failed to register expense:', err)
    throw err
  }
}

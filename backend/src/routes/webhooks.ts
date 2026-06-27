import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase.js'

export const webhookRoutes = new Hono()

/**
 * POST /webhooks/gmail
 * Webhook para recibir notificaciones de nuevos emails en carpeta "Facturas"
 * Google Cloud Pub/Sub → nuestra API
 * NOTA: Requiere configuración real de Google Cloud Pub/Sub para activar
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

    // Decode base64 payload — Edge Runtime compatible (no Buffer)
    const bytes = Uint8Array.from(atob(message.data), (ch) => ch.charCodeAt(0))
    const decodedData = new TextDecoder().decode(bytes)
    const gmailData = JSON.parse(decodedData) as {
      emailAddress?: string
      messagesAdded?: Array<{ id: string }>
      snippet?: string
    }

    console.log(`📧 Gmail webhook: ${gmailData.messagesAdded?.length || 0} messages`)

    const processed: Array<{ id?: string; status: string; error?: string }> = []

    for (const msg of gmailData.messagesAdded || []) {
      try {
        const emailContent = gmailData.snippet || 'Invoice email'
        const invoiceData = await parseInvoiceEmail(emailContent)
        const salonId = message.attributes?.['salon_id'] || 'default-salon'
        await registerExpense(salonId, invoiceData)
        processed.push({ id: msg.id, status: 'success' })
      } catch (msgErr) {
        console.error(`Failed to process message ${msg.id}:`, msgErr)
        processed.push({ id: msg.id, status: 'error', error: String(msgErr) })
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
 * POST /webhooks/stripe (alias de /api/stripe/webhook)
 */
webhookRoutes.post('/stripe', async (c) => {
  try {
    const signature = c.req.header('stripe-signature')
    if (!signature) {
      return c.json({ error: 'Missing stripe-signature' }, 400)
    }
    // TODO: Verificar firma con stripe.webhooks.constructEvent()
    console.log('💳 Stripe webhook received at /webhooks/stripe')
    return c.json({ received: true })
  } catch (err) {
    console.error('[Stripe Webhook] Error:', err)
    return c.json({ error: 'Webhook error' }, 500)
  }
})

/**
 * Parsea email de factura con IA
 */
async function parseInvoiceEmail(emailBody: string) {
  const openrouterKey = process.env.OPENROUTER_API_KEY
  if (!openrouterKey) throw new Error('OPENROUTER_API_KEY not configured')

  const systemPrompt = `You are a financial assistant that extracts invoice data from emails.
Extract: vendor name, amount in EUR (numeric), category, due date (ISO), invoice number.
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
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Parse this invoice email:\n\n${emailBody}` }
      ],
      temperature: 0.3,
      max_tokens: 500
    })
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(`OpenRouter error: ${JSON.stringify(error)}`)
  }

  const result = await response.json()
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
async function registerExpense(salonId: string, expense: {
  vendor: string
  amount: number
  category: string
  dueDate: Date
  invoiceNumber?: string
}) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('transactions').insert([{
    salon_id: salonId,
    type: 'expense',
    amount: expense.amount,
    concept: `${expense.vendor}${expense.invoiceNumber ? ` (${expense.invoiceNumber})` : ''}`,
    category: expense.category,
    due_date: expense.dueDate.toISOString(),
    created_at: new Date().toISOString()
  }])

  if (error) throw error
  console.log(`✅ Expense registered: €${expense.amount} from ${expense.vendor}`)
}

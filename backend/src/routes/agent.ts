import { Hono } from 'hono'
import { parseUserInput } from '../agent/parser'

export const agentRoutes = new Hono()

/**
 * POST /api/agent/chat
 * Procesa input natural del usuario usando Parser L0 (deterministic, sin LLM)
 */
agentRoutes.post('/chat', (c) => {
  try {
    const body = c.req.header('content-type')?.includes('application/json')
      ? c.req.parsedBody
      : null

    if (!body || typeof body !== 'object' || !('userInput' in body)) {
      return c.json({ error: 'Missing userInput' }, 400)
    }

    const userInput = (body as Record<string, any>).userInput as string
    if (typeof userInput !== 'string' || !userInput.trim()) {
      return c.json({ error: 'userInput must be non-empty string' }, 400)
    }

    // Parse using L0 parser (deterministic, €0 cost)
    const parsed = parseUserInput(userInput)

    // Generate response based on parsed intent
    const response = generateResponse(parsed)

    return c.json({
      status: parsed.confidence > 0.7 ? 'ready' : 'clarify',
      message: response,
      parsed: {
        intent: parsed.intent,
        confidence: parsed.confidence,
        data: parsed.data
      }
    })
  } catch (err) {
    console.error('[Agent] Error:', err)
    return c.json({ error: 'Agent error' }, 500)
  }
})

/**
 * Genera respuesta amigable basada en parsed intent
 */
function generateResponse(parsed: ReturnType<typeof parseUserInput>): string {
  const { intent, data, confidence } = parsed

  switch (intent) {
    case 'create_income':
      return `✓ Ingreso de €${data.amount} propuesto — ${data.clientName} (${data.concept}). IVA: €${data.vat}`

    case 'create_expense':
      return `✓ Gasto de €${data.amount} propuesto — ${data.concept}`

    case 'query_balance':
      return `💰 ¿Quieres ver el balance de hoy? Usa GET /api/dashboard/stats`

    case 'query_debtors':
      return `⚠️ ¿Clientes morosos? Usa GET /api/dashboard/alerts`

    case 'query_income':
      return `📊 Total ingresos — Usa GET /api/transactions?type=income`

    case 'query_expense':
      return `📊 Total gastos — Usa GET /api/transactions?type=expense`

    case 'unclear':
    case 'unclear_query':
    default:
      return `Intenta: "Ingreso 150 paula", "Gasto 50 tinturas", "¿Balance?", "¿Qué debo?"`
  }
}

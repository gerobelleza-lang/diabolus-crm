import { Hono } from 'hono'
import { parseUserInput } from '../agent/parser'
import { routeToLLM, callOpenRouter, DIABOLUS_SYSTEM_PROMPT } from '../agent/llm-router'

export const agentRoutes = new Hono()

/**
 * POST /api/agent/chat
 * Procesa input natural usando: L0 (deterministic) → L1-3 (LLM si es necesario)
 */
agentRoutes.post('/chat', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))

    if (!body || typeof body !== 'object' || !('userInput' in body)) {
      return c.json({ error: 'Missing userInput' }, 400)
    }

    const userInput = (body as Record<string, any>).userInput as string
    if (typeof userInput !== 'string' || !userInput.trim()) {
      return c.json({ error: 'userInput must be non-empty string' }, 400)
    }

    // Step 1: L0 Parser (deterministic, €0)
    const parsed = parseUserInput(userInput)

    // Step 2: Decide routing
    const routing = routeToLLM(
      parsed.confidence,
      userInput,
      parsed.intent === 'create_income' || parsed.intent === 'create_expense'
    )

    // Step 3: Generate response
    let finalResponse: string
    if (routing.level === 'L0') {
      // Use L0 parser response
      finalResponse = generateL0Response(parsed)
    } else {
      // Use LLM
      try {
        const llmResponse = await callOpenRouter(
          routing.model,
          userInput,
          DIABOLUS_SYSTEM_PROMPT
        )
        finalResponse = llmResponse
      } catch (err) {
        console.warn('[LLM] Error, falling back to L0:', err)
        finalResponse = generateL0Response(parsed)
      }
    }

    return c.json({
      status: 'success',
      message: finalResponse,
      routing: {
        level: routing.level,
        model: routing.model,
        rationale: routing.rationale,
        estimatedCost: `€${routing.estimatedCost}`
      },
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
 * L0 response cuando parser es suficientemente confiable
 */
function generateL0Response(parsed: ReturnType<typeof parseUserInput>): string {
  const { intent, data, confidence } = parsed

  switch (intent) {
    case 'create_income':
      return `✓ Ingreso de €${data.amount} propuesto — ${data.clientName} (${data.concept}). IVA: €${data.vat}`

    case 'create_expense':
      return `✓ Gasto de €${data.amount} propuesto — ${data.concept}`

    case 'query_balance':
      return `💰 Balance de hoy — usa GET /api/dashboard/stats para detalles`

    case 'query_debtors':
      return `⚠️ Clientes morosos — usa GET /api/dashboard/alerts`

    case 'query_income':
      return `📊 Total ingresos — usa GET /api/transactions?type=income`

    case 'query_expense':
      return `📊 Total gastos — usa GET /api/transactions?type=expense`

    case 'unclear':
    case 'unclear_query':
    default:
      return `Intenta: "Ingreso 150 paula", "Gasto 50 tinturas", "¿Balance?", "¿Qué debo?"`
  }
}

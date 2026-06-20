/**
 * LLM Router — L0→L1→L2→L3
 *
 * Decisión de qué modelo usar basada en complejidad de query
 * L0: Parser deterministic (€0.00, instant)
 * L1: Haiku (€0.001, para queries simple)
 * L2: Sonnet + tools (€0.005, para acciones)
 * L3: GPT-4 (€0.02, análisis complejo)
 */

export interface RoutingDecision {
  level: 'L0' | 'L1' | 'L2' | 'L3'
  model: string
  rationale: string
  estimatedCost: number
}

/**
 * Decide qué nivel de LLM usar basado en:
 * - Confianza del parser L0
 * - Complejidad de la query
 * - Necesidad de tools externos
 */
export function routeToLLM(
  parserConfidence: number,
  userInput: string,
  needsTools: boolean
): RoutingDecision {
  // L0 is confident enough
  if (parserConfidence > 0.85 && !needsTools) {
    return {
      level: 'L0',
      model: 'parser',
      rationale: 'Parser L0 confident (>85%). No tools needed.',
      estimatedCost: 0
    }
  }

  // Simple query, slight doubts
  if (parserConfidence > 0.7 && userInput.length < 100) {
    return {
      level: 'L1',
      model: 'anthropic/claude-haiku-4.5',
      rationale: 'Parser semi-confident (70-85%). Simple query (<100 chars).',
      estimatedCost: 0.001
    }
  }

  // Needs to execute actions (create/update)
  if (needsTools || userInput.includes('crear') || userInput.includes('crear')) {
    return {
      level: 'L2',
      model: 'anthropic/claude-sonnet-4.5',
      rationale: 'Tools needed or action requested. Use Sonnet.',
      estimatedCost: 0.005
    }
  }

  // Complex analysis (report, summary, insights)
  if (
    userInput.includes('analiza') ||
    userInput.includes('analizar') ||
    userInput.includes('resumen') ||
    userInput.includes('insights') ||
    userInput.length > 200
  ) {
    return {
      level: 'L3',
      model: 'openai/gpt-4-turbo',
      rationale: 'Complex analysis or long input. Use GPT-4.',
      estimatedCost: 0.02
    }
  }

  // Default: use Sonnet for safety
  return {
    level: 'L2',
    model: 'anthropic/claude-sonnet-4-20250514',
    rationale: 'Default to Sonnet for balanced accuracy/cost.',
    estimatedCost: 0.005
  }
}

/**
 * Llama OpenRouter con el modelo decidido
 */
export async function callOpenRouter(
  model: string,
  userMessage: string,
  systemPrompt?: string
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set. Fallback to L0 parser.')
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://diabolus.crm',
      'X-Title': 'Diabolus CRM'
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 500
    })
  })

  if (!response.ok) {
    throw new Error(`OpenRouter error: ${response.statusText}`)
  }

  const data = (await response.json()) as any
  return data.choices?.[0]?.message?.content || 'No response from LLM'
}

/**
 * System prompt para Diabolus
 */
export const DIABOLUS_SYSTEM_PROMPT = `You are Diabolus, an intelligent financial assistant for small business owners and professionals.

Your role:
- Help manage invoices, expenses, and cash flow
- Analyze financial data
- Suggest improvements
- Respond in Spanish (usuario's language)
- Be concise and actionable

Context:
- User has invoices, transactions, clients, and expenses
- They need clear, quick insights
- Avoid unnecessary complexity

Tone: Professional, helpful, direct.`

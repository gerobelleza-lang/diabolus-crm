/**
 * ⚖️ El Abogado — Legislación española real.
 *
 * Wrapper: las consultas legales se redirigen internamente a la
 * ruta /api/legal/ask que ya tiene RAG con legislación española.
 * Aquí solo construimos el mensaje para el flujo del chat.
 */

import { DIABLO_METAS } from './index'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'
import { routeToLLM, callOpenRouter } from '../llm-router'
import { getSalonAIConfig } from '../memory'
import type { BrainTier } from '../memory'

const ABOGADO_SYSTEM_PROMPT = `Eres El Abogado de Diabolus. Tu especialidad es legislación española para autónomos y PYMEs.

REGLAS:
- SIEMPRE cita el artículo o norma exacta cuando respondas
- Si no estás seguro al 100%, di: "Consulta esto con un abogado colegiado"
- Estilo: asesor directo, no profesor. Respuestas concisas
- Áreas: IVA, IRPF, Seguridad Social, contratos laborales, protección de datos (LOPD/RGPD), facturación electrónica, VeriFactu
- NUNCA inventes artículos o leyes
- Temperatura 0.1 — máxima precisión
- max_tokens 2000 — respuestas completas pero no divagantes`

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const userInput = (input.text || '').trim()
  const { tenantId } = input

  try {
    const aiConfig = await getSalonAIConfig(tenantId)
    const brainTier: BrainTier = aiConfig.brain_tier || 'rapida'
    const routing = routeToLLM(0.5, userInput, false, brainTier)

    const response = await callOpenRouter(routing.model, userInput, ABOGADO_SYSTEM_PROMPT)

    return {
      replyText: response,
      routing: {
        level: routing.level,
        model: routing.model,
        label: '⚖️ El Abogado',
        estimatedCost: `€${routing.estimatedCost}`,
      },
    }
  } catch {
    return { replyText: 'No pude consultar la base legal ahora. Inténtalo en un momento.' }
  }
}

export const AbogadoDiablo: DiabloHandler = {
  meta: DIABLO_METAS.abogado,
  handle,
}

/**
 * 📜 El Escribano — Documenta todo.
 *
 * Maneja: albaranes, contratos, presupuestos, notas de entrega.
 * Guía al usuario hacia el flujo correcto para cada documento.
 *
 * Temp: 0.2 (documentos formales, precisos)
 * max_tokens: 1000 (documentos pueden ser largos)
 */

import { DIABLO_METAS } from './metas'
import { routeToLLM, callOpenRouter } from '../llm-router'
import { logDiabloUsage } from './metrics'
import { getSalonAIConfig } from '../memory'
import type { BrainTier } from '../memory'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './metas'
import type { AgentInput } from '../core'

const ESCRIBANO_SYSTEM_PROMPT = `Eres El Escribano de Diabolus. Documentas todo lo que el negocio necesita.

PERSONALIDAD:
- Formal y preciso. Los documentos son compromisos legales
- Si falta información, pregunta lo MÍNIMO necesario
- Nunca dejes un documento incompleto: mejor preguntar que inventar

DOCUMENTOS QUE GENERAS:
1. ALBARANES: cliente, descripción servicio/producto, cantidad, importe
   - Comando: "albarán para [cliente] por [cantidad] [producto] a [precio]"
   - Necesita: cliente, concepto, cantidad, precio unitario

2. PRESUPUESTOS: partidas con descripción, cantidad, precio, IVA
   - Comando: "presupuesto para [cliente] de [servicio]"
   - Necesita: cliente, partidas, precios, validez

3. CONTRATOS: partes, objeto, condiciones, duración
   - Comando: "contrato de [tipo] con [cliente]"
   - Necesita: partes, objeto del contrato, condiciones

REGLAS:
- Formato profesional siempre
- Fechas en formato español (dd/mm/aaaa)
- Importes con 2 decimales y símbolo €
- Si el documento tiene implicaciones legales, avisa: "Revísalo con tu asesor antes de firmar"
- Para albaranes, usa el panel de documentos del dashboard si la info es completa`

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const userInput = (input.text || '').trim()
  const { tenantId, userId = 'unknown' } = input

  if (classification.intent === 'crear_albaran') {
    return {
      replyText: [
        '📜 Para crear un albarán necesito:',
        '• Cliente (nombre)',
        '• Descripción del servicio/producto',
        '• Cantidad e importe',
        '',
        'Ej: "albarán para López por 3 cajas de material a 50€"',
        '',
        'O puedes crearlo desde el panel de documentos en el dashboard.',
      ].join('\n'),
    }
  }

  // For general document queries, use LLM to guide
  try {
    const aiConfig = await getSalonAIConfig(tenantId)
    const brainTier: BrainTier = aiConfig.brain_tier || 'rapida'
    const routing = routeToLLM(0.5, userInput, false, brainTier)

    const startMs = Date.now()
    const { text: response, usage } = await callOpenRouter(
      routing.model,
      userInput,
      ESCRIBANO_SYSTEM_PROMPT,
      { temperature: 0.2, max_tokens: 1000 }
    )

    if (usage) {
      logDiabloUsage(userId, tenantId, {
        diablo: 'escribano', ...usage, response_ms: Date.now() - startMs
      })
    }

    return {
      replyText: response,
      routing: {
        level: routing.level,
        model: routing.model,
        label: '📜 El Escribano',
        estimatedCost: `€${routing.estimatedCost}`,
      },
    }
  } catch {
    return {
      replyText: '📜 Dime qué documento necesitas: albarán, contrato o presupuesto. Ej: "albarán para López 500€ instalación".',
    }
  }
}

export const EscribanoDiablo: DiabloHandler = {
  meta: DIABLO_METAS.escribano,
  handle,
}

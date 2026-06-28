/**
 * 🪞 El Confesor — El único Diablo que no empuja.
 *
 * Maneja: ayuda, guía, preguntas sobre la app, intents no clasificados.
 * Tono: empático, paciente, cero prisas.
 *
 * Temp: 0.7 (humano, cálido)
 * max_tokens: 600 (paso a paso, no listas interminables)
 */

import { DIABLO_METAS } from './index'
import { routeToLLM, callOpenRouter } from '../llm-router'
import { getSalonAIConfig } from '../memory'
import type { BrainTier } from '../memory'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'

const CONFESOR_SYSTEM_PROMPT = `Eres El Confesor de Diabolus. El único Diablo que no empuja, no vende, no cobra. Escuchas.

PERSONALIDAD:
- Empático y paciente. Si el usuario está frustrado, baja el ritmo
- Explica paso a paso: UN paso, pausa, siguiente paso. Nunca listas de 10 cosas
- Si lleva meses sin facturar, no regañas — ayudas a dar el primer paso
- Tono cercano, cálido, sin prisas. Como un compañero que sabe del tema

CÓMO EXPLICAS:
- Primero confirma que entiendes la duda: "Entendido, quieres saber cómo..."
- Luego el paso concreto: "Escríbele a Diablilla: 'factura a López 500€ instalación'"
- Si hay varios pasos, ve uno a uno
- Usa ejemplos reales del contexto del usuario cuando puedas

FUNCIONES QUE PUEDES EXPLICAR:
- Facturas: "factura a [nombre] [importe] [concepto]" → crea borrador
- Gastos: "gasté 80€ en material" → registra gasto
- Ingresos: "cobré 300€ de García" → registra ingreso
- Clientes: "nuevo cliente Ana García" → da de alta
- Recordatorios: "manda recordatorio a López" → WhatsApp/email
- Balance: "¿cómo voy?" → resumen financiero
- Legal: "¿cuánto IVA aplico?" → consulta legislación
- Catálogo: productos con precio e IVA preconfigurado
- Fotos de tickets: envía foto → registra automáticamente

LÍMITES ESTRICTOS:
- NUNCA ejecutas acciones. Solo guías
- Si el usuario quiere hacer algo, dale el comando exacto para Diablilla
- Si no puedes resolver: "Esto se lo paso a Diablilla"`

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId } = input
  const userInput = (input.text || '').trim()

  // ── Static help response ──────────────────────────────────────────────────
  if (classification.intent === 'ayuda') {
    return {
      replyText: [
        '🪞 <b>Hola. Soy El Confesor. Estoy aquí para ayudarte.</b>',
        '',
        'Pregúntame lo que necesites:',
        '',
        '🧾 "¿Cómo creo una factura?"',
        '💰 "¿Cómo registro un gasto?"',
        '👥 "¿Cómo añado un cliente?"',
        '📩 "¿Cómo mando un recordatorio?"',
        '📊 "¿Cómo veo mi balance?"',
        '',
        'Sin prisas. Estoy aquí. 🪞',
      ].join('\n'),
    }
  }

  // ── LLM-powered guidance ──────────────────────────────────────────────────
  try {
    const aiConfig = await getSalonAIConfig(tenantId)
    const brainTier: BrainTier = aiConfig.brain_tier || 'rapida'
    const routing = routeToLLM(0.3, userInput, false, brainTier)

    const response = await callOpenRouter(
      routing.model,
      userInput,
      CONFESOR_SYSTEM_PROMPT,
      { temperature: 0.7, max_tokens: 600 }
    )

    return {
      replyText: response,
      routing: {
        level: routing.level,
        model: routing.model,
        label: '🪞 El Confesor',
        estimatedCost: `€${routing.estimatedCost}`,
      },
    }
  } catch {
    return {
      replyText: 'Estoy aquí para ayudarte. ¿Qué necesitas saber? Pregúntame sobre facturas, gastos, clientes o cualquier función.',
    }
  }
}

export const ConfesorDiablo: DiabloHandler = {
  meta: DIABLO_METAS.confesor,
  handle,
}

/**
 * 🪞 El Confesor — El único Diablo que no empuja.
 *
 * Maneja: ayuda, guía, preguntas sobre la app, intents no clasificados.
 * Tono: empático, paciente, cero prisas.
 */

import { DIABLO_METAS } from './index'
import { routeToLLM, callOpenRouter } from '../llm-router'
import { buildMemoryContext, getSalonAIConfig } from '../memory'
import type { BrainTier } from '../memory'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'

const CONFESOR_SYSTEM_PROMPT = `Eres El Confesor de Diabolus. El único Diablo que no empuja, no vende, no cobra. Escuchas.

PERSONALIDAD:
- Empático y paciente. Nunca juzgas.
- Si el usuario está frustrado, baja el ritmo
- Explica paso a paso, NUNCA listas de 10 cosas
- Si el usuario lleva meses sin facturar, no regañas — ayudas
- Tono: cercano, cálido, sin prisas
- Temperatura alta (0.7) para sonar humano

QUÉ PUEDES HACER:
- Explicar cualquier función de Diabolus sin tecnicismos
- Guiar paso a paso para crear facturas, registrar gastos, etc.
- Resolver dudas sobre la app
- Si no puedes resolver algo, escalas: "Esto se lo paso a Diablilla para que lo gestione"

FUNCIONES DE LA APP QUE PUEDES EXPLICAR:
- Facturas: crear, enviar, cambiar estado, ver vencidas
- Tesorería: registrar ingresos/gastos, ver balance, ver quién debe
- Clientes: crear, buscar, ficha 360°
- Recordatorios: enviar por WhatsApp o email
- Catálogo: productos con precio e IVA
- Gestoría: exportar datos para tu gestor
- Legal: consultas sobre legislación española
- Dashboard: resumen del negocio, salud financiera

LÍMITES:
- NUNCA ejecutas acciones (no creas facturas, no registras gastos)
- Solo guías y explicas
- Si el usuario quiere hacer algo, le dices cómo pedírselo a Diablilla`

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId } = input
  const userInput = (input.text || '').trim()

  // ── Static help response ──────────────────────────────────────────────────
  if (classification.intent === 'ayuda') {
    return {
      replyText: [
        '🪞 <b>Hola. Soy El Confesor. Estoy aquí para ayudarte.</b>',
        '',
        'Puedo explicarte cualquier cosa de la app. Solo pregunta:',
        '',
        '🧾 "¿Cómo creo una factura?"',
        '💰 "¿Cómo registro un gasto?"',
        '👥 "¿Cómo añado un cliente?"',
        '📩 "¿Cómo mando un recordatorio?"',
        '📊 "¿Cómo veo mi balance?"',
        '',
        'O si prefieres, dime "¿qué puedes hacer?" y te cuento todo paso a paso.',
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

    const response = await callOpenRouter(routing.model, userInput, CONFESOR_SYSTEM_PROMPT)

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
      replyText: 'Estoy aquí para ayudarte. ¿Qué necesitas saber? Puedes preguntarme sobre facturas, gastos, clientes o cualquier función de la app.',
    }
  }
}

export const ConfesorDiablo: DiabloHandler = {
  meta: DIABLO_METAS.confesor,
  handle,
}

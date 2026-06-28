/**
 * 🏹 El Cazador — Trae leads nuevos.
 *
 * Maneja consultas sobre leads en el chat.
 * Para análisis inteligente usa LLM con contexto de datos.
 *
 * Temp: 0.4 (algo de creatividad en análisis de oportunidades)
 * max_tokens: 600 (resúmenes concisos)
 */

import { getSupabase, DIABLO_METAS } from './index'
import { routeToLLM, callOpenRouter } from '../llm-router'
import { logDiabloUsage } from './metrics'
import { getSalonAIConfig } from '../memory'
import type { BrainTier } from '../memory'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'

const CAZADOR_SYSTEM_PROMPT = `Eres El Cazador de Diabolus. Tu única misión: traer clientes nuevos.

PERSONALIDAD:
- Agresivo comercialmente pero nunca spam
- Datos primero: "Tienes 12 leads, 3 calientes"
- Siempre sugiere la siguiente acción: "¿Contacto al de score 9?"

QUÉ HACES:
- Resumes el estado de la cartera de leads
- Priorizas por score (7+ = caliente, 4-6 = tibio, <4 = frío)
- Sugieres a quién contactar primero y por qué
- Cada mañana a las 08:00 preparas preview para el dueño

REGLAS:
- NO contactas a nadie sin permiso del dueño
- Los días de aviso son configurables por negocio (default 1/3/7)
- Si no hay leads: sugiere fuentes (Google Maps, redes, boca a boca)
- Si hay leads fríos: sugiere descartarlos o último intento

FORMATO:
- Empieza con el número total y desglose caliente/tibio/frío
- Top 3 leads más prometedores con motivo
- UNA sugerencia de acción inmediata`

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId = 'unknown' } = input
  const userInput = (input.text || '').trim()

  try {
    const supabase = getSupabase()
    const { data: leads, count } = await supabase
      .from('leads')
      .select('name, status, score, phone, email, source, notes, last_contact', { count: 'exact' })
      .eq('salon_id', tenantId)
      .order('score', { ascending: false })
      .limit(20)

    if (!leads?.length) {
      return { replyText: 'No hay leads registrados aún. El Cazador está listo para empezar cuando des la orden. 🏹' }
    }

    const total = count || leads.length
    const hot = leads.filter(l => (l.score || 0) >= 7)
    const warm = leads.filter(l => (l.score || 0) >= 4 && (l.score || 0) < 7)
    const cold = total - hot.length - warm.length
    const contacted = leads.filter(l => l.status === 'contacted').length
    const converted = leads.filter(l => l.status === 'converted').length

    // Simple stats query → return directly without LLM
    const isSimpleQuery = /^(cu[aá]ntos|cuantos|estado|resumen|leads)/i.test(userInput)

    if (isSimpleQuery) {
      const topLeads = hot.slice(0, 3).map(l =>
        `  • ${l.name} (score ${l.score}) ${l.phone ? '📱' : ''} ${l.email ? '📧' : ''}`
      ).join('\n')

      return {
        replyText: [
          `🏹 <b>El Cazador — Estado de leads</b>`,
          '',
          `Total: ${total} leads`,
          `🔥 Calientes (7+): ${hot.length}`,
          `🟡 Tibios (4-6): ${warm.length}`,
          `🔵 Fríos (<4): ${cold}`,
          `📞 Contactados: ${contacted}`,
          `✅ Convertidos: ${converted}`,
          ...(topLeads ? ['', '🎯 Top leads:', topLeads] : []),
        ].join('\n'),
      }
    }

    // Complex query → use LLM with lead data context
    const aiConfig = await getSalonAIConfig(tenantId)
    const brainTier: BrainTier = aiConfig.brain_tier || 'rapida'
    const routing = routeToLLM(0.5, userInput, false, brainTier)

    const leadsSummary = leads.slice(0, 10).map(l =>
      `- ${l.name}: score ${l.score}, status ${l.status}, fuente ${l.source || 'desconocida'}${l.last_contact ? `, último contacto ${l.last_contact}` : ''}`
    ).join('\n')

    const contextPrompt = `${CAZADOR_SYSTEM_PROMPT}\n\nDATOS DE LEADS:\nTotal: ${total} | Calientes: ${hot.length} | Tibios: ${warm.length} | Fríos: ${cold}\n\nTop 10:\n${leadsSummary}`

    const startMs = Date.now()
    const { text: response, usage } = await callOpenRouter(
      routing.model,
      userInput,
      contextPrompt,
      { temperature: 0.4, max_tokens: 600 }
    )

    if (usage) {
      logDiabloUsage(userId, tenantId, {
        diablo: 'cazador', ...usage, response_ms: Date.now() - startMs
      })
    }

    return {
      replyText: response,
      routing: {
        level: routing.level,
        model: routing.model,
        label: '🏹 El Cazador',
        estimatedCost: `€${routing.estimatedCost}`,
      },
    }
  } catch {
    return { replyText: 'No pude consultar los leads ahora. Inténtalo en un momento.' }
  }
}

export const CazadorDiablo: DiabloHandler = {
  meta: DIABLO_METAS.cazador,
  handle,
}

/**
 * 🏹 El Cazador — Trae leads nuevos.
 *
 * Wrapper sobre routes/cazador.ts que ya tiene toda la lógica.
 * Este Diablo responde consultas sobre leads vía el chat.
 */

import { getSupabase, DIABLO_METAS } from './index'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId } = input
  const userInput = (input.text || '').trim().toLowerCase()

  // Quick stats query
  try {
    const supabase = getSupabase()
    const { data: leads, count } = await supabase
      .from('leads')
      .select('status, score', { count: 'exact' })
      .eq('salon_id', tenantId)

    if (!leads?.length) {
      return { replyText: 'No hay leads registrados aún. El Cazador está listo para empezar cuando des la orden. 🏹' }
    }

    const total = count || leads.length
    const hot = leads.filter(l => (l.score || 0) >= 7).length
    const warm = leads.filter(l => (l.score || 0) >= 4 && (l.score || 0) < 7).length
    const cold = total - hot - warm
    const contacted = leads.filter(l => l.status === 'contacted').length
    const converted = leads.filter(l => l.status === 'converted').length

    return {
      replyText: [
        `🏹 <b>El Cazador — Estado de leads</b>`,
        '',
        `Total: ${total} leads`,
        `🔥 Calientes (7+): ${hot}`,
        `🟡 Tibios (4-6): ${warm}`,
        `🔵 Fríos (<4): ${cold}`,
        `📞 Contactados: ${contacted}`,
        `✅ Convertidos: ${converted}`,
      ].join('\n'),
    }
  } catch {
    return { replyText: 'No pude consultar los leads ahora. Inténtalo en un momento.' }
  }
}

export const CazadorDiablo: DiabloHandler = {
  meta: DIABLO_METAS.cazador,
  handle,
}

/**
 * 🪞 El Confesor v2 — Guía, onboarding, ayuda contextual
 *
 * El 9º y último Diablo. El único que NUNCA ejecuta acciones.
 *
 * REGLA ABSOLUTA: El Confesor NUNCA ejecuta acciones.
 * No crea pending actions, no emite intents, no muta datos.
 * Solo enseña al usuario cómo hablar con Diablilla.
 *
 * Arquitectura v2:
 *   Capa 0 — Retrieval: stats del usuario (1 query paralela con Promise.all, head:true)
 *   Capa 1 — LLM: guía contextual con DIABLO_METAS dinámicos
 *   (No hay Capa 2 ni 3: no valida ni ejecuta nada)
 *
 * Complejidad 0.6 — el onboarding merece cerebro decente.
 */

import { DIABLO_METAS, DIABLO_TAGS } from './metas'
import { routeToLLM, callOpenRouter } from '../llm-router'
import { logDiabloUsage } from './metrics'
import { getSalonAIConfig } from '../memory'
import type { BrainTier } from '../memory'
import type { DiabloHandler, DiabloMeta, DiabloResponse, IntentClassification } from './metas'
import type { AgentInput } from '../core'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UserStats {
  totalInvoices: number
  totalExpenses: number
  totalIncomes: number
  totalClients: number
  totalDocuments: number
  hasUsedAgent: boolean
}

export type UserLevel = 'novato' | 'intermedio' | 'avanzado'

// ─── Capa 0: Retrieval — Stats del usuario (1 sola ronda con Promise.all) ──

export async function fetchUserStats(
  supabase: any,
  salonId: string
): Promise<UserStats> {
  try {
    const [invoices, expenses, incomes, clients, documents] = await Promise.all([
      supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('salon_id', salonId),
      supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('salon_id', salonId).eq('type', 'expense'),
      supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('salon_id', salonId).eq('type', 'income'),
      supabase.from('clients').select('id', { count: 'exact', head: true }).eq('salon_id', salonId),
      supabase.from('documents').select('id', { count: 'exact', head: true }).eq('salon_id', salonId),
    ])

    const stats: UserStats = {
      totalInvoices: invoices.count ?? 0,
      totalExpenses: expenses.count ?? 0,
      totalIncomes: incomes.count ?? 0,
      totalClients: clients.count ?? 0,
      totalDocuments: documents.count ?? 0,
      hasUsedAgent: false,
    }
    stats.hasUsedAgent = (stats.totalInvoices + stats.totalExpenses + stats.totalIncomes + stats.totalClients) > 0
    return stats
  } catch {
    return fallbackStats()
  }
}

function fallbackStats(): UserStats {
  return {
    totalInvoices: 0, totalExpenses: 0, totalIncomes: 0,
    totalClients: 0, totalDocuments: 0, hasUsedAgent: false,
  }
}

// ─── User level detection ──────────────────────────────────────────────────

export function detectUserLevel(stats: UserStats): UserLevel {
  const total = stats.totalInvoices + stats.totalExpenses + stats.totalIncomes
  if (total === 0) return 'novato'
  if (total < 20) return 'intermedio'
  return 'avanzado'
}

// ─── Capacidades dinámicas desde DIABLO_METAS ──────────────────────────────

/** Example commands per Diablo (for guidance, NOT execution) */
const DIABLO_EXAMPLES: Record<string, string[]> = {
  facturador: ['"factura a López 500€ instalación"', '"nueva factura para Ana García"'],
  contable:   ['"gasté 80€ en productos"', '"cobré 300€ de García"', '"¿cómo voy este mes?"'],
  cobrador:   ['"¿quién me debe?"', '"facturas vencidas"'],
  closer:     ['"nuevo cliente Ana García 600123456"', '"busca a López"'],
  cazador:    ['"manda recordatorio a López"'],
  abogado:    ['"¿cuánto IVA aplico a servicios?"', '"¿qué dice la ley sobre facturas?"'],
  escribano:  ['"albarán para Cliente Prueba, 3 cajas tinte a 50€"', '"presupuesto para García"'],
  guardian:   ['"¿cómo está mi salud financiera?"'],
}

export function buildCapabilitiesList(): string {
  const lines: string[] = []
  for (const [name, meta] of Object.entries(DIABLO_METAS)) {
    if (name === 'confesor') continue
    const tag = DIABLO_TAGS[name as keyof typeof DIABLO_TAGS]
    lines.push(`• ${meta.emoji} **${meta.displayName}** — ${meta.description}`)
    const examples = DIABLO_EXAMPLES[name]
    if (examples) {
      for (const ex of examples.slice(0, 2)) {
        lines.push(`  → _${ex}_`)
      }
    }
  }
  return lines.join('\n')
}

// ─── Suggested next actions based on stats ─────────────────────────────────

export function suggestNextActions(stats: UserStats): string[] {
  const suggestions: string[] = []

  if (stats.totalClients === 0) {
    suggestions.push('Empieza registrando un cliente: _"nuevo cliente María García 600123456"_')
  }
  if (stats.totalInvoices === 0 && stats.totalClients > 0) {
    suggestions.push('Crea tu primera factura: _"factura a [nombre] por [importe]"_')
  }
  if (stats.totalExpenses === 0) {
    suggestions.push('Apunta tu primer gasto: _"gasto 50€ en productos"_')
  }
  if (stats.totalIncomes === 0 && stats.totalInvoices > 0) {
    suggestions.push('Registra un cobro: _"ingreso 200€ de [cliente]"_')
  }
  if (stats.totalDocuments === 0 && stats.totalClients > 0) {
    suggestions.push('Crea un albarán: _"albarán para [cliente], 3 cajas de tinte a 50€"_')
  }
  if (stats.totalInvoices > 0 && stats.totalExpenses > 0) {
    suggestions.push('Consulta tu balance: _"¿cuánto llevo este mes?"_')
  }

  return suggestions.slice(0, 3)
}

// ─── System prompt builder ─────────────────────────────────────────────────

export function buildSystemPrompt(stats: UserStats, level: UserLevel): string {
  const capabilities = buildCapabilitiesList()
  const suggestions = suggestNextActions(stats)

  const levelContext: Record<UserLevel, string> = {
    novato: 'El usuario es NUEVO — no ha usado el sistema. Sé especialmente claro y amable. Guía paso a paso, un paso a la vez.',
    intermedio: 'El usuario ya tiene experiencia básica. Puedes ser más directo y mostrar funciones avanzadas.',
    avanzado: 'El usuario es veterano. Sé conciso, enfócate en lo que pregunta sin explicar lo básico.',
  }

  const statsLine = `Datos del usuario: ${stats.totalClients} clientes, ${stats.totalInvoices} facturas, ${stats.totalExpenses} gastos, ${stats.totalIncomes} ingresos, ${stats.totalDocuments} documentos.`

  const suggestionsBlock = suggestions.length > 0
    ? `\n\nSUGERENCIAS PARA ESTE USUARIO:\n${suggestions.map(s => `• ${s}`).join('\n')}`
    : ''

  return `Eres El Confesor de Diabolus — el guía del sistema.
Tu ÚNICA misión es ENSEÑAR al usuario cómo hablar con Diablilla.
NUNCA ejecutas acciones. NUNCA creas facturas, gastos, clientes ni documentos.
Solo explicas qué comandos usar y cómo formularlos.

${levelContext[level]}
${statsLine}

CAPACIDADES DEL SISTEMA (lo que Diablilla puede hacer vía sus Diablos):
${capabilities}
${suggestionsBlock}

REGLAS:
1. Responde siempre en español
2. Sé breve y directo — máximo 3-4 frases
3. Siempre incluye al menos UN ejemplo concreto de comando que el usuario pueda copiar y pegar
4. Si el usuario pregunta por algo que NO hacemos, dilo claramente
5. JAMÁS digas que vas a crear/enviar/registrar algo — solo ENSEÑA el comando
6. Si detectas que el usuario quiere hacer algo concreto (ej: "no sé cómo hacer una factura"), enséñale el comando exacto
7. Tono: profesional pero cercano, empático con novatos
8. También puedes explicar: fotos de tickets (enviar foto → registro automático) y catálogo de productos`
}

// ─── Quick help (intent 'ayuda') — Dinámico ───────────────────────────────

export function buildQuickHelp(stats: UserStats): string {
  const capabilities = buildCapabilitiesList()
  const suggestions = suggestNextActions(stats)

  let response = `Soy tu Diablilla 😈 — hablo con 8 especialistas para gestionar tu tesorería.\n\n**Lo que puedo hacer:**\n${capabilities}`

  if (suggestions.length > 0) {
    response += `\n\n**Te sugiero empezar por:**\n${suggestions.map(s => `• ${s}`).join('\n')}`
  }

  return response
}

// ─── Capa 1: LLM call ─────────────────────────────────────────────────────

async function callLlm(
  systemPrompt: string,
  userInput: string,
  brainTier: BrainTier
): Promise<{ text: string; usage?: any }> {
  // Complejidad 0.6 — onboarding merece cerebro decente
  const routing = routeToLLM(0.6, userInput, false, brainTier)

  const { text, usage } = await callOpenRouter(routing.model, userInput, systemPrompt, {
    temperature: 0.6,
    max_tokens: 500,
  })

  return { text: text.trim(), usage }
}

// ─── Main handler ──────────────────────────────────────────────────────────

async function handleConfesor(
  input: AgentInput,
  classification: IntentClassification
): Promise<DiabloResponse> {
  const supabase = (await import('./index')).getSupabase()

  const salonId = input.tenantId
  const userId = input.userId || 'unknown'
  const userInput = (input.text || '').trim()

  // Capa 0: Stats (1 ronda paralela)
  const stats = await fetchUserStats(supabase, salonId)
  const level = detectUserLevel(stats)

  // Intent 'ayuda' → respuesta rápida sin LLM
  if (classification.intent === 'ayuda') {
    return { replyText: buildQuickHelp(stats) }
  }

  // Todo lo demás → LLM con contexto enriquecido
  const aiConfig = await getSalonAIConfig(salonId)
  const brainTier: BrainTier = aiConfig.brain_tier || 'inteligente'
  const systemPrompt = buildSystemPrompt(stats, level)

  const startMs = Date.now()
  const { text, usage } = await callLlm(systemPrompt, userInput, brainTier)
  const responseMs = Date.now() - startMs

  // Log usage
  if (usage) {
    logDiabloUsage(userId, salonId, {
      diablo: 'confesor',
      ...usage,
      response_ms: responseMs,
    })
  }

  return { replyText: text }
}

// ─── Export como DiabloHandler ─────────────────────────────────────────────

export const ConfesorDiablo: DiabloHandler = {
  meta: DIABLO_METAS.confesor,
  handle: handleConfesor,
}

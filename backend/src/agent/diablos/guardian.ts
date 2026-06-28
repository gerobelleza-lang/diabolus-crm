/**
 * 🛡️ El Guardián — Vigila riesgos y alertas.
 *
 * Maneja: salud financiera, dashboard context, insights proactivos.
 * Fuente única de datos de estado del negocio.
 */

import { getSupabase, DIABLO_METAS } from './index'
import { routeToLLM, callOpenRouter, generateProactiveInsights, getTimeContext } from '../llm-router'
import { logDiabloUsage } from './metrics'
import { buildMemoryContext, getSalonAIConfig } from '../memory'
import type { BrainTier } from '../memory'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'

const GUARDIAN_SYSTEM_PROMPT = `Eres El Guardián de Diabolus. Vigilas la salud financiera del negocio.

PERSONALIDAD:
- Directo y preciso. Números primero, opinión después
- Si hay peligro, dilo claro: "⚠️ Tienes 3 facturas vencidas por 2.400€"
- Si va bien, reconócelo: "✅ Mes sólido. Ingresos superan gastos"

ANÁLISIS QUE HACES:
- Balance actual: ingresos vs gastos del mes
- Comparativa con mes anterior (tendencia)
- Facturas pendientes y vencidas (urgencia si >15 días)
- Score de salud: usa datos reales, no inventes porcentajes

REGLAS:
- NUNCA inventes datos. Usa solo lo que tienes en el contexto
- Si faltan datos: "No tengo suficiente historial para comparar"
- Fin de mes: máxima urgencia en cobros pendientes
- Principio de mes: recordar gastos fijos por registrar
- Si el balance es negativo: alerta clara pero sin drama

FORMATO:
- Empieza con el dato más importante
- Máximo 3-4 puntos clave
- Cierra con UNA recomendación accionable
- Ej: "Tienes 1.200€ pendientes de cobro. ¿Mando recordatorio al moroso más gordo?"`

// ── Dashboard data structure ────────────────────────────────────────────────

export interface DashboardData {
  text: string
  structured: {
    pendingCount: number
    pendingAmount: number
    overdueCount: number
    overdueAmount: number
    monthIncome: number
    monthExpenses: number
    lastMonthIncome: number
  }
}

export async function getDashboardContext(salonId: string): Promise<DashboardData> {
  const empty: DashboardData = {
    text: 'Datos no disponibles en este momento',
    structured: {
      pendingCount: 0, pendingAmount: 0,
      overdueCount: 0, overdueAmount: 0,
      monthIncome: 0, monthExpenses: 0, lastMonthIncome: 0,
    },
  }
  try {
    const supabase      = getSupabase()
    const now           = new Date()
    const startOfMonth  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()

    const [{ data: invoices }, { data: txns }, { data: lastMonthTxns }] = await Promise.all([
      supabase.from('invoices').select('total, status, due_date').eq('salon_id', salonId),
      supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', startOfMonth),
      supabase.from('transactions').select('amount, type').eq('salon_id', salonId)
        .gte('created_at', startOfLastMonth).lt('created_at', startOfMonth),
    ])

    let pendingAmount = 0, pendingCount = 0, overdueAmount = 0, overdueCount = 0
    for (const inv of invoices || []) {
      if (['sent', 'pending'].includes(inv.status)) {
        pendingAmount += inv.total || 0; pendingCount++
        if (inv.due_date && new Date(inv.due_date) < now) {
          overdueAmount += inv.total || 0; overdueCount++
        }
      }
    }

    let income = 0, expenses = 0
    for (const t of txns || []) {
      if (t.type === 'income') income += t.amount || 0
      else if (t.type === 'expense') expenses += t.amount || 0
    }

    let lastMonthIncome = 0
    for (const t of lastMonthTxns || []) {
      if (t.type === 'income') lastMonthIncome += t.amount || 0
    }

    const structured = {
      pendingCount, pendingAmount,
      overdueCount, overdueAmount,
      monthIncome: income, monthExpenses: expenses,
      lastMonthIncome,
    }

    return {
      text: [
        `- Ingresos mes actual: EUR ${income.toFixed(2)}`,
        `- Gastos mes actual: EUR ${expenses.toFixed(2)}`,
        `- Balance: EUR ${(income - expenses).toFixed(2)}`,
        `- Pendiente de cobro: EUR ${pendingAmount.toFixed(2)} (${pendingCount} facturas)`,
        `- Vencido sin cobrar: EUR ${overdueAmount.toFixed(2)} (${overdueCount} facturas)`,
        `- Ingresos mes anterior: EUR ${lastMonthIncome.toFixed(2)}`,
      ].join('\n'),
      structured,
    }
  } catch {
    return empty
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId = 'unknown' } = input
  const userInput = (input.text || '').trim()

  try {
    const aiConfig = await getSalonAIConfig(tenantId)
    const brainTier: BrainTier = aiConfig.brain_tier || 'rapida'
    const routing = routeToLLM(0.5, userInput, false, brainTier)

    const [memoryCtx, dashData] = await Promise.all([
      buildMemoryContext(tenantId),
      getDashboardContext(tenantId),
    ])

    const contextualPrompt = GUARDIAN_SYSTEM_PROMPT + `\n\nDATOS ACTUALES DEL NEGOCIO:\n${dashData.text}\n\nHISTORIAL RECIENTE:\n${memoryCtx}`
    const startMs = Date.now()
    const { text: llmText, usage } = await callOpenRouter(routing.model, userInput, contextualPrompt, { temperature: 0.3, max_tokens: 1000 })
    let response = llmText

    // Always append a proactive insight from El Guardián
    const tc = getTimeContext()
    const insights = generateProactiveInsights({
      timeContext: tc,
      facturasPendientes: dashData.structured.pendingCount,
      facturasVencidas: dashData.structured.overdueCount,
      balanceMes: dashData.structured.monthIncome - dashData.structured.monthExpenses,
      balanceMesAnterior: dashData.structured.lastMonthIncome,
    })
    if (insights.length > 0) {
      const pick = insights[Math.floor(Math.random() * insights.length)]
      response += `\n\n💡 ${pick.texto}`
    }

    if (usage) {
      logDiabloUsage(userId, tenantId, {
        diablo: 'guardian', ...usage, response_ms: Date.now() - startMs
      })
    }

    return {
      replyText: response,
      routing: {
        level: routing.level,
        model: routing.model,
        label: '🛡️ El Guardián',
        estimatedCost: `€${routing.estimatedCost}`,
      },
    }
  } catch {
    // Fallback: show raw dashboard data
    const dashData = await getDashboardContext(tenantId)
    return { replyText: `🛡️ Estado del negocio:\n${dashData.text}` }
  }
}

export const GuardianDiablo: DiabloHandler = {
  meta: DIABLO_METAS.guardian,
  handle,
}

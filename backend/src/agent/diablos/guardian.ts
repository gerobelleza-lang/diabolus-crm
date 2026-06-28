/**
 * 🛡️ El Guardián — Vigila riesgos y alertas.
 *
 * Maneja: salud financiera, dashboard context, insights proactivos.
 * Fuente única de datos de estado del negocio.
 */

import { getSupabase, DIABLO_METAS } from './index'
import { routeToLLM, callOpenRouter, buildSystemPrompt, generateProactiveInsights, getTimeContext } from '../llm-router'
import { buildMemoryContext, getSalonAIConfig } from '../memory'
import type { BrainTier } from '../memory'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'

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
  const { tenantId } = input
  const userInput = (input.text || '').trim()

  try {
    const aiConfig = await getSalonAIConfig(tenantId)
    const brainTier: BrainTier = aiConfig.brain_tier || 'rapida'
    const routing = routeToLLM(0.5, userInput, false, brainTier)

    const [memoryCtx, dashData] = await Promise.all([
      buildMemoryContext(tenantId),
      getDashboardContext(tenantId),
    ])

    const systemPrompt = buildSystemPrompt(routing.label, memoryCtx, dashData.text, userInput)
    let response = await callOpenRouter(routing.model, userInput, systemPrompt)

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

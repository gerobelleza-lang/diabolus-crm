// @ts-nocheck
/**
 * POST /api/agent/chat   — procesa input natural
 *   - Lecturas: respuesta directa
 *   - Escrituras: devuelve confirmation_card (NUNCA escribe sin OK del usuario)
 *
 * POST /api/agent/confirm — ejecuta la acción pendiente tras OK del usuario
 * POST /api/agent/cancel  — descarta la acción pendiente
 */

import { Hono } from 'hono'
import { parseUserInput } from '../agent/parser'
import { routeToLLM, callOpenRouter, DIABOLUS_SYSTEM_PROMPT } from '../agent/llm-router'
import { createClient } from '@supabase/supabase-js'
import { createPendingAction, executePendingAction, cancelPendingAction } from '../agent/confirmation'
import { suggestCategory } from '../agent/tools'

export const agentRoutes = new Hono()

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  return createClient(url, key)
}

// ─── POST /api/agent/chat ──────────────────────────────────────────────────────

agentRoutes.post('/chat', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))

    if (!body || typeof body !== 'object' || !('userInput' in body)) {
      return c.json({ error: 'Missing userInput' }, 400)
    }

    const userInput = body.userInput as string
    if (typeof userInput !== 'string' || !userInput.trim()) {
      return c.json({ error: 'userInput must be non-empty string' }, 400)
    }

    const salonId = c.get('salonId') as string
    const userId  = c.get('userId')  as string

    // Step 1: L0 Parser (deterministic, €0)
    const parsed = parseUserInput(userInput)

    // ── WRITE intents → gate de confirmación ──────────────────────────────────
    if (parsed.intent === 'create_income' || parsed.intent === 'create_expense') {
      const isIncome = parsed.intent === 'create_income'

      // Validar que tenemos importe
      if (!parsed.data.amount || parsed.data.amount <= 0) {
        return c.json({
          status: 'needs_info',
          message: isIncome
            ? '¿Cuánto cobraste? Dime el importe. Ej: "cobré 150€ de Juan"'
            : '¿Cuánto gastaste? Dime el importe. Ej: "gasté 80€ en materiales"',
        })
      }

      const actionType = isIncome ? 'registrar_ingreso' : 'registrar_gasto'
      const parameters = isIncome
        ? {
            importe:  parsed.data.amount,
            concepto: parsed.data.concept || 'Servicio',
            cliente:  parsed.data.clientName !== 'Cliente' ? parsed.data.clientName : undefined,
            categoria: 'servicios',
          }
        : {
            importe:          parsed.data.amount,
            concepto:         parsed.data.concept || 'Gasto',
            es_gasto_empresa: true,
            categoria:        suggestCategory(parsed.data.concept || ''),
          }

      // Crea la acción pendiente en BD y devuelve la tarjeta
      const card = await createPendingAction(actionType, parameters, salonId, userId)

      return c.json({
        status: 'pending_confirmation',
        card,
      })
    }

    // ── READ intents → ejecutar directamente ──────────────────────────────────
    const routing = routeToLLM(parsed.confidence, userInput, false)

    let finalResponse: string
    if (routing.level === 'L0') {
      finalResponse = await generateL0ReadResponse(parsed)
    } else {
      try {
        const ctx = await getDashboardContext()
        const systemWithCtx = DIABOLUS_SYSTEM_PROMPT + '\n\nDatos actuales del negocio:\n' + ctx
        finalResponse = await callOpenRouter(routing.model, userInput, systemWithCtx)
      } catch (err) {
        console.warn('[LLM] Error, falling back to L0:', err)
        finalResponse = await generateL0ReadResponse(parsed)
      }
    }

    return c.json({
      status: 'success',
      message: finalResponse,
      routing: {
        level: routing.level,
        model: routing.model,
        rationale: routing.rationale,
        estimatedCost: `€${routing.estimatedCost}`,
      },
    })
  } catch (err) {
    console.error('[Agent] Error:', err)
    return c.json({ error: 'Agent error' }, 500)
  }
})

// ─── POST /api/agent/confirm ───────────────────────────────────────────────────

agentRoutes.post('/confirm', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { pending_action_id } = body

    if (!pending_action_id) {
      return c.json({ error: 'Missing pending_action_id' }, 400)
    }

    const result = await executePendingAction(pending_action_id)

    return c.json({
      status: result.ok ? 'success' : 'error',
      message: result.message,
    })
  } catch (err) {
    console.error('[Agent/Confirm] Error:', err)
    return c.json({ error: 'Confirm error' }, 500)
  }
})

// ─── POST /api/agent/cancel ────────────────────────────────────────────────────

agentRoutes.post('/cancel', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { pending_action_id } = body

    if (!pending_action_id) {
      return c.json({ error: 'Missing pending_action_id' }, 400)
    }

    await cancelPendingAction(pending_action_id)

    return c.json({
      status: 'success',
      message: 'Acción cancelada. No se ha guardado nada.',
    })
  } catch (err) {
    console.error('[Agent/Cancel] Error:', err)
    return c.json({ error: 'Cancel error' }, 500)
  }
})

// ─── Context for LLM ──────────────────────────────────────────────────────────

async function getDashboardContext(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    const [{ data: invoices }, { data: txns }] = await Promise.all([
      supabase.from('invoices').select('total, status, due_date'),
      supabase.from('transactions').select('amount, type').gte('created_at', startOfMonth),
    ])

    let pendingAmount = 0, pendingCount = 0, overdueAmount = 0, overdueCount = 0
    for (const inv of invoices || []) {
      if (['sent', 'pending'].includes(inv.status)) {
        pendingAmount += inv.total || 0
        pendingCount++
        if (inv.due_date && new Date(inv.due_date) < now) {
          overdueAmount += inv.total || 0
          overdueCount++
        }
      }
    }

    let income = 0, expenses = 0
    for (const t of txns || []) {
      if (t.type === 'income') income += t.amount || 0
      else if (t.type === 'expense') expenses += t.amount || 0
    }

    return [
      `- Ingresos mes actual: €${income.toFixed(2)}`,
      `- Gastos mes actual: €${expenses.toFixed(2)}`,
      `- Balance: €${(income - expenses).toFixed(2)}`,
      `- Pendiente de cobro: €${pendingAmount.toFixed(2)} (${pendingCount} facturas)`,
      `- Vencido sin cobrar: €${overdueAmount.toFixed(2)} (${overdueCount} facturas)`,
    ].join('\n')
  } catch {
    return 'Datos no disponibles en este momento'
  }
}

// ─── L0 Read responses ────────────────────────────────────────────────────────

async function generateL0ReadResponse(parsed: ReturnType<typeof parseUserInput>): Promise<string> {
  const { intent } = parsed

  switch (intent) {
    case 'query_balance':   return fetchBalance()
    case 'query_debtors':   return fetchPending()
    case 'query_overdue':   return fetchOverdue()
    case 'query_who_owes':  return fetchWhoOwes()
    case 'query_income':    return fetchIncome()
    case 'query_expense':   return fetchExpenses()
    case 'unclear':
    case 'unclear_query':
    default:
      return [
        'Puedo ayudarte con:',
        '• *"gasté 45€ en material hoy"* → registra el gasto (con confirmación)',
        '• *"cobré 300€ de Ana por corte"* → registra el ingreso (con confirmación)',
        '• *"¿cuánto tengo?"* → balance del mes',
        '• *"¿cuánto me deben?"* → cobros pendientes',
        '• *"¿qué está vencido?"* → facturas atrasadas',
        '• *"¿quién me debe?"* → lista de clientes',
      ].join('\n')
  }
}

async function fetchBalance(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await supabase
      .from('transactions').select('amount, type').gte('created_at', startOfMonth)

    if (!txns || txns.length === 0) return 'No hay transacciones registradas este mes.'

    let income = 0, expenses = 0
    for (const t of txns) {
      if (t.type === 'income') income += t.amount || 0
      else if (t.type === 'expense') expenses += t.amount || 0
    }
    const balance = income - expenses
    return `💰 Este mes:\n• Ingresos: €${income.toFixed(2)}\n• Gastos: €${expenses.toFixed(2)}\n• Balance: €${balance.toFixed(2)}`
  } catch {
    return 'No se pudo consultar el balance.'
  }
}

async function fetchPending(): Promise<string> {
  try {
    const supabase = getSupabase()
    const { data: invoices } = await supabase
      .from('invoices').select('total, status').in('status', ['sent', 'pending'])
    if (!invoices || invoices.length === 0) return 'No hay cobros pendientes.'
    const total = invoices.reduce((s, i) => s + (i.total || 0), 0)
    return `⏳ Pendiente de cobro:\n• Total: €${total.toFixed(2)}\n• Facturas: ${invoices.length}`
  } catch {
    return 'No se pudo consultar los cobros pendientes.'
  }
}

async function fetchOverdue(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date().toISOString()
    const { data: invoices } = await supabase
      .from('invoices').select('total, number, due_date')
      .in('status', ['sent', 'pending']).lt('due_date', now)
      .order('due_date', { ascending: true })
    if (!invoices || invoices.length === 0) return '✅ No hay facturas vencidas.'
    const total = invoices.reduce((s, i) => s + (i.total || 0), 0)
    const list = invoices.slice(0, 5).map(i => `  • ${i.number}: €${(i.total || 0).toFixed(2)}`).join('\n')
    return `🔴 Facturas vencidas:\n• Total: €${total.toFixed(2)}\n• Facturas: ${invoices.length}\n${list}`
  } catch {
    return 'No se pudo consultar las facturas vencidas.'
  }
}

async function fetchWhoOwes(): Promise<string> {
  try {
    const supabase = getSupabase()
    const { data: invoices } = await supabase
      .from('invoices').select('total, number, due_date, clients(name)')
      .in('status', ['sent', 'pending']).order('due_date', { ascending: true }).limit(8)
    if (!invoices || invoices.length === 0) return 'No hay cobros pendientes.'
    const lines = invoices.map(i => {
      const name = (i.clients as any)?.name || 'Cliente'
      const due = i.due_date ? new Date(i.due_date).toLocaleDateString('es-ES') : 'sin vencimiento'
      return `  • ${name}: €${(i.total || 0).toFixed(2)} (vence ${due})`
    })
    return `👥 Clientes que te deben:\n${lines.join('\n')}`
  } catch {
    return 'No se pudo consultar la lista de deudores.'
  }
}

async function fetchIncome(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await supabase
      .from('transactions').select('amount').eq('type', 'income').gte('created_at', startOfMonth)
    if (!txns || txns.length === 0) return 'No hay ingresos registrados este mes.'
    const total = txns.reduce((s, t) => s + (t.amount || 0), 0)
    return `📈 Ingresos este mes: €${total.toFixed(2)} (${txns.length} registros)`
  } catch {
    return 'No se pudo consultar los ingresos.'
  }
}

async function fetchExpenses(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await supabase
      .from('transactions').select('amount').eq('type', 'expense').gte('created_at', startOfMonth)
    if (!txns || txns.length === 0) return 'No hay gastos registrados este mes.'
    const total = txns.reduce((s, t) => s + (t.amount || 0), 0)
    return `📉 Gastos este mes: €${total.toFixed(2)} (${txns.length} registros)`
  } catch {
    return 'No se pudo consultar los gastos.'
  }
}

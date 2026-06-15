// @ts-nocheck
import { Hono } from 'hono'
import { parseUserInput } from '../agent/parser'
import { routeToLLM, callOpenRouter, DIABOLUS_SYSTEM_PROMPT } from '../agent/llm-router'
import { createClient } from '@supabase/supabase-js'

export const agentRoutes = new Hono()

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  return createClient(url, key)
}

// Obtener el salon_id por defecto (primer salon) — solo para fase de construcción
async function getDefaultSalonId(): Promise<string | null> {
  try {
    const supabase = getSupabase()
    const { data } = await supabase.from('salons').select('id').limit(1).single()
    return data?.id || null
  } catch {
    return null
  }
}

/**
 * Guarda una transacción en Supabase.
 * Retorna { ok: true } o { ok: false, error }
 */
export async function saveTransaction({
  amount,
  type,
  description,
  salonId,
}: {
  amount: number
  type: 'income' | 'expense'
  description: string
  salonId: string | null
}) {
  const supabase = getSupabase()
  const today = new Date().toISOString().split('T')[0]

  const { error } = await supabase.from('transactions').insert({
    amount,
    type,
    description,
    date: today,
    ...(salonId ? { salon_id: salonId } : {}),
  })

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * POST /api/agent/chat
 * Procesa input natural → L0 parser + Supabase real data
 * Solo informa para consultas; EJECUTA para ingresos/gastos
 */
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

    // Step 1: L0 Parser (deterministic, €0)
    const parsed = parseUserInput(userInput)

    // Step 2: Decide routing
    const routing = routeToLLM(
      parsed.confidence,
      userInput,
      parsed.intent === 'create_income' || parsed.intent === 'create_expense'
    )

    // Step 3: Generate response with real data
    let finalResponse: string
    if (routing.level === 'L0') {
      finalResponse = await generateL0Response(parsed)
    } else {
      try {
        const ctx = await getDashboardContext()
        const systemWithCtx = DIABOLUS_SYSTEM_PROMPT + '\n\nDatos actuales del negocio:\n' + ctx
        finalResponse = await callOpenRouter(routing.model, userInput, systemWithCtx)
      } catch (err) {
        console.warn('[LLM] Error, falling back to L0:', err)
        finalResponse = await generateL0Response(parsed)
      }
    }

    return c.json({
      status: 'success',
      message: finalResponse,
      routing: {
        level: routing.level,
        model: routing.model,
        rationale: routing.rationale,
        estimatedCost: `€${routing.estimatedCost}`
      },
      parsed: {
        intent: parsed.intent,
        confidence: parsed.confidence,
        data: parsed.data
      }
    })
  } catch (err) {
    console.error('[Agent] Error:', err)
    return c.json({ error: 'Agent error' }, 500)
  }
})

/**
 * Contexto real del negocio para inyectar al LLM
 */
async function getDashboardContext(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    const [{ data: invoices }, { data: txns }] = await Promise.all([
      supabase.from('invoices').select('total, status, due_date'),
      supabase.from('transactions').select('amount, type').gte('created_at', startOfMonth)
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
      `- Vencido sin cobrar: €${overdueAmount.toFixed(2)} (${overdueCount} facturas)`
    ].join('\n')
  } catch {
    return 'Datos no disponibles en este momento'
  }
}

/**
 * Respuestas L0 — consultas solo informan, escrituras ejecutan
 */
async function generateL0Response(parsed: ReturnType<typeof parseUserInput>): Promise<string> {
  const { intent, data } = parsed

  switch (intent) {
    case 'create_income': {
      if (!data.amount || data.amount <= 0) {
        return '¿Cuánto cobraste? Dime el importe exacto. Ej: "cobré 150€ de Juan"'
      }
      const salonId = await getDefaultSalonId()
      const description = data.clientName && data.clientName !== 'Cliente'
        ? `${data.concept} — ${data.clientName}`
        : data.concept
      const result = await saveTransaction({
        amount: data.amount,
        type: 'income',
        description,
        salonId,
      })
      if (!result.ok) {
        return `❌ No se pudo guardar el ingreso: ${result.error}`
      }
      return `✅ Ingreso guardado\n• Importe: €${data.amount.toFixed(2)}\n• Concepto: ${description}\n• Fecha: ${new Date().toLocaleDateString('es-ES')}\n\nYa está en tu balance del mes.`
    }

    case 'create_expense': {
      if (!data.amount || data.amount <= 0) {
        return '¿Cuánto gastaste? Dime el importe exacto. Ej: "gasté 80€ en materiales"'
      }
      const salonId = await getDefaultSalonId()
      const result = await saveTransaction({
        amount: data.amount,
        type: 'expense',
        description: data.concept,
        salonId,
      })
      if (!result.ok) {
        return `❌ No se pudo guardar el gasto: ${result.error}`
      }
      return `✅ Gasto guardado\n• Importe: €${data.amount.toFixed(2)}\n• Concepto: ${data.concept}\n• Fecha: ${new Date().toLocaleDateString('es-ES')}\n\nYa está en tus gastos del mes.`
    }

    case 'query_balance':
      return await fetchBalance()

    case 'query_debtors':
      return await fetchPending()

    case 'query_overdue':
      return await fetchOverdue()

    case 'query_who_owes':
      return await fetchWhoOwes()

    case 'query_income':
      return await fetchIncome()

    case 'query_expense':
      return await fetchExpenses()

    case 'unclear':
    case 'unclear_query':
    default:
      return `Puedes decirme:\n• "Cobré 300€ de Juan" → guarda ingreso\n• "Gasté 80€ en materiales" → guarda gasto\n• "¿Cuánto tengo?" → balance del mes\n• "¿Cuánto me deben?" → cobros pendientes\n• "¿Qué está vencido?" → facturas atrasadas\n• "¿Quién me debe?" → lista de clientes`
  }
}

async function fetchBalance(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    const { data: txns } = await supabase
      .from('transactions')
      .select('amount, type')
      .gte('created_at', startOfMonth)

    if (!txns || txns.length === 0) {
      return 'No hay transacciones registradas este mes.'
    }

    let income = 0, expenses = 0
    for (const t of txns) {
      if (t.type === 'income') income += t.amount || 0
      else if (t.type === 'expense') expenses += t.amount || 0
    }
    const balance = income - expenses

    return `💰 Este mes:\n• Ingresos: €${income.toFixed(2)}\n• Gastos: €${expenses.toFixed(2)}\n• Balance: €${balance.toFixed(2)}`
  } catch {
    return 'No se pudo consultar el balance. Inténtalo de nuevo.'
  }
}

async function fetchPending(): Promise<string> {
  try {
    const supabase = getSupabase()
    const { data: invoices } = await supabase
      .from('invoices')
      .select('total, status')
      .in('status', ['sent', 'pending'])

    if (!invoices || invoices.length === 0) {
      return 'No hay cobros pendientes registrados.'
    }

    const total = invoices.reduce((sum, i) => sum + (i.total || 0), 0)
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
      .from('invoices')
      .select('total, invoice_number, due_date')
      .in('status', ['sent', 'pending'])
      .lt('due_date', now)
      .order('due_date', { ascending: true })

    if (!invoices || invoices.length === 0) {
      return '✅ No hay facturas vencidas.'
    }

    const total = invoices.reduce((sum, i) => sum + (i.total || 0), 0)
    const list = invoices
      .slice(0, 5)
      .map(i => `  • ${i.invoice_number}: €${(i.total || 0).toFixed(2)}`)
      .join('\n')

    return `🔴 Facturas vencidas:\n• Total: €${total.toFixed(2)}\n• Facturas: ${invoices.length}\n${list}`
  } catch {
    return 'No se pudo consultar las facturas vencidas.'
  }
}

async function fetchWhoOwes(): Promise<string> {
  try {
    const supabase = getSupabase()

    const { data: invoices } = await supabase
      .from('invoices')
      .select('total, invoice_number, due_date, clients(name)')
      .in('status', ['sent', 'pending'])
      .order('due_date', { ascending: true })
      .limit(8)

    if (!invoices || invoices.length === 0) {
      return 'No hay cobros pendientes registrados.'
    }

    const lines = invoices.map(i => {
      const name = (i.clients as any)?.name || 'Cliente'
      const due = i.due_date
        ? new Date(i.due_date).toLocaleDateString('es-ES')
        : 'sin vencimiento'
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
      .from('transactions')
      .select('amount')
      .eq('type', 'income')
      .gte('created_at', startOfMonth)

    if (!txns || txns.length === 0) {
      return 'No hay ingresos registrados este mes.'
    }

    const total = txns.reduce((sum, t) => sum + (t.amount || 0), 0)
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
      .from('transactions')
      .select('amount')
      .eq('type', 'expense')
      .gte('created_at', startOfMonth)

    if (!txns || txns.length === 0) {
      return 'No hay gastos registrados este mes.'
    }

    const total = txns.reduce((sum, t) => sum + (t.amount || 0), 0)
    return `📉 Gastos este mes: €${total.toFixed(2)} (${txns.length} registros)`
  } catch {
    return 'No se pudo consultar los gastos.'
  }
}

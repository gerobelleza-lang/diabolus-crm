// @ts-nocheck
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }

export const dashboardRoutes = new Hono<{ Variables: Variables }>()

// GET /api/dashboard/stats
// Responde las 5 preguntas clave: cuánto hay, qué falta cobrar, qué hay que pagar, qué riesgo hay, qué acción tomar
dashboardRoutes.get('/stats', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const now = new Date()
  const nowISO = now.toISOString()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const [
    todayRes,
    weekRes,
    monthRes,
    clientCountRes,
    pendingInvoicesRes,
    overdueInvoicesRes,
  ] = await Promise.all([
    supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', todayStart),
    supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', weekAgo),
    supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', monthStart),
    supabase.from('clients').select('id', { count: 'exact', head: true }).eq('salon_id', salonId),
    // Facturas enviadas o pendientes (no cobradas)
    supabase
      .from('invoices')
      .select('total')
      .eq('salon_id', salonId)
      .in('status', ['sent', 'pending']),
    // Facturas vencidas (due_date pasada, no pagadas ni canceladas)
    supabase
      .from('invoices')
      .select('total')
      .eq('salon_id', salonId)
      .not('status', 'in', '(paid,cancelled,draft)')
      .lt('due_date', nowISO),
  ])

  const sumType = (rows: { amount: number; type: string }[] | null, type: string) =>
    (rows ?? []).filter((r) => r.type === type).reduce((acc, r) => acc + Number(r.amount), 0)

  const sumTotal = (rows: { total: number }[] | null) =>
    (rows ?? []).reduce((acc, r) => acc + Number(r.total), 0)

  const monthIncome = sumType(monthRes.data, 'income')
  const monthExpenses = sumType(monthRes.data, 'expense')

  const pendingAmount = sumTotal(pendingInvoicesRes.data)
  const pendingCount = (pendingInvoicesRes.data ?? []).length

  const overdueAmount = sumTotal(overdueInvoicesRes.data)
  const overdueCount = (overdueInvoicesRes.data ?? []).length

  return c.json({
    // Tesorería actual
    today: sumType(todayRes.data, 'income'),
    week: sumType(weekRes.data, 'income'),
    month: monthIncome,
    expenses: monthExpenses,
    balance: monthIncome - monthExpenses,
    // Clientes
    totalClients: clientCountRes.count ?? 0,
    // Cobros pendientes — lo que falta por ingresar
    pending_amount: pendingAmount,
    pending_count: pendingCount,
    // Vencidas — riesgo activo
    overdue_amount: overdueAmount,
    overdue_count: overdueCount,
  })
})

// GET /api/dashboard/cobros
// Lista detallada de facturas pendientes de cobro (enviadas + vencidas)
// Útil para el bot Telegram /cobros y la bandeja de acción
dashboardRoutes.get('/cobros', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('invoices')
    .select('id, invoice_number, total, status, due_date, created_at, clients(name, phone)')
    .eq('salon_id', salonId)
    .not('status', 'in', '(paid,cancelled,draft)')
    .order('due_date', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)

  const enriched = (data ?? []).map((inv) => ({
    ...inv,
    is_overdue: inv.due_date ? inv.due_date < now : false,
    days_overdue: inv.due_date
      ? Math.max(0, Math.floor((Date.now() - new Date(inv.due_date).getTime()) / (1000 * 60 * 60 * 24)))
      : 0,
  }))

  const total_pending = enriched.reduce((acc, inv) => acc + Number(inv.total), 0)
  const overdue = enriched.filter((inv) => inv.is_overdue)
  const total_overdue = overdue.reduce((acc, inv) => acc + Number(inv.total), 0)

  return c.json({
    summary: {
      total_pending,
      total_overdue,
      count: enriched.length,
      overdue_count: overdue.length,
    },
    invoices: enriched,
  })
})

// GET /api/dashboard/recent-transactions
dashboardRoutes.get('/recent-transactions', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('transactions')
    .select('*, clients(name)')
    .eq('salon_id', salonId)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ transactions: data })
})

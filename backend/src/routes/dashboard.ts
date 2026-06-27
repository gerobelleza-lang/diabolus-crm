import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }

export const dashboardRoutes = new Hono<{ Variables: Variables }>()

// GET /api/dashboard/stats
dashboardRoutes.get('/stats', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const now = new Date()
  const nowISO = now.toISOString()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const [todayRes, weekRes, monthRes, clientCountRes, pendingInvoicesRes, overdueInvoicesRes] = await Promise.all([
    supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', todayStart),
    supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', weekAgo),
    supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', monthStart),
    supabase.from('clients').select('id', { count: 'exact', head: true }).eq('salon_id', salonId),
    supabase.from('invoices').select('total').eq('salon_id', salonId).in('status', ['sent', 'pending']),
    supabase.from('invoices').select('total').eq('salon_id', salonId).not('status', 'in', '(paid,cancelled,draft)').lt('due_date', nowISO),
  ])

  const sumType = (rows, type) => (rows ?? []).filter(r => r.type === type).reduce((acc, r) => acc + Number(r.amount), 0)
  const sumTotal = (rows) => (rows ?? []).reduce((acc, r) => acc + Number(r.total), 0)

  const monthIncome = sumType(monthRes.data, 'income')
  const monthExpenses = sumType(monthRes.data, 'expense')
  const pendingAmount = sumTotal(pendingInvoicesRes.data)
  const pendingCount = (pendingInvoicesRes.data ?? []).length
  const overdueAmount = sumTotal(overdueInvoicesRes.data)
  const overdueCount = (overdueInvoicesRes.data ?? []).length

  return c.json({
    today: sumType(todayRes.data, 'income'),
    week: sumType(weekRes.data, 'income'),
    month: monthIncome,
    expenses: monthExpenses,
    balance: monthIncome - monthExpenses,
    totalClients: clientCountRes.count ?? 0,
    pending_amount: pendingAmount,
    pending_count: pendingCount,
    overdue_amount: overdueAmount,
    overdue_count: overdueCount,
  })
})

// GET /api/dashboard/cobros
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

  const enriched = (data ?? []).map(inv => ({
    ...inv,
    is_overdue: inv.due_date ? inv.due_date < now : false,
    days_overdue: inv.due_date ? Math.max(0, Math.floor((Date.now() - new Date(inv.due_date).getTime()) / (1000 * 60 * 60 * 24))) : 0,
  }))

  const total_pending = enriched.reduce((acc, inv) => acc + Number(inv.total), 0)
  const overdue = enriched.filter(inv => inv.is_overdue)
  const total_overdue = overdue.reduce((acc, inv) => acc + Number(inv.total), 0)

  return c.json({
    summary: { total_pending, total_overdue, count: enriched.length, overdue_count: overdue.length },
    invoices: enriched,
  })
})

// GET /api/dashboard/recent-transactions
dashboardRoutes.get('/recent-transactions', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('transactions').select('*, clients(name)').eq('salon_id', salonId)
    .order('created_at', { ascending: false }).limit(10)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ transactions: data })
})

// GET /api/dashboard/forecast
// Proyección de tesorería a 30 días basada en media histórica + facturas pendientes
dashboardRoutes.get('/forecast', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const now = new Date()
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const thirtyDaysAhead = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  const [txnRes, pendingRes] = await Promise.all([
    supabase.from('transactions').select('amount, type, created_at').eq('salon_id', salonId).gte('created_at', sixtyDaysAgo),
    supabase.from('invoices').select('total, due_date, invoice_number, clients(name)').eq('salon_id', salonId).not('status', 'in', '(paid,cancelled,draft)').lte('due_date', thirtyDaysAhead).gte('due_date', now.toISOString()),
  ])

  const txns = txnRes.data ?? []
  const pending = pendingRes.data ?? []

  const days60 = 60
  const totalIncome  = txns.filter(t => t.type === 'income').reduce((a, t) => a + Number(t.amount), 0)
  const totalExpense = txns.filter(t => t.type === 'expense').reduce((a, t) => a + Number(t.amount), 0)
  const dailyIncome  = totalIncome  / days60
  const dailyExpense = totalExpense / days60

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const monthTxns = txns.filter(t => t.created_at >= monthStart)
  const currentBalance = monthTxns.filter(t => t.type === 'income').reduce((a, t) => a + Number(t.amount), 0)
                       - monthTxns.filter(t => t.type === 'expense').reduce((a, t) => a + Number(t.amount), 0)

  const expectedByDay = {}
  for (const inv of pending) {
    if (!inv.due_date) continue
    const dk = inv.due_date.slice(0, 10)
    expectedByDay[dk] = (expectedByDay[dk] || 0) + Number(inv.total)
  }

  const projection = []
  let runningBalance = currentBalance
  for (let i = 1; i <= 30; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    const dk = d.toISOString().slice(0, 10)
    const expected = expectedByDay[dk] || 0
    runningBalance += dailyIncome + expected - dailyExpense
    projection.push({
      date: dk,
      balance: Math.round(runningBalance * 100) / 100,
      expected_income: Math.round((dailyIncome + expected) * 100) / 100,
      expected_expense: Math.round(dailyExpense * 100) / 100,
      invoices_due: expected > 0 ? pending.filter(inv => (inv.due_date || '').slice(0,10) === dk).map(inv => ({ total: Number(inv.total), invoice_number: inv.invoice_number, client: inv.clients?.name || '' })) : [],
    })
  }

  return c.json({
    current_balance: Math.round(currentBalance * 100) / 100,
    daily_avg_income:  Math.round(dailyIncome  * 100) / 100,
    daily_avg_expense: Math.round(dailyExpense * 100) / 100,
    pending_invoices_30d: pending.length,
    pending_amount_30d: Math.round(pending.reduce((a, inv) => a + Number(inv.total), 0) * 100) / 100,
    projected_balance_30d: projection.length ? projection[projection.length - 1].balance : currentBalance,
    projection,
  })
})

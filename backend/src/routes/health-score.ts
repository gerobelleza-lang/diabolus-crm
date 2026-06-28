import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }

// ── Health Score Algorithm ──
// 5 components, max 100 points total
// 1. Cash Flow Ratio (25 pts) — income vs expenses this month
// 2. Overdue Risk (25 pts) — overdue invoices ratio
// 3. Pending Collections (20 pts) — pending amount vs monthly income
// 4. Financial Cushion (15 pts) — balance coverage in months
// 5. Revenue Trend (15 pts) — this month vs last month

interface ScoreComponent {
  name: string
  score: number
  max: number
  label: string
  status: 'critical' | 'warning' | 'good' | 'excellent'
}

function calcCashFlow(income: number, expenses: number): ScoreComponent {
  let score = 0
  if (expenses === 0 && income > 0) score = 25
  else if (expenses === 0 && income === 0) score = 12
  else {
    const ratio = income / expenses
    if (ratio >= 2) score = 25
    else if (ratio >= 1.5) score = 22
    else if (ratio >= 1.2) score = 18
    else if (ratio >= 1) score = 14
    else if (ratio >= 0.8) score = 8
    else if (ratio >= 0.5) score = 4
    else score = 0
  }
  const status = score >= 20 ? 'excellent' : score >= 14 ? 'good' : score >= 8 ? 'warning' : 'critical'
  return { name: 'cash_flow', score, max: 25, label: 'Flujo de caja', status }
}

function calcOverdueRisk(overdueCount: number, totalPendingCount: number, overdueAmount: number): ScoreComponent {
  let score = 25
  if (overdueCount === 0) score = 25
  else if (totalPendingCount > 0) {
    const ratio = overdueCount / totalPendingCount
    if (ratio < 0.1) score = 22
    else if (ratio < 0.25) score = 17
    else if (ratio < 0.5) score = 12
    else if (ratio < 0.75) score = 6
    else score = 2
  }
  // Extra penalty for high overdue amounts
  if (overdueAmount > 5000) score = Math.max(0, score - 5)
  else if (overdueAmount > 2000) score = Math.max(0, score - 3)

  const status = score >= 20 ? 'excellent' : score >= 14 ? 'good' : score >= 8 ? 'warning' : 'critical'
  return { name: 'overdue_risk', score, max: 25, label: 'Riesgo vencidas', status }
}

function calcPendingCollections(pendingAmount: number, monthlyIncome: number): ScoreComponent {
  let score = 20
  if (monthlyIncome === 0 && pendingAmount === 0) score = 15
  else if (monthlyIncome === 0 && pendingAmount > 0) score = 2
  else {
    const ratio = pendingAmount / monthlyIncome
    if (ratio < 0.1) score = 20
    else if (ratio < 0.25) score = 17
    else if (ratio < 0.5) score = 13
    else if (ratio < 1) score = 9
    else if (ratio < 1.5) score = 5
    else score = 2
  }
  const status = score >= 16 ? 'excellent' : score >= 11 ? 'good' : score >= 6 ? 'warning' : 'critical'
  return { name: 'pending_collections', score, max: 20, label: 'Cobros pendientes', status }
}

function calcFinancialCushion(balance: number, monthlyExpenses: number): ScoreComponent {
  let score = 0
  if (monthlyExpenses === 0 && balance >= 0) score = 12
  else if (monthlyExpenses === 0) score = 0
  else {
    const months = balance / monthlyExpenses
    if (months >= 3) score = 15
    else if (months >= 2) score = 13
    else if (months >= 1) score = 10
    else if (months >= 0.5) score = 7
    else if (months > 0) score = 4
    else score = 0
  }
  const status = score >= 12 ? 'excellent' : score >= 8 ? 'good' : score >= 4 ? 'warning' : 'critical'
  return { name: 'financial_cushion', score, max: 15, label: 'Colchón financiero', status }
}

function calcRevenueTrend(thisMonthIncome: number, lastMonthIncome: number): ScoreComponent {
  let score = 10
  if (lastMonthIncome === 0 && thisMonthIncome > 0) score = 15
  else if (lastMonthIncome === 0 && thisMonthIncome === 0) score = 8
  else {
    const growth = (thisMonthIncome - lastMonthIncome) / lastMonthIncome
    if (growth >= 0.2) score = 15
    else if (growth >= 0.1) score = 13
    else if (growth >= 0) score = 10
    else if (growth >= -0.1) score = 7
    else if (growth >= -0.25) score = 4
    else score = 1
  }
  const status = score >= 12 ? 'excellent' : score >= 8 ? 'good' : score >= 5 ? 'warning' : 'critical'
  return { name: 'revenue_trend', score, max: 15, label: 'Tendencia ingresos', status }
}

function getOverallStatus(total: number): string {
  if (total >= 80) return 'Tu negocio está en excelente forma financiera'
  if (total >= 60) return 'Buena salud financiera con margen de mejora'
  if (total >= 40) return 'Atención: revisa cobros pendientes y gastos'
  if (total >= 20) return 'Alerta: necesitas actuar sobre tu tesorería'
  return 'Situación crítica: actúa de inmediato'
}

function getOverallGrade(total: number): string {
  if (total >= 90) return 'A+'
  if (total >= 80) return 'A'
  if (total >= 70) return 'B+'
  if (total >= 60) return 'B'
  if (total >= 50) return 'C'
  if (total >= 40) return 'D'
  return 'F'
}

export const healthScoreRoutes = new Hono<{ Variables: Variables }>()

healthScoreRoutes.get('/', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString()
  const nowISO = now.toISOString()

  const [thisMonthTxns, lastMonthTxns, pendingInvoices, overdueInvoices] = await Promise.all([
    supabase
      .from('transactions')
      .select('amount, type')
      .eq('salon_id', salonId)
      .gte('created_at', monthStart) as any,
    supabase
      .from('transactions')
      .select('amount, type')
      .eq('salon_id', salonId)
      .gte('created_at', lastMonthStart)
      .lte('created_at', lastMonthEnd) as any,
    supabase
      .from('invoices')
      .select('total')
      .eq('salon_id', salonId)
      .in('status', ['sent', 'pending']) as any,
    supabase
      .from('invoices')
      .select('total')
      .eq('salon_id', salonId)
      .not('status', 'in', '(paid,cancelled,draft)')
      .lt('due_date', nowISO) as any,
  ])

  const sumByType = (rows: any[], type: string) =>
    (rows ?? []).filter((r: any) => r.type === type).reduce((acc: number, r: any) => acc + Number(r.amount), 0)
  const sumTotal = (rows: any[]) =>
    (rows ?? []).reduce((acc: number, r: any) => acc + Number(r.total), 0)

  const thisIncome = sumByType(thisMonthTxns.data, 'income')
  const thisExpenses = sumByType(thisMonthTxns.data, 'expense')
  const lastIncome = sumByType(lastMonthTxns.data, 'income')
  const balance = thisIncome - thisExpenses
  const pendingAmount = sumTotal(pendingInvoices.data)
  const pendingCount = (pendingInvoices.data ?? []).length
  const overdueAmount = sumTotal(overdueInvoices.data)
  const overdueCount = (overdueInvoices.data ?? []).length

  const components: ScoreComponent[] = [
    calcCashFlow(thisIncome, thisExpenses),
    calcOverdueRisk(overdueCount, pendingCount, overdueAmount),
    calcPendingCollections(pendingAmount, thisIncome),
    calcFinancialCushion(balance, thisExpenses),
    calcRevenueTrend(thisIncome, lastIncome),
  ]

  const total = components.reduce((acc, comp) => acc + comp.score, 0)

  return c.json({
    score: total,
    grade: getOverallGrade(total),
    message: getOverallStatus(total),
    components,
    data: {
      this_month_income: Math.round(thisIncome * 100) / 100,
      this_month_expenses: Math.round(thisExpenses * 100) / 100,
      last_month_income: Math.round(lastIncome * 100) / 100,
      balance: Math.round(balance * 100) / 100,
      pending_amount: Math.round(pendingAmount * 100) / 100,
      pending_count: pendingCount,
      overdue_amount: Math.round(overdueAmount * 100) / 100,
      overdue_count: overdueCount,
    },
    calculated_at: now.toISOString(),
  })
})

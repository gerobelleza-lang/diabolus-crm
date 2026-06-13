import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }

export const dashboardRoutes = new Hono<{ Variables: Variables }>()

// GET /api/dashboard/stats
dashboardRoutes.get('/stats', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const [todayRes, weekRes, monthRes, clientCountRes] = await Promise.all([
    supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', todayStart),
    supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', weekAgo),
    supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', monthStart),
    supabase.from('clients').select('id', { count: 'exact', head: true }).eq('salon_id', salonId),
  ])

  const sumType = (rows: { amount: number; type: string }[] | null, type: string) =>
    (rows ?? []).filter((r) => r.type === type).reduce((acc, r) => acc + Number(r.amount), 0)

  const monthIncome = sumType(monthRes.data, 'income')
  const monthExpenses = sumType(monthRes.data, 'expense')

  return c.json({
    today: sumType(todayRes.data, 'income'),
    week: sumType(weekRes.data, 'income'),
    month: monthIncome,
    expenses: monthExpenses,
    balance: monthIncome - monthExpenses,
    totalClients: clientCountRes.count ?? 0,
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

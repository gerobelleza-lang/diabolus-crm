// @ts-nocheck
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { SignJWT, jwtVerify } from 'jose'

export const gestorPublicRoutes = new Hono()
export const gestorRoutes = new Hono()

const JWT_SECRET = new TextEncoder().encode(
  Deno?.env?.get?.('JWT_SECRET') ?? process.env.JWT_SECRET ?? ''
)

// ─── POST /api/gestor/link ─────────────────────────────────────────────────
// Genera un enlace de solo lectura válido 30 días para el gestor
gestorRoutes.post('/link', async (c) => {
  const salonId = c.get('salon_id')
  if (!salonId) return c.json({ error: 'No salon_id in token' }, 401)

  const supabase = getSupabaseAdmin()

  // Obtener nombre del salon
  const { data: salon } = await supabase
    .from('salons')
    .select('name')
    .eq('id', salonId)
    .single()

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const token = await new SignJWT({
    role: 'gestor',
    salon_id: salonId,
    salon_name: salon?.name ?? 'Mi negocio',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(JWT_SECRET)

  const baseUrl = c.req.url.includes('localhost')
    ? 'http://localhost:5500'
    : 'https://gerobelleza-lang.github.io/diabolus-crm'

  return c.json({
    ok: true,
    token,
    url: `${baseUrl}/gestor.html?token=${token}`,
    expires_at: expiresAt.toISOString(),
    salon_name: salon?.name ?? 'Mi negocio',
  })
})

// ─── GET /gestor/report ───────────────────────────────────────────────────
// Ruta pública — el gestor accede con ?token=xxx
gestorPublicRoutes.get('/report', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'Token requerido' }, 401)

  let payload: any
  try {
    const { payload: p } = await jwtVerify(token, JWT_SECRET)
    payload = p
  } catch (e) {
    return c.json({ error: 'Token inválido o expirado' }, 401)
  }

  if (payload.role !== 'gestor') {
    return c.json({ error: 'Token no válido para este acceso' }, 403)
  }

  const salonId = payload.salon_id as string
  const supabase = getSupabaseAdmin()

  // Determinar trimestre actual
  const now = new Date()
  const year = now.getFullYear()
  const quarter = Math.ceil((now.getMonth() + 1) / 3)
  const quarterStart = new Date(year, (quarter - 1) * 3, 1)
  const quarterEnd = new Date(year, quarter * 3, 0, 23, 59, 59)

  // Paralelo: salon + transactions + invoices
  const [salonRes, transRes, invoiceRes] = await Promise.all([
    supabase.from('salons').select('name').eq('id', salonId).single(),
    supabase
      .from('transactions')
      .select('*')
      .eq('salon_id', salonId)
      .gte('date', quarterStart.toISOString())
      .lte('date', quarterEnd.toISOString())
      .order('date', { ascending: false }),
    supabase
      .from('invoices')
      .select('*, clients(name, email)')
      .eq('salon_id', salonId)
      .gte('issue_date', quarterStart.toISOString().split('T')[0])
      .lte('issue_date', quarterEnd.toISOString().split('T')[0])
      .order('issue_date', { ascending: false }),
  ])

  const transactions = transRes.data ?? []
  const invoices = invoiceRes.data ?? []

  // Cálculos
  const income = transactions
    .filter((t) => t.type === 'income')
    .reduce((s, t) => s + (t.amount || 0), 0)
  const expenses = transactions
    .filter((t) => t.type === 'expense')
    .reduce((s, t) => s + (t.amount || 0), 0)
  const netProfit = income - expenses

  const invoicedTotal = invoices.reduce((s, i) => s + (i.total || 0), 0)
  const paidInvoices = invoices.filter((i) => i.status === 'paid')
  const pendingInvoices = invoices.filter((i) => i.status === 'pending')
  const overdueInvoices = invoices.filter((i) => i.status === 'overdue')

  // Estimaciones fiscales
  const ivaRepercutido = income * 0.21
  const ivaSoportado = expenses * 0.21
  const ivaLiquidar = ivaRepercutido - ivaSoportado
  const irpfFraccionado = Math.max(0, netProfit * 0.2)

  return c.json({
    ok: true,
    salon: salonRes.data?.name ?? 'Mi negocio',
    period: {
      year,
      quarter,
      label: `T${quarter} ${year}`,
      from: quarterStart.toISOString().split('T')[0],
      to: quarterEnd.toISOString().split('T')[0],
    },
    summary: {
      income: Math.round(income * 100) / 100,
      expenses: Math.round(expenses * 100) / 100,
      net_profit: Math.round(netProfit * 100) / 100,
    },
    fiscal: {
      iva_repercutido: Math.round(ivaRepercutido * 100) / 100,
      iva_soportado: Math.round(ivaSoportado * 100) / 100,
      iva_a_liquidar: Math.round(ivaLiquidar * 100) / 100,
      irpf_fraccionado: Math.round(irpfFraccionado * 100) / 100,
      modelo: 'Mod. 303 (IVA) + Mod. 130 (IRPF)',
    },
    invoices: {
      total: invoices.length,
      paid: paidInvoices.length,
      pending: pendingInvoices.length,
      overdue: overdueInvoices.length,
      total_amount: Math.round(invoicedTotal * 100) / 100,
      list: invoices.map((i) => ({
        number: i.invoice_number,
        client: i.clients?.name ?? 'Cliente',
        date: i.issue_date,
        due_date: i.due_date,
        total: i.total,
        status: i.status,
      })),
    },
    transactions: transactions.map((t) => ({
      date: t.date,
      type: t.type,
      description: t.description,
      amount: t.amount,
    })),
    generated_at: new Date().toISOString(),
    note: 'Documento generado automáticamente por Diabolus CRM. Solo lectura.',
  })
})

/**
 * closings.ts — Bloque B2: Entrega mensual al gestor
 *
 * closingInternalRoutes → /api/internal/closings
 *   POST /run   — N8N llama esto el día configurado (x-internal-key requerido)
 *
 * closingReviewRoutes  → /closing
 *   GET  /review/:token          — cliente ve el cierre antes de aprobar (público)
 *   POST /review/:token/approve  — cliente aprueba → se envía al gestor
 *
 * closingGestorRoutes  → /gestor/closings
 *   GET  /          — historial de cierres (JWT gestor)
 *   GET  /:id       — detalle de un cierre (JWT gestor)
 *
 * Reglas de producto:
 *  - Periodo = mes ANTERIOR (no el corriente)
 *  - Solo datos confirmados: transacciones OK, facturas NO-draft
 *  - Sin IVA estimado (nunca al gestor)
 *  - Idempotencia: no re-envía si ya existe cierre no-failed para ese mes
 *  - Sin movimientos → email "sin movimientos", nunca silencio
 */

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { jwtVerify } from 'jose'
import {
  sendMonthlyClosingEmail,
  sendClosingReviewRequestEmail,
} from '../integrations/email'

export const closingInternalRoutes = new Hono()
export const closingReviewRoutes = new Hono()
export const closingGestorRoutes = new Hono()

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? ''
)

const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_ES = [
  'enero','febrero','marzo','abril','mayo','junio',
  'julio','agosto','septiembre','octubre','noviembre','diciembre',
]

function prevMonth(y: number, m: number) {
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 }
}

function periodLabel(y: number, m: number) { return `${MONTH_ES[m - 1]} ${y}` }

function isoDate(y: number, m: number, day: number) {
  return `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`
}

function lastDayOfMonth(y: number, m: number) {
  return new Date(y, m, 0).getDate()
}

function reviewToken() {
  const a = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(a).map(b => b.toString(16).padStart(2,'0')).join('')
}

async function getGestor(c: any) {
  const auth = c.req.header('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return null
  try {
    const { payload } = await jwtVerify(auth.slice(7), JWT_SECRET)
    if (payload.role !== 'gestor_account') return null
    return { gestorId: payload.gestorId as string, email: payload.email as string, name: payload.name as string }
  } catch { return null }
}

// ─── Construye el snapshot de cierre ──────────────────────────────────────────

async function buildSnapshot(supabase: any, salonId: string, year: number, month: number) {
  const dateFrom = isoDate(year, month, 1)
  const dateTo   = isoDate(year, month, lastDayOfMonth(year, month))

  const [salonR, txR, invR] = await Promise.all([
    supabase.from('salons').select('name').eq('id', salonId).single(),
    supabase.from('transactions')
      .select('id, type, amount, description, category, date')
      .eq('salon_id', salonId)
      .gte('date', dateFrom)
      .lte('date', dateTo + 'T23:59:59')
      .order('date', { ascending: false }),
    supabase.from('invoices')
      .select('id, number, total, status, issue_date, clients(name)')
      .eq('salon_id', salonId)
      .neq('status', 'draft')           // solo confirmadas — no borradores
      .gte('issue_date', dateFrom)
      .lte('issue_date', dateTo)
      .order('issue_date', { ascending: false }),
  ])

  const txs  = txR.data ?? []
  const invs = invR.data ?? []
  const income   = txs.filter(t => t.type === 'income')
  const expenses = txs.filter(t => t.type === 'expense')

  const totalIncome   = income.reduce((s, t) => s + (t.amount || 0), 0)
  const totalExpenses = expenses.reduce((s, t) => s + (t.amount || 0), 0)

  // Gastos agrupados por categoría (más útil para el gestor)
  const byCat: Record<string, number> = {}
  for (const t of expenses) {
    const cat = t.category || 'otros'
    byCat[cat] = (byCat[cat] || 0) + (t.amount || 0)
  }

  return {
    salon_name: salonR.data?.name ?? 'Negocio',
    period: { year, month, label: periodLabel(year, month), from: dateFrom, to: dateTo },
    has_movements: txs.length > 0 || invs.length > 0,
    summary: {
      income:   Math.round(totalIncome   * 100) / 100,
      expenses: Math.round(totalExpenses * 100) / 100,
      saldo:    Math.round((totalIncome - totalExpenses) * 100) / 100,
    },
    expenses_by_category: Object.entries(byCat)
      .map(([category, amount]) => ({ category, amount: Math.round((amount as number) * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount),
    income_details: income.slice(0, 50).map(t => ({
      description: t.description, amount: t.amount, date: t.date, category: t.category,
    })),
    invoices: {
      total:           invs.length,
      paid:            invs.filter(i => i.status === 'paid').length,
      pending:         invs.filter(i => i.status === 'pending').length,
      overdue:         invs.filter(i => i.status === 'overdue').length,
      total_invoiced:  Math.round(invs.reduce((s, i) => s + (i.total || 0), 0) * 100) / 100,
      list: invs.map(i => ({
        number: i.number,
        client: (i.clients as any)?.name ?? '—',
        total:  i.total,
        status: i.status,
        issue_date: i.issue_date,
      })),
    },
    // ⚠️ NO hay sección IVA — nunca se muestra al gestor (decisión de producto)
  }
}

// ─── POST /api/internal/closings/run ─────────────────────────────────────────
// N8N llama esto el día 1 (o el send_day configurado) a las 09:00 Europe/Madrid
// Autenticación: x-internal-key = SUPABASE_SERVICE_ROLE_KEY

closingInternalRoutes.post('/run', async (c) => {
  const key = c.req.header('x-internal-key') ?? ''
  if (!SUPABASE_SERVICE_ROLE || key !== SUPABASE_SERVICE_ROLE) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json().catch(() => ({}))
  const force = body.force === true   // ignorar send_day, procesar todos los activos

  // Periodo objetivo = mes ANTERIOR (a menos que se especifique explícitamente)
  const now = new Date()
  const madridNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }))
  const todayDay  = madridNow.getDate()
  const curYear   = madridNow.getFullYear()
  const curMonth  = madridNow.getMonth() + 1

  // Si se pasan year+month en el body → override (para pruebas / reenvíos)
  const { year, month } = (body.year && body.month)
    ? { year: Number(body.year), month: Number(body.month) }
    : prevMonth(curYear, curMonth)

  const supabase = getSupabaseAdmin()

  // Links activos con su configuración
  const { data: links, error: linkErr } = await supabase
    .from('gestor_salon_links')
    .select('id, salon_id, gestor_id, send_day, require_review, invited_email, gestores(id, name, email)')
    .eq('status', 'active')

  if (linkErr || !links) {
    return c.json({ error: 'Error leyendo links', detail: linkErr?.message }, 500)
  }

  // Filtrar por send_day si no es force
  const eligible = force ? links : links.filter(l => (l.send_day ?? 1) === todayDay)

  if (eligible.length === 0) {
    return c.json({ ok: true, message: `Día ${todayDay}: ningún cierre programado`, sent: 0, skipped: 0 })
  }

  let sent = 0, skipped = 0
  const errors: string[] = []

  for (const link of eligible) {
    try {
      // ── Idempotencia ──────────────────────────────────────────────────────
      const { data: existing } = await supabase
        .from('monthly_closings')
        .select('id, status')
        .eq('salon_id',   link.salon_id)
        .eq('gestor_id',  link.gestor_id)
        .eq('period_year',  year)
        .eq('period_month', month)
        .maybeSingle()

      if (existing && existing.status !== 'failed') { skipped++; continue }

      // ── Construir snapshot ────────────────────────────────────────────────
      const snap     = await buildSnapshot(supabase, link.salon_id, year, month)
      const gestor   = link.gestores as any
      const gestorEmail = gestor?.email ?? null
      const gestorName  = gestor?.name  ?? 'Tu gestor'

      // Email del cliente = el que fue invitado (campo en el link)
      const clientEmail = link.invited_email ?? null

      if (!snap.has_movements) {
        // Sin movimientos → registrar + email al gestor igualmente
        const { data: cl } = await supabase.from('monthly_closings')
          .insert([{
            salon_id: link.salon_id, gestor_id: link.gestor_id,
            period_year: year, period_month: month,
            status: 'no_movements', data: snap,
            salon_name: snap.salon_name, gestor_email: gestorEmail,
            sent_at: new Date().toISOString(),
          }])
          .select('id').single()

        if (gestorEmail) {
          await sendMonthlyClosingEmail(gestorEmail, gestorName, snap, cl?.id ?? null)
        }
        sent++

      } else if (link.require_review) {
        // Modo revisión → enviar al cliente para que apruebe antes
        const rToken   = reviewToken()
        const rExpires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()

        await supabase.from('monthly_closings').insert([{
          salon_id: link.salon_id, gestor_id: link.gestor_id,
          period_year: year, period_month: month,
          status: 'pending_review', data: snap,
          review_token: rToken, review_expires_at: rExpires,
          salon_name: snap.salon_name, gestor_email: gestorEmail,
        }])

        if (clientEmail) {
          const reviewUrl =
            `https://gerobelleza-lang.github.io/diabolus-crm/closing-review.html?token=${rToken}`
          await sendClosingReviewRequestEmail(
            clientEmail, snap.salon_name, gestorName, snap.period.label, reviewUrl
          )
        }
        sent++

      } else {
        // Modo automático → registrar y enviar directamente al gestor
        const { data: cl } = await supabase.from('monthly_closings')
          .insert([{
            salon_id: link.salon_id, gestor_id: link.gestor_id,
            period_year: year, period_month: month,
            status: 'sent', data: snap,
            salon_name: snap.salon_name, gestor_email: gestorEmail,
            sent_at: new Date().toISOString(),
          }])
          .select('id').single()

        if (gestorEmail) {
          await sendMonthlyClosingEmail(gestorEmail, gestorName, snap, cl?.id ?? null)
        }
        sent++
      }

      await supabase.from('audit_log').insert([{
        salon_id: link.salon_id,
        action: 'monthly_closing_generated',
        changes: { period_year: year, period_month: month, gestor_id: link.gestor_id, require_review: link.require_review },
        created_at: new Date().toISOString(),
      }])
    } catch (err) {
      console.error('[Closings] link', link.id, err)
      errors.push(`link ${link.id}: ${String(err)}`)
    }
  }

  return c.json({
    ok: true,
    period: `${year}-${String(month).padStart(2,'0')}`,
    sent, skipped, errors,
  })
})

// ─── GET /closing/review/:token ───────────────────────────────────────────────
// Público — el cliente consulta el cierre antes de dar el visto bueno

closingReviewRoutes.get('/review/:token', async (c) => {
  const token = c.req.param('token')
  const supabase = getSupabaseAdmin()

  const { data: cl } = await supabase
    .from('monthly_closings')
    .select('id, status, data, review_expires_at, period_year, period_month, salon_name, gestor_id, gestores(name, company_name)')
    .eq('review_token', token)
    .single()

  if (!cl) return c.json({ error: 'Cierre no encontrado' }, 404)
  if (cl.status === 'sent') return c.json({ ok: true, already_approved: true })
  if (cl.review_expires_at && new Date(cl.review_expires_at) < new Date())
    return c.json({ error: 'Enlace de revisión caducado (7 días)' }, 410)

  const gestor = cl.gestores as any
  return c.json({
    ok: true,
    closing_id: cl.id,
    status: cl.status,
    period: periodLabel(cl.period_year, cl.period_month),
    salon_name: cl.salon_name,
    gestor_name: gestor?.name ?? 'Tu gestor',
    gestor_company: gestor?.company_name ?? null,
    expires_at: cl.review_expires_at,
    data: cl.data,  // nunca incluye IVA (garantizado por buildSnapshot)
  })
})

// ─── POST /closing/review/:token/approve ─────────────────────────────────────

closingReviewRoutes.post('/review/:token/approve', async (c) => {
  const token = c.req.param('token')
  const supabase = getSupabaseAdmin()

  const { data: cl } = await supabase
    .from('monthly_closings')
    .select('id, status, data, review_expires_at, salon_id, gestor_id, salon_name, gestor_email, gestores(name)')
    .eq('review_token', token)
    .single()

  if (!cl) return c.json({ error: 'Cierre no encontrado' }, 404)
  if (cl.status === 'sent') return c.json({ ok: true, already: true, message: 'Ya aprobado' })
  if (cl.review_expires_at && new Date(cl.review_expires_at) < new Date())
    return c.json({ error: 'Enlace caducado' }, 410)

  await supabase.from('monthly_closings')
    .update({ status: 'sent', review_token: null, sent_at: new Date().toISOString() })
    .eq('id', cl.id)

  const gestorName = (cl.gestores as any)?.name ?? 'Gestor'
  if (cl.gestor_email && cl.data) {
    await sendMonthlyClosingEmail(cl.gestor_email, gestorName, cl.data as any, cl.id)
  }

  await supabase.from('audit_log').insert([{
    salon_id: cl.salon_id,
    action: 'monthly_closing_approved_by_client',
    changes: { closing_id: cl.id, gestor_id: cl.gestor_id },
    created_at: new Date().toISOString(),
  }])

  return c.json({ ok: true, message: 'Cierre aprobado. Tu gestor lo recibirá en breve.' })
})

// ─── GET /gestor/closings ─────────────────────────────────────────────────────

closingGestorRoutes.get('/', async (c) => {
  const g = await getGestor(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('monthly_closings')
    .select('id, salon_id, salon_name, period_year, period_month, status, sent_at, generated_at')
    .eq('gestor_id', g.gestorId)
    .order('generated_at', { ascending: false })
    .limit(100)

  return c.json({
    ok: true,
    closings: (data ?? []).map(cl => ({
      id:          cl.id,
      salon_id:    cl.salon_id,
      salon_name:  cl.salon_name,
      period:      periodLabel(cl.period_year, cl.period_month),
      period_year: cl.period_year,
      period_month: cl.period_month,
      status:      cl.status,
      sent_at:     cl.sent_at,
      generated_at: cl.generated_at,
    }))
  })
})

// ─── GET /gestor/closings/:id ─────────────────────────────────────────────────

closingGestorRoutes.get('/:id', async (c) => {
  const g = await getGestor(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: cl } = await supabase
    .from('monthly_closings')
    .select('*')
    .eq('id', c.req.param('id'))
    .eq('gestor_id', g.gestorId)   // aislamiento: solo sus cierres
    .single()

  if (!cl) return c.json({ error: 'Cierre no encontrado' }, 404)

  return c.json({
    ok: true,
    closing: {
      id:          cl.id,
      salon_id:    cl.salon_id,
      salon_name:  cl.salon_name,
      period:      periodLabel(cl.period_year, cl.period_month),
      period_year: cl.period_year,
      period_month: cl.period_month,
      status:      cl.status,
      sent_at:     cl.sent_at,
      generated_at: cl.generated_at,
      data:        cl.data,  // ⚠️ no contiene IVA (garantizado en buildSnapshot)
    }
  })
})

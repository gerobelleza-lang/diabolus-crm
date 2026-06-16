// @ts-nocheck
/**
 * gestor.ts — Portal del Gestor v2 (Bloque B, Rebanada B1)
 *
 * gestorPublicRoutes (montadas en /gestor/*):
 *   POST /gestor/register                  — crear cuenta de gestor
 *   POST /gestor/login                     — login → JWT de gestor
 *   GET  /gestor/me                        — perfil (JWT gestor)
 *   GET  /gestor/clients                   — lista de clientes (JWT gestor)
 *   POST /gestor/clients/invite            — invitar cliente por email (JWT gestor)
 *   PATCH /gestor/clients/:id/deactivate   — desactivar vínculo (JWT gestor)
 *   GET  /gestor/client/:salonId/report    — informe del cliente SIN IVA (JWT gestor)
 *   GET  /gestor/commissions               — comisiones devengadas (JWT gestor)
 *   GET  /gestor/invite-info               — info de invitación por token (público)
 *   POST /gestor/accept-invite             — aceptar invitación (JWT salon)
 *   GET  /gestor/report                    — legacy solo-lectura 30d (token antiguo)
 *
 * gestorRoutes (montadas en /api/gestor/* — requieren salon JWT via authMiddleware):
 *   POST /api/gestor/link                  — genera enlace 30d (legacy)
 */

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { SignJWT, jwtVerify } from 'jose'
import { sendGestorInviteEmail } from '../integrations/email'

export const gestorPublicRoutes = new Hono()
export const gestorRoutes = new Hono()

const JWT_SECRET = new TextEncoder().encode(
  Deno?.env?.get?.('JWT_SECRET') ?? process.env.JWT_SECRET ?? ''
)

const INVITE_EXPIRY_HOURS = 168 // 7 días

// ─── Password hashing (PBKDF2 — Edge Runtime compatible) ─────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, key, 256
  )
  const b64 = (a: Uint8Array) => btoa(String.fromCharCode(...a))
  return `${b64(salt)}:${b64(new Uint8Array(bits))}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [saltB64, hashB64] = stored.split(':')
    const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    )
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, key, 256
    )
    return btoa(String.fromCharCode(...new Uint8Array(bits))) === hashB64
  } catch { return false }
}

// ─── Generators ──────────────────────────────────────────────────────────────

function generateAffiliateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const arr = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(arr).map((b) => chars[b % chars.length]).join('')
}

function generateInviteToken(): string {
  const arr = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── Gestor JWT ───────────────────────────────────────────────────────────────

interface GestorPayload { gestorId: string; email: string; name: string }

async function signGestorJWT(gestorId: string, email: string, name: string): Promise<string> {
  return new SignJWT({ role: 'gestor_account', gestorId, email, name })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(JWT_SECRET)
}

async function getGestorFromRequest(c: any): Promise<GestorPayload | null> {
  const auth = c.req.header('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return null
  try {
    const { payload } = await jwtVerify(auth.slice(7), JWT_SECRET)
    if (payload.role !== 'gestor_account') return null
    return { gestorId: payload.gestorId as string, email: payload.email as string, name: payload.name as string }
  } catch { return null }
}

async function verifySalonToken(token: string): Promise<{ salon_id: string } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET)
    const sid = (payload.salon_id ?? payload.salonId) as string | undefined
    if (!sid) return null
    return { salon_id: sid }
  } catch { return null }
}

// ─── POST /gestor/register ────────────────────────────────────────────────────

gestorPublicRoutes.post('/register', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { email, password, name, company_name } = body

  if (!email || !password || !name)
    return c.json({ error: 'email, password y name son requeridos' }, 400)
  if (password.length < 8)
    return c.json({ error: 'Contraseña mínimo 8 caracteres' }, 400)

  const supabase = getSupabaseAdmin()
  const { data: existing } = await supabase
    .from('gestores').select('id').eq('email', email.toLowerCase().trim()).single()
  if (existing) return c.json({ error: 'Ya existe una cuenta con ese email' }, 409)

  const password_hash = await hashPassword(password)
  const affiliate_code = generateAffiliateCode()

  const { data: gestor, error } = await supabase
    .from('gestores')
    .insert([{ email: email.toLowerCase().trim(), name: name.trim(), company_name: company_name?.trim() ?? null, affiliate_code, password_hash }])
    .select('id, email, name, company_name, affiliate_code, created_at')
    .single()

  if (error) { console.error('[Gestor Register]', error); return c.json({ error: 'Error creando cuenta' }, 500) }

  const token = await signGestorJWT(gestor.id, gestor.email, gestor.name)
  return c.json({ ok: true, token, gestor: { id: gestor.id, email: gestor.email, name: gestor.name, company_name: gestor.company_name, affiliate_code: gestor.affiliate_code } }, 201)
})

// ─── POST /gestor/login ───────────────────────────────────────────────────────

gestorPublicRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { email, password } = body
  if (!email || !password) return c.json({ error: 'email y password requeridos' }, 400)

  const supabase = getSupabaseAdmin()
  const { data: gestor } = await supabase
    .from('gestores')
    .select('id, email, name, company_name, affiliate_code, password_hash')
    .eq('email', email.toLowerCase().trim())
    .single()

  if (!gestor || !(await verifyPassword(password, gestor.password_hash)))
    return c.json({ error: 'Credenciales incorrectas' }, 401)

  const token = await signGestorJWT(gestor.id, gestor.email, gestor.name)
  return c.json({ ok: true, token, gestor: { id: gestor.id, email: gestor.email, name: gestor.name, company_name: gestor.company_name, affiliate_code: gestor.affiliate_code } })
})

// ─── GET /gestor/me ───────────────────────────────────────────────────────────

gestorPublicRoutes.get('/me', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const [{ data }, { count }] = await Promise.all([
    supabase.from('gestores').select('id, email, name, company_name, affiliate_code, created_at').eq('id', g.gestorId).single(),
    supabase.from('gestor_salon_links').select('id', { count: 'exact' }).eq('gestor_id', g.gestorId).eq('status', 'active'),
  ])

  if (!data) return c.json({ error: 'Gestor no encontrado' }, 404)
  return c.json({ ok: true, gestor: { ...data, active_clients: count ?? 0 } })
})

// ─── GET /gestor/clients ──────────────────────────────────────────────────────

gestorPublicRoutes.get('/clients', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: links } = await supabase
    .from('gestor_salon_links')
    .select('id, salon_id, invited_email, status, accepted_at, created_at, salons(id, name)')
    .eq('gestor_id', g.gestorId)
    .order('created_at', { ascending: false })

  return c.json({
    ok: true,
    clients: (links ?? []).map((l) => ({
      link_id: l.id,
      salon_id: l.salon_id,
      salon_name: (l.salons as any)?.name ?? null,
      invited_email: l.invited_email,
      status: l.status,
      accepted_at: l.accepted_at,
      created_at: l.created_at,
    }))
  })
})

// ─── POST /gestor/clients/invite ──────────────────────────────────────────────

gestorPublicRoutes.post('/clients/invite', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const body = await c.req.json().catch(() => ({}))
  const { email } = body
  if (!email) return c.json({ error: 'email requerido' }, 400)

  const supabase = getSupabaseAdmin()
  const normalizedEmail = email.toLowerCase().trim()

  const { data: existing } = await supabase
    .from('gestor_salon_links')
    .select('id, status')
    .eq('gestor_id', g.gestorId)
    .eq('invited_email', normalizedEmail)
    .maybeSingle()

  if (existing?.status === 'active')
    return c.json({ error: 'Este cliente ya está vinculado activamente' }, 409)

  const invite_token = generateInviteToken()
  const invite_expires_at = new Date(Date.now() + INVITE_EXPIRY_HOURS * 3600 * 1000).toISOString()

  let linkId: string
  if (existing) {
    const { data } = await supabase.from('gestor_salon_links')
      .update({ invite_token, invite_expires_at, status: 'pending' })
      .eq('id', existing.id).select('id').single()
    linkId = data?.id
  } else {
    const { data, error } = await supabase.from('gestor_salon_links')
      .insert([{ gestor_id: g.gestorId, invited_email: normalizedEmail, status: 'pending', invite_token, invite_expires_at }])
      .select('id').single()
    if (error) { console.error('[Invite]', error); return c.json({ error: 'Error creando invitación' }, 500) }
    linkId = data.id
  }

  const acceptUrl = `https://gerobelleza-lang.github.io/diabolus-crm/gestor-accept.html?token=${invite_token}`
  await sendGestorInviteEmail(normalizedEmail, g.name, acceptUrl)

  return c.json({ ok: true, link_id: linkId, invited_email: normalizedEmail, invite_expires_at, accept_url: acceptUrl }, 201)
})

// ─── PATCH /gestor/clients/:linkId/deactivate ─────────────────────────────────

gestorPublicRoutes.patch('/clients/:linkId/deactivate', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('gestor_salon_links')
    .update({ status: 'inactive' })
    .eq('id', c.req.param('linkId'))
    .eq('gestor_id', g.gestorId)
    .select('id').single()

  if (error || !data) return c.json({ error: 'Vínculo no encontrado' }, 404)
  return c.json({ ok: true })
})

// ─── GET /gestor/invite-info ──────────────────────────────────────────────────
// Público — el cliente consulta detalles antes de aceptar

gestorPublicRoutes.get('/invite-info', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'Token requerido' }, 400)

  const supabase = getSupabaseAdmin()
  const { data: link } = await supabase
    .from('gestor_salon_links')
    .select('id, status, invite_expires_at, invited_email, gestores(name, company_name)')
    .eq('invite_token', token)
    .single()

  if (!link) return c.json({ error: 'Invitación no encontrada' }, 404)
  if (link.status === 'active') return c.json({ error: 'Esta invitación ya fue aceptada' }, 409)
  if (link.status === 'inactive') return c.json({ error: 'Invitación inactiva' }, 410)
  if (new Date(link.invite_expires_at) < new Date()) return c.json({ error: 'Invitación caducada' }, 410)

  return c.json({
    ok: true,
    gestor_name: (link.gestores as any)?.name ?? 'Tu gestor',
    company_name: (link.gestores as any)?.company_name ?? null,
    invited_email: link.invited_email,
    expires_at: link.invite_expires_at,
  })
})

// ─── POST /gestor/accept-invite ───────────────────────────────────────────────
// El cliente (con JWT de salon) acepta la invitación

gestorPublicRoutes.post('/accept-invite', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { invite_token } = body
  if (!invite_token) return c.json({ error: 'invite_token requerido' }, 400)

  const auth = c.req.header('Authorization') ?? ''
  const salonPayload = auth.startsWith('Bearer ') ? await verifySalonToken(auth.slice(7)) : null
  if (!salonPayload) return c.json({ error: 'JWT de salon requerido' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: link } = await supabase
    .from('gestor_salon_links')
    .select('id, status, invite_expires_at, gestor_id')
    .eq('invite_token', invite_token)
    .single()

  if (!link) return c.json({ error: 'Invitación no encontrada' }, 404)
  if (link.status === 'active') return c.json({ ok: true, message: 'Ya estás vinculado', already: true })
  if (link.status === 'inactive') return c.json({ error: 'Invitación inactiva' }, 410)
  if (new Date(link.invite_expires_at) < new Date()) return c.json({ error: 'Invitación caducada' }, 410)

  // Evitar duplicados activos
  const { data: dup } = await supabase
    .from('gestor_salon_links')
    .select('id')
    .eq('gestor_id', link.gestor_id)
    .eq('salon_id', salonPayload.salon_id)
    .eq('status', 'active')
    .maybeSingle()

  if (dup) return c.json({ ok: true, message: 'Tu negocio ya está vinculado a este gestor', already: true })

  const { error } = await supabase
    .from('gestor_salon_links')
    .update({ salon_id: salonPayload.salon_id, status: 'active', accepted_at: new Date().toISOString(), invite_token: null })
    .eq('id', link.id)

  if (error) { console.error('[Accept Invite]', error); return c.json({ error: 'Error aceptando' }, 500) }

  await supabase.from('audit_log').insert([{
    salon_id: salonPayload.salon_id,
    action: 'gestor_link_accepted',
    changes: { gestor_id: link.gestor_id, link_id: link.id },
    created_at: new Date().toISOString(),
  }])

  return c.json({ ok: true, message: '¡Vinculación completada! Tu gestor ya tiene acceso a tus datos.' })
})

// ─── GET /gestor/client/:salonId/report ──────────────────────────────────────
// ⚠️ SIN fiscal/IVA estimado — regla de negocio

gestorPublicRoutes.get('/client/:salonId/report', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const salonId = c.req.param('salonId')
  const supabase = getSupabaseAdmin()

  // Aislamiento: verificar vínculo activo
  const { data: link } = await supabase
    .from('gestor_salon_links')
    .select('id')
    .eq('gestor_id', g.gestorId)
    .eq('salon_id', salonId)
    .eq('status', 'active')
    .single()

  if (!link) return c.json({ error: 'Acceso denegado: salon no vinculado' }, 403)

  const now = new Date()
  const year = now.getFullYear()
  const quarter = Math.ceil((now.getMonth() + 1) / 3)
  const qStart = new Date(year, (quarter - 1) * 3, 1)
  const qEnd = new Date(year, quarter * 3, 0, 23, 59, 59)

  const [salonRes, transRes, invoiceRes] = await Promise.all([
    supabase.from('salons').select('name').eq('id', salonId).single(),
    supabase.from('transactions').select('*').eq('salon_id', salonId)
      .gte('date', qStart.toISOString()).lte('date', qEnd.toISOString())
      .order('date', { ascending: false }),
    supabase.from('invoices').select('*, clients(name, email)').eq('salon_id', salonId)
      .gte('issue_date', qStart.toISOString().split('T')[0])
      .lte('issue_date', qEnd.toISOString().split('T')[0])
      .order('issue_date', { ascending: false }),
  ])

  const transactions = transRes.data ?? []
  const invoices = invoiceRes.data ?? []
  const income = transactions.filter((t) => t.type === 'income').reduce((s, t) => s + (t.amount || 0), 0)
  const expenses = transactions.filter((t) => t.type === 'expense').reduce((s, t) => s + (t.amount || 0), 0)

  return c.json({
    ok: true,
    salon: salonRes.data?.name ?? 'Negocio',
    period: { year, quarter, label: `T${quarter} ${year}`, from: qStart.toISOString().split('T')[0], to: qEnd.toISOString().split('T')[0] },
    summary: { income: Math.round(income * 100) / 100, expenses: Math.round(expenses * 100) / 100, net_profit: Math.round((income - expenses) * 100) / 100 },
    // ⚠️ No hay sección fiscal — IVA no se muestra al gestor (decisión de producto)
    invoices: {
      total: invoices.length,
      paid: invoices.filter((i) => i.status === 'paid').length,
      pending: invoices.filter((i) => i.status === 'pending').length,
      overdue: invoices.filter((i) => i.status === 'overdue').length,
      total_invoiced: Math.round(invoices.reduce((s, i) => s + (i.total || 0), 0) * 100) / 100,
      list: invoices.map((i) => ({ id: i.id, number: i.number, client: (i.clients as any)?.name ?? '—', total: i.total, status: i.status, issue_date: i.issue_date })),
    },
    transactions: transactions.slice(0, 100).map((t) => ({ id: t.id, type: t.type, amount: t.amount, description: t.description, category: t.category, date: t.date })),
  })
})

// ─── GET /gestor/commissions ──────────────────────────────────────────────────

gestorPublicRoutes.get('/commissions', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const [{ data: commissions }, { count: activeClients }] = await Promise.all([
    supabase.from('gestor_commissions').select('*, salons(name)').eq('gestor_id', g.gestorId).order('period', { ascending: false }),
    supabase.from('gestor_salon_links').select('id', { count: 'exact' }).eq('gestor_id', g.gestorId).eq('status', 'active'),
  ])

  const totalAccrued = (commissions ?? []).filter((c) => c.status === 'accrued').reduce((s, c) => s + (c.amount || 0), 0)

  return c.json({
    ok: true,
    active_clients: activeClients ?? 0,
    total_accrued: Math.round(totalAccrued * 100) / 100,
    stripe_active: false,
    note: 'Las comisiones se calculan y pagan cuando se active la facturación (Fase 6).',
    commissions: (commissions ?? []).map((c) => ({
      id: c.id, salon_id: c.salon_id, salon_name: (c.salons as any)?.name ?? 'Negocio',
      period: c.period, amount: c.amount, status: c.status,
    }))
  })
})

// ─── Legacy: GET /gestor/report ───────────────────────────────────────────────

gestorPublicRoutes.get('/report', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'Token requerido' }, 401)

  let payload: any
  try {
    const { payload: p } = await jwtVerify(token, JWT_SECRET)
    payload = p
  } catch { return c.json({ error: 'Token inválido o expirado' }, 401) }

  if (payload.role !== 'gestor') return c.json({ error: 'Token no válido' }, 403)

  const salonId = payload.salon_id as string
  const supabase = getSupabaseAdmin()
  const now = new Date()
  const year = now.getFullYear()
  const quarter = Math.ceil((now.getMonth() + 1) / 3)
  const qStart = new Date(year, (quarter - 1) * 3, 1)
  const qEnd = new Date(year, quarter * 3, 0, 23, 59, 59)

  const [salonRes, transRes, invoiceRes] = await Promise.all([
    supabase.from('salons').select('name').eq('id', salonId).single(),
    supabase.from('transactions').select('*').eq('salon_id', salonId)
      .gte('date', qStart.toISOString()).lte('date', qEnd.toISOString()).order('date', { ascending: false }),
    supabase.from('invoices').select('*, clients(name, email)').eq('salon_id', salonId)
      .gte('issue_date', qStart.toISOString().split('T')[0]).lte('issue_date', qEnd.toISOString().split('T')[0]).order('issue_date', { ascending: false }),
  ])

  const transactions = transRes.data ?? []
  const invoices = invoiceRes.data ?? []
  const income = transactions.filter((t) => t.type === 'income').reduce((s, t) => s + (t.amount || 0), 0)
  const expenses = transactions.filter((t) => t.type === 'expense').reduce((s, t) => s + (t.amount || 0), 0)
  const net = income - expenses

  return c.json({
    ok: true,
    salon: salonRes.data?.name ?? 'Mi negocio',
    period: { year, quarter, label: `T${quarter} ${year}`, from: qStart.toISOString().split('T')[0], to: qEnd.toISOString().split('T')[0] },
    summary: { income: Math.round(income * 100) / 100, expenses: Math.round(expenses * 100) / 100, net_profit: Math.round(net * 100) / 100 },
    fiscal: { iva_repercutido: Math.round(income * 0.21 * 100) / 100, iva_soportado: Math.round(expenses * 0.21 * 100) / 100, iva_a_liquidar: Math.round((income - expenses) * 0.21 * 100) / 100, irpf_fraccionado: Math.round(Math.max(0, net * 0.2) * 100) / 100, modelo: 'Mod. 303 (IVA) + Mod. 130 (IRPF)' },
    invoices: { total: invoices.length, paid: invoices.filter((i) => i.status === 'paid').length, pending: invoices.filter((i) => i.status === 'pending').length, overdue: invoices.filter((i) => i.status === 'overdue').length, list: invoices },
    transactions,
  })
})

// ─── Legacy: POST /api/gestor/link ────────────────────────────────────────────

gestorRoutes.post('/link', async (c) => {
  const salonId = c.get('salon_id')
  if (!salonId) return c.json({ error: 'No salon_id in token' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: salon } = await supabase.from('salons').select('name').eq('id', salonId).single()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const token = await new SignJWT({ role: 'gestor', salon_id: salonId, salon_name: salon?.name ?? 'Mi negocio' })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresAt).sign(JWT_SECRET)

  const baseUrl = c.req.url.includes('localhost') ? 'http://localhost:5500' : 'https://gerobelleza-lang.github.io/diabolus-crm'
  return c.json({ ok: true, token, url: `${baseUrl}/gestor.html?token=${token}`, expires_at: expiresAt.toISOString(), salon_name: salon?.name ?? 'Mi negocio' })
})

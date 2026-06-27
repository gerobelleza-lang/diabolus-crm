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
import { sendGestorInviteEmail, sendChatNotificationClient } from '../integrations/email'

type Variables = { userId: string; salonId: string; userEmail: string; gestorId: string; usageWarning: boolean; salon_id: string }


export const gestorPublicRoutes = new Hono<{ Variables: Variables }>()
export const gestorRoutes = new Hono<{ Variables: Variables }>()

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? ''
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

// ─── B3: Endpoints de chat — lado gestor ──────────────────────────────────────
// Añadir al final de gestor.ts

// GET /gestor/thread/:salonId — hilo gestor↔cliente
gestorPublicRoutes.get('/thread/:salonId', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const salonId = c.req.param('salonId')
  const supabase = getSupabaseAdmin()

  // Aislamiento: solo hilos de sus clientes activos
  const { data: link } = await supabase
    .from('gestor_salon_links')
    .select('id')
    .eq('gestor_id', g.gestorId)
    .eq('salon_id', salonId)
    .eq('status', 'active')
    .single()

  if (!link) return c.json({ error: 'Cliente no vinculado o inactivo' }, 403)

  const { data: messages } = await supabase
    .from('gestor_messages')
    .select('id, sender, content, attachment, created_at, read_at')
    .eq('gestor_id', g.gestorId)
    .eq('salon_id', salonId)
    .order('created_at', { ascending: true })

  const SIGNED_URL_EXPIRY = 300
  const messagesWithUrls = await Promise.all(
    (messages ?? []).map(async (m: any) => {
      let attachment_url: string | null = null
      if (m.attachment?.storage_path) {
        const { data: signed } = await supabase.storage
          .from('chat-attachments')
          .createSignedUrl(m.attachment.storage_path, SIGNED_URL_EXPIRY)
        attachment_url = signed?.signedUrl ?? null
      }
      return { ...m, attachment_url }
    })
  )

  return c.json({ ok: true, messages: messagesWithUrls })
})

// POST /gestor/thread/:salonId — enviar mensaje
const MAX_FILE_SIZE_G = 10 * 1024 * 1024
const ALLOWED_MIMES_G = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/csv', 'application/zip',
])

gestorPublicRoutes.post('/thread/:salonId', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const salonId = c.req.param('salonId')
  const supabase = getSupabaseAdmin()

  const { data: link } = await supabase
    .from('gestor_salon_links')
    .select('id')
    .eq('gestor_id', g.gestorId)
    .eq('salon_id', salonId)
    .eq('status', 'active')
    .single()
  if (!link) return c.json({ error: 'Cliente no vinculado o inactivo' }, 403)

  const contentType = c.req.header('Content-Type') ?? ''
  let body = ''
  let attachment: { storage_path: string; filename: string; mime: string; size: number } | null = null

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData()
    body = (form.get('body') as string) ?? ''
    const file = form.get('file') as File | null

    if (file && file.size > 0) {
      if (!ALLOWED_MIMES_G.has(file.type))
        return c.json({ error: `Tipo no permitido: ${file.type}` }, 422)
      if (file.size > MAX_FILE_SIZE_G)
        return c.json({ error: 'El archivo supera 10 MB' }, 422)

      const fileId = crypto.randomUUID()
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const storagePath = `${g.gestorId}/${salonId}/${fileId}/${safeName}`

      const { error: uploadErr } = await supabase.storage
        .from('chat-attachments')
        .upload(storagePath, await file.arrayBuffer(), { contentType: file.type, upsert: false })

      if (uploadErr) {
        console.error('[Gestor Chat Upload]', uploadErr)
        return c.json({ error: 'Error subiendo adjunto' }, 500)
      }
      attachment = { storage_path: storagePath, filename: file.name, mime: file.type, size: file.size }
    }
  } else {
    const json = await c.req.json().catch(() => ({}))
    body = json.body ?? ''
  }

  if (!body.trim() && !attachment)
    return c.json({ error: 'Se requiere body o adjunto' }, 400)

  const { data: msg, error: insertErr } = await supabase
    .from('gestor_messages')
    .insert([{
      gestor_id: g.gestorId,
      salon_id: salonId,
      sender: 'gestor',
      content: body.trim() || null,
      attachment: attachment ?? null,
      created_at: new Date().toISOString(),
    }])
    .select('id, sender, content, attachment, created_at')
    .single()

  if (insertErr) {
    console.error('[Gestor Chat Insert]', insertErr)
    return c.json({ error: 'Error enviando mensaje' }, 500)
  }

  // Notificar al cliente por email (fire & forget)
  const [{ data: salon }, { data: clientProfile }] = await Promise.all([
    supabase.from('salons').select('name, email').eq('id', salonId).single(),
    supabase.from('users').select('email').eq('salon_id', salonId).limit(1).maybeSingle(),
  ])

  const clientEmail = salon?.email ?? clientProfile?.email
  if (clientEmail) {
    sendChatNotificationClient(
      clientEmail,
      salon?.name ?? 'Tu negocio',
      g.name,
      body.trim() || `[adjunto: ${attachment?.filename}]`
    ).catch(console.error)
  }

  return c.json({ ok: true, message: msg }, 201)
})

// POST /gestor/thread/:salonId/read — marcar mensajes del cliente como leídos
gestorPublicRoutes.post('/thread/:salonId/read', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const salonId = c.req.param('salonId')
  const supabase = getSupabaseAdmin()

  const { data: link } = await supabase
    .from('gestor_salon_links').select('id')
    .eq('gestor_id', g.gestorId).eq('salon_id', salonId).eq('status', 'active').single()
  if (!link) return c.json({ error: 'Acceso denegado' }, 403)

  await supabase
    .from('gestor_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('gestor_id', g.gestorId)
    .eq('salon_id', salonId)
    .eq('sender', 'client')
    .is('read_at', null)

  return c.json({ ok: true })
})

// GET /gestor/attachment/:msgId — URL firmada (gestor)
gestorPublicRoutes.get('/attachment/:msgId', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const msgId = c.req.param('msgId')
  const supabase = getSupabaseAdmin()

  const { data: msg } = await supabase
    .from('gestor_messages').select('gestor_id, salon_id, attachment').eq('id', msgId).single()

  if (!msg) return c.json({ error: 'Mensaje no encontrado' }, 404)
  if (msg.gestor_id !== g.gestorId) return c.json({ error: 'Acceso denegado' }, 403)
  if (!msg.attachment?.storage_path) return c.json({ error: 'Sin adjunto' }, 404)

  // Verificar vínculo activo
  const { data: link } = await supabase
    .from('gestor_salon_links').select('id')
    .eq('gestor_id', g.gestorId).eq('salon_id', msg.salon_id).eq('status', 'active').single()
  if (!link) return c.json({ error: 'Acceso denegado' }, 403)

  const { data: signed } = await supabase.storage
    .from('chat-attachments').createSignedUrl(msg.attachment.storage_path, 300)

  if (!signed?.signedUrl) return c.json({ error: 'Error generando URL' }, 500)
  return c.json({ ok: true, url: signed.signedUrl, expires_in: 300, filename: msg.attachment.filename })
})

// GET /gestor/unread — total no leídos en todos los hilos activos
gestorPublicRoutes.get('/unread', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()

  // Solo de clientes activos
  const { data: links } = await supabase
    .from('gestor_salon_links').select('salon_id')
    .eq('gestor_id', g.gestorId).eq('status', 'active')

  const salonIds = (links ?? []).map((l: any) => l.salon_id)
  if (!salonIds.length) return c.json({ ok: true, unread: 0 })

  const { count } = await supabase
    .from('gestor_messages')
    .select('id', { count: 'exact' })
    .eq('gestor_id', g.gestorId)
    .in('salon_id', salonIds)
    .eq('sender', 'client')
    .is('read_at', null)

  return c.json({ ok: true, unread: count ?? 0 })
})

// ─── B4 Pieza 2: Comisiones devengadas ───────────────────────────────────────
// Panel informativo — sin payout (Fase 6)

gestorPublicRoutes.get('/commissions/panel', async (c) => {
  const gestorId = c.get('gestorId') as string
  if (!gestorId) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: links, error } = await supabase
    .from('gestor_salon_links')
    .select('id, salon_id, created_at, commission_rate, precio_mantenimiento, salons(name)')
    .eq('gestor_id', gestorId)
    .eq('status', 'active')
    .order('created_at')

  if (error) return c.json({ error: 'Error al cargar clientes' }, 500)

  const now = new Date()
  const rows = (links || []).map((link: any) => {
    const activeSince = new Date(link.created_at)
    const monthsActive = Math.max(
      (now.getFullYear() - activeSince.getFullYear()) * 12
      + now.getMonth() - activeSince.getMonth()
      + (now.getDate() >= activeSince.getDate() ? 0 : -1),
      0
    )
    const hasTarifa = link.commission_rate != null && link.precio_mantenimiento != null
    const devengadoMes = hasTarifa
      ? Math.round(Number(link.precio_mantenimiento) * Number(link.commission_rate) * 100) / 100
      : null
    const devengadoTotal = hasTarifa ? Math.round(devengadoMes! * monthsActive * 100) / 100 : null
    return {
      salon_id: link.salon_id,
      salon_name: link.salons?.name ?? '—',
      active_since: link.created_at,
      months_active: monthsActive,
      commission_rate: link.commission_rate,
      precio_mantenimiento: link.precio_mantenimiento,
      devengado_mensual: devengadoMes,
      devengado_total: devengadoTotal,
      tarifa_fijada: hasTarifa,
    }
  })

  const totalDevengado = rows
    .filter((r: any) => r.devengado_total !== null)
    .reduce((s: number, r: any) => s + r.devengado_total!, 0)

  return c.json({
    clientes: rows,
    resumen: {
      total_activos: rows.length,
      total_devengado: Math.round(totalDevengado * 100) / 100,
      pendientes_tarifa: rows.filter((r: any) => !r.tarifa_fijada).length,
      nota: 'Los pagos se activarán en Fase 6 (Stripe). Este panel es informativo.',
    },
  })
})

gestorPublicRoutes.get('/commissions/history', async (c) => {
  const gestorId = c.get('gestorId') as string
  if (!gestorId) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('commission_ledger')
    .select('*, salons(name)')
    .eq('gestor_id', gestorId)
    .order('year', { ascending: false })
    .order('month', { ascending: false })
    .limit(120)

  if (error) return c.json({ error: 'Error al cargar historial' }, 500)
  return c.json({ ledger: data || [] })
})

// ─── GET /gestor/summary ─────────────────────────────────────────────────────
// KPIs globales agregados de todos los clientes activos del gestor

gestorPublicRoutes.get('/summary', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)
  const supabase = getSupabaseAdmin()
  const { data: links } = await supabase.from('gestor_salon_links').select('salon_id').eq('gestor_id', g.gestorId).eq('status', 'active')
  const salonIds = (links ?? []).map((l: any) => l.salon_id)
  if (!salonIds.length) return c.json({ ok: true, client_count: 0, totals: { income: 0, expenses: 0, net: 0, pending: 0, overdue: 0 } })
  const now = new Date()
  const monthFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const today = now.toISOString().split('T')[0]
  const [{ data: txs }, { data: pendingInv }] = await Promise.all([
    supabase.from('transactions').select('type, amount').in('salon_id', salonIds).gte('date', monthFrom).lte('date', today),
    supabase.from('invoices').select('total, due_date').in('salon_id', salonIds).in('status', ['pending', 'overdue']),
  ])
  const income = (txs ?? []).filter((t: any) => t.type === 'income').reduce((s: number, t: any) => s + (t.amount || 0), 0)
  const expenses = (txs ?? []).filter((t: any) => t.type === 'expense').reduce((s: number, t: any) => s + (t.amount || 0), 0)
  const pending = (pendingInv ?? []).reduce((s: number, i: any) => s + (i.total || 0), 0)
  const overdue = (pendingInv ?? []).filter((i: any) => i.due_date && i.due_date < today).reduce((s: number, i: any) => s + (i.total || 0), 0)
  const r = (n: number) => Math.round(n * 100) / 100
  return c.json({ ok: true, client_count: salonIds.length, month: monthFrom.slice(0, 7), totals: { income: r(income), expenses: r(expenses), net: r(income - expenses), pending: r(pending), overdue: r(overdue) } })
})

// ─── GET /gestor/client/:salonId/monthly?month=YYYY-MM ───────────────────────
// Informe mensual con comparativa vs mes anterior

gestorPublicRoutes.get('/client/:salonId/monthly', async (c) => {
  const g = await getGestorFromRequest(c)
  if (!g) return c.json({ error: 'No autorizado' }, 401)
  const salonId = c.req.param('salonId')
  const monthParam = c.req.query('month')
  if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) return c.json({ error: 'Parámetro month requerido (YYYY-MM)' }, 400)
  const supabase = getSupabaseAdmin()
  const { data: link } = await supabase.from('gestor_salon_links').select('id').eq('gestor_id', g.gestorId).eq('salon_id', salonId).eq('status', 'active').single()
  if (!link) return c.json({ error: 'Acceso denegado' }, 403)
  const [year, mon] = monthParam.split('-').map(Number)
  const from = `${year}-${String(mon).padStart(2, '0')}-01`
  const lastDay = new Date(year, mon, 0).getDate()
  const to = `${year}-${String(mon).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const prevDate = new Date(year, mon - 2, 1)
  const prevYear = prevDate.getFullYear(); const prevMon = prevDate.getMonth() + 1
  const prevFrom = `${prevYear}-${String(prevMon).padStart(2, '0')}-01`
  const prevLastDay = new Date(prevYear, prevMon, 0).getDate()
  const prevTo = `${prevYear}-${String(prevMon).padStart(2, '0')}-${String(prevLastDay).padStart(2, '0')}`
  const [salonRes, txCurr, txPrev, invCurr] = await Promise.all([
    supabase.from('salons').select('name').eq('id', salonId).single(),
    supabase.from('transactions').select('type, amount, description, date, category').eq('salon_id', salonId).gte('date', from).lte('date', to).order('date', { ascending: false }),
    supabase.from('transactions').select('type, amount').eq('salon_id', salonId).gte('date', prevFrom).lte('date', prevTo),
    supabase.from('invoices').select('number, total, status, issue_date, due_date, client_name').eq('salon_id', salonId).gte('issue_date', from).lte('issue_date', to).order('issue_date', { ascending: false }),
  ])
  const calc = (txs: any[]) => ({ income: (txs ?? []).filter((t: any) => t.type === 'income').reduce((s: number, t: any) => s + (t.amount || 0), 0), expenses: (txs ?? []).filter((t: any) => t.type === 'expense').reduce((s: number, t: any) => s + (t.amount || 0), 0) })
  const curr = calc(txCurr.data ?? []); const prev = calc(txPrev.data ?? [])
  const r = (n: number) => Math.round(n * 100) / 100
  const delta = (a: number, b: number) => b === 0 ? null : Math.round(((a - b) / b) * 100)
  return c.json({
    ok: true, salon: salonRes.data?.name ?? 'Negocio',
    month: { year, month: mon, label: `${String(mon).padStart(2, '0')}/${year}`, from, to },
    current: { income: r(curr.income), expenses: r(curr.expenses), net: r(curr.income - curr.expenses) },
    previous: { income: r(prev.income), expenses: r(prev.expenses), net: r(prev.income - prev.expenses), label: `${String(prevMon).padStart(2, '0')}/${prevYear}` },
    delta: { income: delta(curr.income, prev.income), expenses: delta(curr.expenses, prev.expenses), net: delta(curr.income - curr.expenses, prev.income - prev.expenses) },
    invoices: (invCurr.data ?? []).map((i: any) => ({ number: i.number, total: i.total, status: i.status, issue_date: i.issue_date, due_date: i.due_date, client: i.client_name })),
  })
})

// ─── B4: Export token endpoint ────────────────────────────────────────────────
gestorPublicRoutes.post('/export/token', async (c) => {
  const gestorId = c.get('gestorId') as string
  if (!gestorId) return c.json({ error: 'No autorizado' }, 401)

  const body = await c.req.json().catch(() => ({}))
  const { salonId, month, format } = body

  if (!salonId || !month || !format) return c.json({ error: 'Faltan parámetros' }, 400)
  if (!['csv', 'xlsx', 'pdf'].includes(format)) return c.json({ error: 'Formato inválido' }, 400)
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: 'Mes inválido (YYYY-MM)' }, 400)

  const supabase = getSupabaseAdmin()
  const { data: link } = await supabase
    .from('gestor_salon_links')
    .select('id')
    .eq('gestor_id', gestorId)
    .eq('salon_id', salonId)
    .eq('status', 'active')
    .single()

  if (!link) return c.json({ error: 'Cliente no vinculado o inactivo' }, 403)

  const token = await new SignJWT({ gestorId, salonId, month, format, type: 'diabolus_export_v1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('15m')
    .sign(JWT_SECRET)

  return c.json({ downloadUrl: `https://diabolus-crm-api.vercel.app/api/export/download?token=${token}` })
})

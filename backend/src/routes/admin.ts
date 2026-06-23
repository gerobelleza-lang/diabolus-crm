// @ts-nocheck
/**
 * admin.ts — Panel de administración Super Admin
 *
 * Rutas protegidas: requieren usuario en tabla admin_users con super_admin = true
 *
 *   GET  /api/admin/usage        — uso de mensajes todos los salones (mes actual)
 *   GET  /api/admin/salons       — lista salones con plan + límite
 *   POST /api/admin/salons/:id/plan — cambiar plan/límite de un salón
 *   POST /api/admin/invites      — crear invitación beta
 *   GET  /api/admin/invites      — listar invitaciones
 *   DELETE /api/admin/invites/:id — revocar invitación
 */

import { Hono }               from 'hono'
import { createClient }       from '@supabase/supabase-js'

export const adminRoutes = new Hono()

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function getCurrentYearMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// Middleware: solo super_admin
async function requireSuperAdmin(c: any, next: any) {
  const userId = c.get('userId') as string
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = getSupabase()
  const { data } = await supabase
    .from('admin_users')
    .select('super_admin')
    .eq('user_id', userId)
    .single()

  if (!data?.super_admin) return c.json({ error: 'Super Admin required' }, 403)
  return next()
}

adminRoutes.use('*', requireSuperAdmin)

// ─── GET /api/admin/usage ──────────────────────────────────────────────────────

adminRoutes.get('/usage', async (c) => {
  try {
    const supabase  = getSupabase()
    const yearMonth = getCurrentYearMonth()

    const { data: salons } = await supabase
      .from('salons')
      .select('id, name, plan, message_limit')
      .order('name')

    const { data: usages } = await supabase
      .from('salon_message_usage')
      .select('salon_id, message_count')
      .eq('year_month', yearMonth)

    const usageMap: Record<string, number> = {}
    for (const u of usages || []) {
      usageMap[u.salon_id] = u.message_count
    }

    const result = (salons || []).map(s => {
      const count     = usageMap[s.id] || 0
      const limit     = s.message_limit ?? 300
      const pct       = limit === -1 ? 0 : Math.round((count / limit) * 100)
      const remaining = limit === -1 ? '∞' : Math.max(0, limit - count)
      return {
        salon_id:   s.id,
        name:       s.name,
        plan:       s.plan || 'basico',
        limit,
        count,
        pct,
        remaining,
        year_month: yearMonth,
        status:     limit === -1 ? 'enterprise' : pct >= 100 ? 'blocked' : pct >= 80 ? 'warning' : 'ok',
      }
    })

    return c.json({ ok: true, year_month: yearMonth, salons: result })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ─── GET /api/admin/salons ─────────────────────────────────────────────────────

adminRoutes.get('/salons', async (c) => {
  try {
    const supabase = getSupabase()
    const { data } = await supabase
      .from('salons')
      .select('id, name, plan, message_limit, created_at')
      .order('created_at', { ascending: false })
    return c.json({ ok: true, salons: data || [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ─── POST /api/admin/salons/:id/plan ──────────────────────────────────────────

adminRoutes.post('/salons/:id/plan', async (c) => {
  try {
    const salonId = c.req.param('id')
    const body    = await c.req.json().catch(() => ({}))

    const PLAN_LIMITS: Record<string, number> = {
      basico:     300,
      pro:       1000,
      pro_plus:  3000,
      enterprise:  -1,
    }

    const plan  = body.plan || 'basico'
    const limit = body.message_limit ?? PLAN_LIMITS[plan] ?? 300

    if (!PLAN_LIMITS.hasOwnProperty(plan)) {
      return c.json({ error: 'Plan inválido. Usa: basico, pro, pro_plus, enterprise' }, 400)
    }

    const supabase = getSupabase()
    const { error } = await supabase
      .from('salons')
      .update({ plan, message_limit: limit })
      .eq('id', salonId)

    if (error) return c.json({ error: error.message }, 500)

    return c.json({ ok: true, salon_id: salonId, plan, message_limit: limit })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ─── POST /api/admin/salons/:id/pacto ─────────────────────────────────────────

adminRoutes.post('/salons/:id/pacto', async (c) => {
  try {
    const salonId = c.req.param('id')
    const body    = await c.req.json().catch(() => ({}) )
    const activo  = body.activo === true

    const supabase = getSupabase()
    const { error } = await supabase
      .from('salons')
      .update({
        pacto_activo:       activo,
        pacto_activado_at:  activo ? new Date().toISOString() : null,
      })
      .eq('id', salonId)

    if (error) return c.json({ error: error.message }, 500)

    return c.json({ ok: true, salon_id: salonId, pacto_activo: activo })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ─── GET /api/admin/pacto/stats ───────────────────────────────────────────────

adminRoutes.get('/pacto/stats', async (c) => {
  try {
    const supabase = getSupabase()
    const { data } = await supabase
      .from('salons')
      .select('id, name, pacto_activo, pacto_activado_at')
      .eq('pacto_activo', true)

    const activos   = (data || []).length
    const ingresos  = activos * 29

    return c.json({ ok: true, activos, ingresos_mes: ingresos, salones: data || [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ─── POST /api/admin/invites — crear invitación beta ─────────────────────────

adminRoutes.post('/invites', async (c) => {
  try {
    const userId = c.get('userId') as string
    const body = await c.req.json().catch(() => ({}))

    const supabase = getSupabase()
    const { data: invite, error } = await supabase
      .from('beta_invites')
      .insert({
        email_hint: body.email_hint || null,
        note: body.note || null,
        created_by: userId,
        expires_at: body.expires_days
          ? new Date(Date.now() + body.expires_days * 86400000).toISOString()
          : new Date(Date.now() + 30 * 86400000).toISOString(),
      })
      .select()
      .single()

    if (error) return c.json({ error: error.message }, 500)

    const url = `https://diabolus.es/register.html?invite=${invite.token}`
    return c.json({ ok: true, invite, url })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ─── GET /api/admin/invites — listar invitaciones ────────────────────────────

adminRoutes.get('/invites', async (c) => {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('beta_invites')
      .select('id, token, email_hint, note, used_at, expires_at, created_at')
      .order('created_at', { ascending: false })

    if (error) return c.json({ error: error.message }, 500)
    return c.json({ ok: true, invites: data || [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ─── DELETE /api/admin/invites/:id — revocar invitación ──────────────────────

adminRoutes.delete('/invites/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const supabase = getSupabase()
    const { error } = await supabase.from('beta_invites').delete().eq('id', id).is('used_at', null)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ ok: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

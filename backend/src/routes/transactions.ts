import { validate, createTransactionSchema } from '../schemas'
/**
 * transactions.ts — F4-3 update: filtros por categoría/etiqueta, recategorización auditada, stats
 *
 * GET    /api/transactions                  — lista con filtros: type, category, tag, search, date
 * GET    /api/transactions/stats            — resumen por categoría (gastos e ingresos)
 * GET    /api/transactions/:id
 * POST   /api/transactions
 * PATCH  /api/transactions/:id/category     — recategorizar (auditado, sin confirmation card)
 * PATCH  /api/transactions/:id/tags         — actualizar etiquetas libres
 * PATCH  /api/transactions/:id/status       — cambiar estado del ciclo de vida
 * DELETE /api/transactions/:id
 */

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }
export const transactionRoutes = new Hono<{ Variables: Variables }>()

// ─── GET /api/transactions ────────────────────────────────────────────────────
transactionRoutes.get('/', async (c) => {
  const salonId  = c.get('salonId')
  const supabase = getSupabaseAdmin()
  const {
    page     = '1',
    limit    = '50',
    type,
    category,
    tag,
    search,
    date_from,
    date_to,
    status,
  } = c.req.query()

  const from = (parseInt(page) - 1) * parseInt(limit)
  const to   = from + parseInt(limit) - 1

  let query = supabase
    .from('transactions')
    .select('*, clients(name)', { count: 'exact' })
    .eq('salon_id', salonId)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(from, to)

  if (type)      query = query.eq('type', type)
  if (category)  query = query.eq('category', category)
  if (tag)       query = query.contains('tags', [tag])
  if (date_from) query = query.gte('date', date_from)
  if (date_to)   query = query.lte('date', date_to)
  if (search)    query = query.ilike('description', `%${search}%`)
  if (status)    query = query.eq('status', status)

  const { data, error, count } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ transactions: data, total: count, page: parseInt(page), limit: parseInt(limit) })
})

// ─── GET /api/transactions/stats — resumen por categoría ─────────────────────
transactionRoutes.get('/stats', async (c) => {
  const salonId = c.get('salonId')
  const { month, year } = c.req.query()
  const supabase = getSupabaseAdmin()

  let query = supabase
    .from('transactions')
    .select('type, amount, category')
    .eq('salon_id', salonId)

  if (year && month) {
    const y = parseInt(year), m = parseInt(month)
    const dateFrom = `${y}-${String(m).padStart(2, '0')}-01`
    const dateToObj = new Date(y, m, 0) // last day of month
    const dateTo = `${y}-${String(m).padStart(2, '0')}-${String(dateToObj.getDate()).padStart(2, '0')}`
    query = query.gte('date', dateFrom).lte('date', dateTo)
  }

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)

  // Agrupar por categoría y tipo
  const byCategory: Record<string, { gastos: number; ingresos: number }> = {}
  for (const t of (data || [])) {
    const cat = t.category || 'otros'
    if (!byCategory[cat]) byCategory[cat] = { gastos: 0, ingresos: 0 }
    if (t.type === 'expense' || t.type === 'gasto') {
      byCategory[cat].gastos += Number(t.amount) || 0
    } else {
      byCategory[cat].ingresos += Number(t.amount) || 0
    }
  }

  const stats = Object.entries(byCategory)
    .map(([category, totals]) => ({ category, ...totals }))
    .sort((a, b) => (b.gastos + b.ingresos) - (a.gastos + a.ingresos))

  return c.json({ stats })
})

// ─── GET /api/transactions/:id ────────────────────────────────────────────────
transactionRoutes.get('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('transactions')
    .select('*, clients(name)')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()

  if (error) return c.json({ error: 'Transaction not found' }, 404)
  return c.json({ transaction: data })
})

// ─── POST /api/transactions ───────────────────────────────────────────────────
transactionRoutes.post('/', async (c) => {
  const salonId = c.get('salonId')
  const userId  = c.get('userId')
  const body    = await c.req.json()
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('transactions')
    .insert({ ...body, salon_id: salonId, created_by_user_id: userId })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ transaction: data }, 201)
})

// ─── PATCH /api/transactions/:id/category — recategorizar (auditado) ──────────
transactionRoutes.patch('/:id/category', async (c) => {
  const salonId  = c.get('salonId')
  const userId   = c.get('userId')
  const { id }   = c.req.param()
  const body     = await c.req.json().catch(() => ({}))
  const { category } = body

  if (!category) return c.json({ error: 'category requerido' }, 400)

  const supabase = getSupabaseAdmin()

  // Verificar que la categoría existe (global o custom del tenant)
  const { data: catExists } = await supabase
    .from('categories')
    .select('slug')
    .or(`salon_id.is.null,salon_id.eq.${salonId}`)
    .eq('slug', category)
    .maybeSingle()

  if (!catExists) return c.json({ error: `Categoría "${category}" no reconocida` }, 400)

  // Obtener el valor anterior para el audit log
  const { data: prev } = await supabase
    .from('transactions')
    .select('category')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()

  if (!prev) return c.json({ error: 'Transacción no encontrada' }, 404)

  // Actualizar
  const { data, error } = await supabase
    .from('transactions')
    .update({ category })
    .eq('salon_id', salonId)
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)

  // Audit log — recategorización es acción directa del usuario, no necesita confirmation card
  await supabase.from('audit_log').insert({
    user_id:    userId,
    salon_id:   salonId,
    action:     'recategorizar_transaccion',
    changes: {
      transaction_id: id,
      category_from:  prev.category,
      category_to:    category,
    },
    created_at: new Date().toISOString(),
  })

  return c.json({ transaction: data })
})

// ─── PATCH /api/transactions/:id/tags — actualizar etiquetas libres ───────────
transactionRoutes.patch('/:id/tags', async (c) => {
  const salonId = c.get('salonId')
  const { id }  = c.req.param()
  const body    = await c.req.json().catch(() => ({}))

  // tags puede ser array completo (replace) o add/remove individual
  const { tags, add, remove } = body
  const supabase = getSupabaseAdmin()

  // Obtener tags actuales
  const { data: current } = await supabase
    .from('transactions')
    .select('tags')
    .eq('salon_id', salonId)
    .eq('id', id)
    .single()

  if (!current) return c.json({ error: 'Transacción no encontrada' }, 404)

  let newTags: string[] = current.tags || []

  if (Array.isArray(tags)) {
    // Reemplazo completo — normalizar y deduplicar
    newTags = [...new Set(tags.map((t: string) => t.trim().toLowerCase()).filter(Boolean))]
  } else {
    if (add)    newTags = [...new Set([...newTags, add.trim().toLowerCase()].filter(Boolean))]
    if (remove) newTags = newTags.filter(t => t !== remove.trim().toLowerCase())
  }

  // Límite de 10 etiquetas por movimiento
  if (newTags.length > 10) return c.json({ error: 'Máximo 10 etiquetas por movimiento' }, 400)

  const { data, error } = await supabase
    .from('transactions')
    .update({ tags: newTags })
    .eq('salon_id', salonId)
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ transaction: data })
})

// ─── PATCH /api/transactions/:id/status ────────────────────────────────────────
transactionRoutes.patch('/:id/status', async (c) => {
  const salonId  = c.get('salonId')
  const { id }   = c.req.param()
  const supabase = getSupabaseAdmin()

  const body = await c.req.json().catch(() => ({}))
  const { status } = body

  const VALID = ['pendiente', 'revisado', 'enviado_gestoria']
  if (!VALID.includes(status)) {
    return c.json({ error: `Estado inválido. Debe ser uno de: ${VALID.join(', ')}` }, 400)
  }

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = { status }
  if (status === 'revisado')         updates.reviewed_at         = now
  if (status === 'enviado_gestoria') updates.sent_to_gestoria_at = now

  const { data, error } = await supabase
    .from('transactions')
    .update(updates)
    .eq('salon_id', salonId)
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ transaction: data })
})

// ─── DELETE /api/transactions/:id ─────────────────────────────────────────────
transactionRoutes.delete('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id }  = c.req.param()
  const supabase = getSupabaseAdmin()

  const { error } = await supabase
    .from('transactions')
    .delete()
    .eq('salon_id', salonId)
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ message: 'Transaction deleted' })
})

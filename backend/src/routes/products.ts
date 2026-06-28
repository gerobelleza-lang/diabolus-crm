/**
 * products.ts — Catálogo de Productos y Servicios por salón
 *
 * GET    /api/products           — lista productos activos del salón
 * GET    /api/products/all       — lista TODOS (activos + inactivos)
 * GET    /api/products/search?q= — búsqueda por nombre (para Diablilla)
 * GET    /api/products/:id       — detalle de un producto
 * POST   /api/products           — crear producto
 * PUT    /api/products/:id       — actualizar producto
 * DELETE /api/products/:id       — desactivar producto (soft delete)
 */

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }
export const productsRoutes = new Hono<{ Variables: Variables }>()

// ─── GET /api/products — lista activos ────────────────────────────────────────
productsRoutes.get('/', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()
  const category = c.req.query('category')

  let query = supabase
    .from('products')
    .select('*')
    .eq('salon_id', salonId)
    .eq('is_active', true)
    .order('category', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })

  if (category) {
    query = query.eq('category', category)
  }

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ products: data || [] })
})

// ─── GET /api/products/all — todos incluidos inactivos ────────────────────────
productsRoutes.get('/all', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('salon_id', salonId)
    .order('is_active', { ascending: false })
    .order('name', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ products: data || [] })
})

// ─── GET /api/products/search?q= — búsqueda para Diablilla ───────────────────
productsRoutes.get('/search', async (c) => {
  const salonId = c.get('salonId')
  const q = (c.req.query('q') || '').trim()
  if (!q || q.length < 2) return c.json({ products: [] })

  const supabase = getSupabaseAdmin()

  // Try text search first, fall back to ilike
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('salon_id', salonId)
    .eq('is_active', true)
    .ilike('name', `%${q}%`)
    .order('name', { ascending: true })
    .limit(20)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ products: data || [] })
})

// ─── GET /api/products/:id ────────────────────────────────────────────────────
productsRoutes.get('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', id)
    .eq('salon_id', salonId)
    .single()

  if (error || !data) return c.json({ error: 'Producto no encontrado' }, 404)
  return c.json({ product: data })
})

// ─── POST /api/products ──────────────────────────────────────────────────────
productsRoutes.post('/', async (c) => {
  const salonId = c.get('salonId')
  const body = await c.req.json().catch(() => ({}))
  const { name, description, price, iva_rate, unit, category, sku } = body

  // Validación
  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return c.json({ error: 'El nombre es obligatorio' }, 400)
  }
  if (name.trim().length > 200) {
    return c.json({ error: 'El nombre no puede superar 200 caracteres' }, 400)
  }
  if (price !== undefined && (typeof price !== 'number' || price < 0)) {
    return c.json({ error: 'El precio debe ser un número positivo' }, 400)
  }
  if (iva_rate !== undefined && ![0, 4, 10, 21].includes(iva_rate)) {
    return c.json({ error: 'IVA debe ser 0, 4, 10 o 21' }, 400)
  }

  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('products')
    .insert({
      salon_id: salonId,
      name: name.trim(),
      description: description?.trim() || null,
      price: price ?? 0,
      iva_rate: iva_rate ?? 21,
      unit: unit?.trim() || 'ud',
      category: category?.trim() || null,
      sku: sku?.trim() || null,
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ product: data }, 201)
})

// ─── PUT /api/products/:id ───────────────────────────────────────────────────
productsRoutes.put('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const body = await c.req.json().catch(() => ({}))
  const { name, description, price, iva_rate, unit, category, sku, is_active } = body

  // Validación
  if (name !== undefined && (!name || typeof name !== 'string' || name.trim().length < 1)) {
    return c.json({ error: 'El nombre no puede estar vacío' }, 400)
  }
  if (name && name.trim().length > 200) {
    return c.json({ error: 'El nombre no puede superar 200 caracteres' }, 400)
  }
  if (price !== undefined && (typeof price !== 'number' || price < 0)) {
    return c.json({ error: 'El precio debe ser un número positivo' }, 400)
  }
  if (iva_rate !== undefined && ![0, 4, 10, 21].includes(iva_rate)) {
    return c.json({ error: 'IVA debe ser 0, 4, 10 o 21' }, 400)
  }

  const supabase = getSupabaseAdmin()

  // Verify ownership
  const { data: existing } = await supabase
    .from('products')
    .select('id')
    .eq('id', id)
    .eq('salon_id', salonId)
    .single()

  if (!existing) return c.json({ error: 'Producto no encontrado' }, 404)

  const updates: Record<string, unknown> = {}
  if (name !== undefined) updates.name = name.trim()
  if (description !== undefined) updates.description = description?.trim() || null
  if (price !== undefined) updates.price = price
  if (iva_rate !== undefined) updates.iva_rate = iva_rate
  if (unit !== undefined) updates.unit = unit.trim() || 'ud'
  if (category !== undefined) updates.category = category?.trim() || null
  if (sku !== undefined) updates.sku = sku?.trim() || null
  if (is_active !== undefined) updates.is_active = !!is_active

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No hay cambios' }, 400)
  }

  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', id)
    .eq('salon_id', salonId)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ product: data })
})

// ─── DELETE /api/products/:id — soft delete ──────────────────────────────────
productsRoutes.delete('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  const { data: existing } = await supabase
    .from('products')
    .select('id')
    .eq('id', id)
    .eq('salon_id', salonId)
    .single()

  if (!existing) return c.json({ error: 'Producto no encontrado' }, 404)

  const { error } = await supabase
    .from('products')
    .update({ is_active: false })
    .eq('id', id)
    .eq('salon_id', salonId)

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

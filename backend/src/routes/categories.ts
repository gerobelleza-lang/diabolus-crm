// @ts-nocheck
/**
 * categories.ts — F4-3: Categorías estándar + custom por tenant
 *
 * GET    /api/categories       — lista (global + custom del tenant)
 * POST   /api/categories       — crear categoría custom (máx 5 por tenant)
 * DELETE /api/categories/:id   — eliminar categoría custom del tenant
 */

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }
export const categoriesRoutes = new Hono<{ Variables: Variables }>()

// ─── GET /api/categories ──────────────────────────────────────────────────────
categoriesRoutes.get('/', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('categories')
    .select('id, slug, label, salon_id, created_at')
    .or(`salon_id.is.null,salon_id.eq.${salonId}`)
    .order('salon_id', { ascending: true, nullsFirst: true })
    .order('label', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)

  // Marca cuáles son custom del tenant
  const categories = (data || []).map(cat => ({
    ...cat,
    is_custom: cat.salon_id !== null,
  }))

  return c.json({ categories })
})

// ─── POST /api/categories ─────────────────────────────────────────────────────
categoriesRoutes.post('/', async (c) => {
  const salonId = c.get('salonId')
  const body = await c.req.json().catch(() => ({}))
  const { slug, label } = body

  if (!slug || !label) return c.json({ error: 'slug y label son requeridos' }, 400)
  if (!/^[a-z0-9_]+$/.test(slug)) {
    return c.json({ error: 'El slug solo puede contener letras minúsculas, números y guiones bajos' }, 400)
  }
  if (label.trim().length < 2 || label.trim().length > 50) {
    return c.json({ error: 'El label debe tener entre 2 y 50 caracteres' }, 400)
  }

  const supabase = getSupabaseAdmin()

  // Máx 5 categorías custom por tenant
  const { count, error: countErr } = await supabase
    .from('categories')
    .select('*', { count: 'exact', head: true })
    .eq('salon_id', salonId)

  if (countErr) return c.json({ error: countErr.message }, 500)
  if ((count || 0) >= 5) {
    return c.json({
      error: 'Límite de 5 categorías personalizadas alcanzado. Elimina alguna para añadir una nueva.',
    }, 400)
  }

  // Verificar que no existe ese slug (global o en este tenant)
  const { data: existing } = await supabase
    .from('categories')
    .select('id')
    .or(`salon_id.is.null,salon_id.eq.${salonId}`)
    .eq('slug', slug.trim())
    .maybeSingle()

  if (existing) return c.json({ error: `Ya existe una categoría con el slug "${slug}"` }, 409)

  const { data, error } = await supabase
    .from('categories')
    .insert({ slug: slug.trim(), label: label.trim(), salon_id: salonId })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 400)
  return c.json({ category: { ...data, is_custom: true } }, 201)
})

// ─── DELETE /api/categories/:id ───────────────────────────────────────────────
categoriesRoutes.delete('/:id', async (c) => {
  const salonId = c.get('salonId')
  const { id } = c.req.param()
  const supabase = getSupabaseAdmin()

  const { data: cat, error: fetchErr } = await supabase
    .from('categories')
    .select('id, salon_id')
    .eq('id', id)
    .single()

  if (fetchErr || !cat) return c.json({ error: 'Categoría no encontrada' }, 404)
  if (cat.salon_id === null) return c.json({ error: 'Las categorías estándar no se pueden eliminar' }, 403)
  if (cat.salon_id !== salonId) return c.json({ error: 'No autorizado' }, 403)

  const { error } = await supabase.from('categories').delete().eq('id', id).eq('salon_id', salonId)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

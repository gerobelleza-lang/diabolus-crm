// @ts-nocheck
/**
 * onboarding.ts — Fase 4, Item 2: Onboarding Wizard endpoints
 *
 * Endpoints (todos bajo /api/onboarding/*):
 *   GET  /api/onboarding/status           — estado actual + info salon + gestor vinculado
 *   PATCH /api/onboarding/step1           — guardar NIF + nombre_fiscal
 *   POST /api/onboarding/logo             — subir logo (multipart/form-data)
 *   GET  /api/onboarding/logo             — URL firmada del logo actual (5 min)
 *   POST /api/onboarding/skip             — saltar paso actual
 *   POST /api/onboarding/complete         — marcar onboarding_completed = true
 *
 * Flujo:
 *   Paso 1 → PATCH /step1 (obligatorio)
 *   Paso 2 → POST /logo  | POST /skip
 *   Paso 3 → cliente conecta Telegram/WhatsApp en la UI | POST /skip
 *   Paso 4 → primera acción en /api/agent/chat → POST /complete
 */

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

export const onboardingRoutes = new Hono()

// ─── Helper: obtener salon_id del JWT ────────────────────────────────────────
async function getSalonFromJWT(c: any): Promise<{ salonId: string; userId: string } | null> {
  const auth = c.req.header('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const supabase = getSupabaseAdmin()
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return null
  const { data: salon } = await supabase
    .from('salons')
    .select('id')
    .eq('user_id', user.id)  // columna correcta
    .single()
  if (!salon) return null
  return { salonId: salon.id, userId: user.id }
}

// ─── GET /api/onboarding/status ───────────────────────────────────────────────
onboardingRoutes.get('/status', async (c) => {
  const ctx = await getSalonFromJWT(c)
  if (!ctx) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: salon } = await supabase
    .from('salons')
    .select('id, name, nif, nombre_fiscal, logo_path, onboarding_completed, onboarding_step')
    .eq('id', ctx.salonId)
    .single()

  if (!salon) return c.json({ error: 'Salon no encontrado' }, 404)

  // ¿Tiene canal vinculado?
  const { data: channelLink } = await supabase
    .from('channel_links')
    .select('id, channel_type')
    .eq('salon_id', ctx.salonId)
    .limit(1)
    .maybeSingle()

  // ¿Tiene gestor vinculado?
  const { data: gestorLink } = await supabase
    .from('gestor_salon_links')
    .select('id, gestores(name, email)')
    .eq('salon_id', ctx.salonId)
    .eq('status', 'active')
    .maybeSingle()

  return c.json({
    onboarding_completed: salon.onboarding_completed,
    onboarding_step: salon.onboarding_step,
    salon: {
      id: salon.id,
      name: salon.name,
      nif: salon.nif ?? null,
      nombre_fiscal: salon.nombre_fiscal ?? null,
      has_logo: !!salon.logo_path,
    },
    channel_linked: !!channelLink,
    channel_type: channelLink?.channel_type ?? null,
    gestor: gestorLink?.gestores
      ? { name: (gestorLink.gestores as any).name, email: (gestorLink.gestores as any).email }
      : null,
  })
})

// ─── PATCH /api/onboarding/step1 ─────────────────────────────────────────────
// Guardar NIF + nombre_fiscal (obligatorio). Avanza a paso 2.
onboardingRoutes.patch('/step1', async (c) => {
  const ctx = await getSalonFromJWT(c)
  if (!ctx) return c.json({ error: 'No autorizado' }, 401)

  const body = await c.req.json().catch(() => ({}))
  const nif = (body.nif ?? '').trim().toUpperCase()
  const nombre_fiscal = (body.nombre_fiscal ?? '').trim()

  if (!nif) return c.json({ error: 'NIF/CIF es obligatorio' }, 400)
  if (!nombre_fiscal) return c.json({ error: 'Nombre fiscal es obligatorio' }, 400)
  if (nif.length < 8 || nif.length > 10) return c.json({ error: 'NIF/CIF inválido (8-10 caracteres)' }, 400)

  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('salons')
    .update({ nif, nombre_fiscal })
    .eq('id', ctx.salonId)

  // Avanzar paso solo si aún está en 1
  await supabase
    .from('salons')
    .update({ onboarding_step: 2 })
    .eq('id', ctx.salonId)
    .lt('onboarding_step', 2)

  if (error) return c.json({ error: 'Error guardando datos' }, 500)

  await supabase.from('audit_log').insert([{
    salon_id: ctx.salonId,
    action: 'onboarding_step1_completed',
    changes: { nif, nombre_fiscal },
    created_at: new Date().toISOString(),
  }])

  return c.json({ ok: true, next_step: 2 })
})

// ─── POST /api/onboarding/logo ────────────────────────────────────────────────
// Subir logo al bucket privado `logos`. Avanza a paso 3.
onboardingRoutes.post('/logo', async (c) => {
  const ctx = await getSalonFromJWT(c)
  if (!ctx) return c.json({ error: 'No autorizado' }, 401)

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: 'Se esperaba multipart/form-data' }, 400)
  }

  const file = formData.get('logo') as File | null
  if (!file) return c.json({ error: 'Campo "logo" requerido' }, 400)

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: 'Tipo no permitido. Usa JPG, PNG, WEBP, GIF o SVG.' }, 400)
  }
  if (file.size > 2 * 1024 * 1024) {
    return c.json({ error: 'El logo no puede superar 2 MB' }, 400)
  }

  const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
  const path = `${ctx.salonId}/logo.${ext}`
  const arrayBuffer = await file.arrayBuffer()

  const supabase = getSupabaseAdmin()

  // Eliminar logo anterior si existe
  const { data: salon } = await supabase
    .from('salons')
    .select('logo_path')
    .eq('id', ctx.salonId)
    .single()
  if (salon?.logo_path) {
    await supabase.storage.from('logos').remove([salon.logo_path])
  }

  const { error: uploadError } = await supabase.storage
    .from('logos')
    .upload(path, arrayBuffer, {
      contentType: file.type,
      upsert: true,
    })

  if (uploadError) {
    console.error('[Onboarding Logo]', uploadError)
    return c.json({ error: 'Error subiendo logo' }, 500)
  }

  await supabase
    .from('salons')
    .update({ logo_path: path })
    .eq('id', ctx.salonId)

  // Avanzar paso si está en 2
  await supabase
    .from('salons')
    .update({ onboarding_step: 3 })
    .eq('id', ctx.salonId)
    .lt('onboarding_step', 3)

  await supabase.from('audit_log').insert([{
    salon_id: ctx.salonId,
    action: 'onboarding_logo_uploaded',
    changes: { path },
    created_at: new Date().toISOString(),
  }])

  return c.json({ ok: true, next_step: 3 })
})

// ─── GET /api/onboarding/logo ─────────────────────────────────────────────────
// Devuelve URL firmada del logo (5 min). Nil si no hay logo.
onboardingRoutes.get('/logo', async (c) => {
  const ctx = await getSalonFromJWT(c)
  if (!ctx) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: salon } = await supabase
    .from('salons')
    .select('logo_path')
    .eq('id', ctx.salonId)
    .single()

  if (!salon?.logo_path) return c.json({ url: null })

  const { data: signed } = await supabase.storage
    .from('logos')
    .createSignedUrl(salon.logo_path, 300) // 5 minutos

  return c.json({ url: signed?.signedUrl ?? null })
})

// ─── POST /api/onboarding/skip ────────────────────────────────────────────────
// Saltar el paso actual (pasos 2, 3 son skippables). Avanza al siguiente.
onboardingRoutes.post('/skip', async (c) => {
  const ctx = await getSalonFromJWT(c)
  if (!ctx) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: salon } = await supabase
    .from('salons')
    .select('onboarding_step, onboarding_completed')
    .eq('id', ctx.salonId)
    .single()

  if (!salon) return c.json({ error: 'Salon no encontrado' }, 404)
  if (salon.onboarding_completed) return c.json({ ok: true, already_complete: true })

  const currentStep = salon.onboarding_step
  if (currentStep === 1) {
    return c.json({ error: 'El paso 1 (NIF + nombre fiscal) es obligatorio y no se puede saltar' }, 400)
  }

  const nextStep = currentStep + 1
  await supabase
    .from('salons')
    .update({ onboarding_step: nextStep })
    .eq('id', ctx.salonId)

  return c.json({ ok: true, next_step: nextStep })
})

// ─── POST /api/onboarding/complete ───────────────────────────────────────────
// Marca onboarding como completado. Se llama tras la primera acción en el chat.
onboardingRoutes.post('/complete', async (c) => {
  const ctx = await getSalonFromJWT(c)
  if (!ctx) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  await supabase
    .from('salons')
    .update({ onboarding_completed: true, onboarding_step: 4 })
    .eq('id', ctx.salonId)

  await supabase.from('audit_log').insert([{
    salon_id: ctx.salonId,
    action: 'onboarding_completed',
    changes: {},
    created_at: new Date().toISOString(),
  }])

  return c.json({ ok: true })
})

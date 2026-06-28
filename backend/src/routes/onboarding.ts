/**
 * onboarding.ts — Onboarding Wizard endpoints
 *
 * Endpoints (todos bajo /api/onboarding/*):
 *   GET  /api/onboarding/status           — estado actual + info salon + gestor vinculado
 *   PATCH /api/onboarding/step1           — guardar NIF + nombre_fiscal
 *   POST /api/onboarding/logo             — subir logo (multipart/form-data)
 *   GET  /api/onboarding/logo             — URL firmada del logo actual (5 min)
 *   POST /api/onboarding/skip             — saltar paso actual
 *   POST /api/onboarding/complete         — marcar onboarding_completed = true
 *
 * Auth: authMiddleware (app.ts) ya valida el JWT y expone c.get('salonId') y c.get('userId').
 */

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string; userEmail: string; gestorId: string; usageWarning: boolean; salon_id: string }


export const onboardingRoutes = new Hono<{ Variables: Variables }>()

// ─── GET /api/onboarding/status ───────────────────────────────────────────────
onboardingRoutes.get('/status', async (c) => {
  const salonId = c.get('salonId')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: salon } = await supabase
    .from('salons')
    .select('id, name, nif, nombre_fiscal, logo_path, onboarding_completed, onboarding_step')
    .eq('id', salonId)
    .single()

  if (!salon) return c.json({ error: 'Salon no encontrado' }, 404)

  // ¿Tiene gestor vinculado?
  const { data: gestorLink } = await supabase
    .from('gestor_salon_links')
    .select('id, gestores(name, email)')
    .eq('salon_id', salonId)
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
    gestor: gestorLink?.gestores
      ? { name: (gestorLink.gestores as any).name, email: (gestorLink.gestores as any).email }
      : null,
  })
})

// ─── PATCH /api/onboarding/step1 ─────────────────────────────────────────────
onboardingRoutes.patch('/step1', async (c) => {
  const salonId = c.get('salonId')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

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
    .eq('id', salonId)

  if (error) return c.json({ error: 'Error guardando datos' }, 500)

  // Avanzar paso solo si aún está en 1
  await supabase
    .from('salons')
    .update({ onboarding_step: 2 })
    .eq('id', salonId)
    .lt('onboarding_step', 2)

  await supabase.from('audit_log').insert([{
    salon_id: salonId,
    action: 'onboarding_step1_completed',
    changes: { nif, nombre_fiscal },
    created_at: new Date().toISOString(),
  }])

  return c.json({ ok: true, next_step: 2 })
})

// ─── POST /api/onboarding/logo ────────────────────────────────────────────────
onboardingRoutes.post('/logo', async (c) => {
  const salonId = c.get('salonId')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

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
  const path = `${salonId}/logo.${ext}`
  const arrayBuffer = await file.arrayBuffer()

  const supabase = getSupabaseAdmin()

  const { data: salon } = await supabase
    .from('salons')
    .select('logo_path')
    .eq('id', salonId)
    .single()
  if (salon?.logo_path) {
    await supabase.storage.from('logos').remove([salon.logo_path])
  }

  const { error: uploadError } = await supabase.storage
    .from('logos')
    .upload(path, arrayBuffer, { contentType: file.type, upsert: true })

  if (uploadError) {
    console.error('[Onboarding Logo]', uploadError)
    return c.json({ error: 'Error subiendo logo' }, 500)
  }

  await supabase.from('salons').update({ logo_path: path }).eq('id', salonId)
  await supabase.from('salons').update({ onboarding_step: 3 }).eq('id', salonId).lt('onboarding_step', 3)

  await supabase.from('audit_log').insert([{
    salon_id: salonId,
    action: 'onboarding_logo_uploaded',
    changes: { path },
    created_at: new Date().toISOString(),
  }])

  return c.json({ ok: true, next_step: 3 })
})

// ─── GET /api/onboarding/logo ─────────────────────────────────────────────────
onboardingRoutes.get('/logo', async (c) => {
  const salonId = c.get('salonId')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: salon } = await supabase
    .from('salons')
    .select('logo_path')
    .eq('id', salonId)
    .single()

  if (!salon?.logo_path) return c.json({ url: null })

  const { data: signed } = await supabase.storage
    .from('logos')
    .createSignedUrl(salon.logo_path, 300)

  return c.json({ url: signed?.signedUrl ?? null })
})

// ─── POST /api/onboarding/skip ────────────────────────────────────────────────
onboardingRoutes.post('/skip', async (c) => {
  const salonId = c.get('salonId')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()
  const { data: salon } = await supabase
    .from('salons')
    .select('onboarding_step, onboarding_completed')
    .eq('id', salonId)
    .single()

  if (!salon) return c.json({ error: 'Salon no encontrado' }, 404)
  if (salon.onboarding_completed) return c.json({ ok: true, already_complete: true })

  const currentStep = salon.onboarding_step
  if (currentStep === 1) {
    return c.json({ error: 'El paso 1 (NIF + nombre fiscal) es obligatorio' }, 400)
  }

  const nextStep = currentStep + 1
  await supabase.from('salons').update({ onboarding_step: nextStep }).eq('id', salonId)

  return c.json({ ok: true, next_step: nextStep })
})

// ─── POST /api/onboarding/complete ───────────────────────────────────────────
onboardingRoutes.post('/complete', async (c) => {
  const salonId = c.get('salonId')
  const userId = c.get('userId')
  const userEmail = c.get('userEmail')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()

  // Get salon info
  const { data: salon } = await supabase
    .from('salons')
    .select('name')
    .eq('id', salonId)
    .single()

  // Mark onboarding complete
  await supabase
    .from('salons')
    .update({ onboarding_completed: true, onboarding_step: 4 })
    .eq('id', salonId)

  await supabase.from('audit_log').insert([{
    salon_id: salonId,
    action: 'onboarding_completed',
    changes: {},
    created_at: new Date().toISOString(),
  }])

  // Send welcome email
  if (userEmail && salon?.name) {
    const RESEND_API_KEY = process.env.RESEND_API_KEY
    const FROM_EMAIL = process.env.FROM_EMAIL || 'Diabolus CRM <noreply@diabolus.es>'

    if (RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: userEmail,
            subject: '¡Bienvenido a Diabolus CRM!',
            html: `
              <h1 style="font-family:sans-serif">¡Hola, ${salon.name}!</h1>
              <p style="font-family:sans-serif;line-height:1.6">Tu negocio ya está listo en <strong>Diabolus CRM</strong>.</p>

              <h2 style="font-family:sans-serif;font-size:1.1rem">Próximos pasos:</h2>
              <ol style="font-family:sans-serif;line-height:1.8">
                <li><strong>Invita clientes:</strong> Agrega tus primeros clientes en el panel</li>
                <li><strong>Crea facturas:</strong> Usa Diablilla para crear facturas por voz</li>
                <li><strong>Configura Cazador:</strong> Activa recordatorios automáticos de cobro</li>
                <li><strong>Chat con Diablilla:</strong> Pregunta: "¿Cuál es mi balance?" o "Crea factura a García"</li>
              </ol>

              <p style="font-family:sans-serif">
                <a href="https://diabolus.es/dashboard.html" style="display:inline-block;padding:0.75rem 1.5rem;background:#8B5CF6;color:white;text-decoration:none;border-radius:0.5rem;font-weight:600">Ir a Diabolus →</a>
              </p>

              <p style="font-family:sans-serif;color:#666;font-size:0.9rem">¿Preguntas? Escribe a <strong>hola@diabolus.es</strong></p>
            `
          }),
        })
      } catch (err) {
        console.error('Error sending welcome email:', err)
      }
    }
  }

  return c.json({ ok: true })
})

// @ts-nocheck
/**
 * usage.ts — Middleware contador de mensajes por salón
 *
 * Flujo:
 *   1. Lee uso del mes actual para el salón
 *   2. Si límite alcanzado → 429 con mensaje de upgrade
 *   3. Si >= 80% → añade warning al contexto
 *   4. Después de respuesta exitosa → incrementa contador
 *
 * Plan limits:
 *   basico:     300 msgs/mes
 *   pro:      1.000 msgs/mes
 *   pro_plus: 3.000 msgs/mes
 *   enterprise:  -1 (ilimitado)
 */

import { createClient } from '@supabase/supabase-js'
import type { Context, Next } from 'hono'

const PLAN_LIMITS: Record<string, number> = {
  basico:     300,
  pro:       1000,
  pro_plus:  3000,
  enterprise:  -1,
}

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function getCurrentYearMonth(): string {
  const now = new Date()
  const y   = now.getFullYear()
  const m   = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/**
 * Devuelve { count, limit, plan } para un salón este mes.
 * Si no existe registro aún → count = 0.
 */
export async function getUsage(salonId: string): Promise<{
  count: number
  limit: number
  plan: string
  pct: number
  remaining: number
}> {
  const supabase  = getSupabase()
  const yearMonth = getCurrentYearMonth()

  // 1. Obtener plan y límite del salón
  const { data: salon } = await supabase
    .from('salons')
    .select('plan, message_limit')
    .eq('id', salonId)
    .single()

  const plan  = salon?.plan || 'basico'
  const limit = salon?.message_limit ?? PLAN_LIMITS[plan] ?? 300

  // 2. Obtener uso del mes actual
  const { data: usage } = await supabase
    .from('salon_message_usage')
    .select('message_count')
    .eq('salon_id', salonId)
    .eq('year_month', yearMonth)
    .single()

  const count     = usage?.message_count ?? 0
  const pct       = limit === -1 ? 0 : Math.round((count / limit) * 100)
  const remaining = limit === -1 ? 999999 : Math.max(0, limit - count)

  return { count, limit, plan, pct, remaining }
}

/**
 * Incrementa el contador en 1 para el mes actual.
 * Usa upsert atómico para thread-safety.
 */
export async function incrementUsage(salonId: string): Promise<void> {
  const supabase  = getSupabase()
  const yearMonth = getCurrentYearMonth()

  try {
    // Upsert: si no existe → crea con count=1; si existe → suma 1
    const { error } = await supabase.rpc('increment_message_count', {
      p_salon_id:   salonId,
      p_year_month: yearMonth,
    })

    if (error) {
      // Fallback: upsert manual (no atómico pero funciona)
      const { data: existing } = await supabase
        .from('salon_message_usage')
        .select('id, message_count')
        .eq('salon_id', salonId)
        .eq('year_month', yearMonth)
        .single()

      if (existing) {
        await supabase
          .from('salon_message_usage')
          .update({
            message_count: existing.message_count + 1,
            updated_at:    new Date().toISOString(),
          })
          .eq('id', existing.id)
      } else {
        await supabase
          .from('salon_message_usage')
          .insert({
            salon_id:      salonId,
            year_month:    yearMonth,
            message_count: 1,
          })
      }
    }
  } catch (err) {
    console.warn('[Usage] incrementUsage failed silently:', err)
  }
}

/**
 * Middleware Hono: checkea límite ANTES de procesar.
 * Añade c.set('usageWarning', true) si >= 80%.
 */
export async function usageLimitMiddleware(c: Context, next: Next) {
  const salonId = c.get('salonId') as string
  if (!salonId) return next()

  try {
    const { count, limit, plan, pct, remaining } = await getUsage(salonId)

    // Enterprise o límite -1 → sin restricción
    if (limit === -1) return next()

    // Límite alcanzado → bloquear
    if (count >= limit) {
      const planNombre = plan === 'basico' ? 'Básico' : plan === 'pro' ? 'Pro' : 'Pro+'
      return c.json({
        status: 'limit_reached',
        message: `Has alcanzado el límite de ${limit} mensajes/mes del plan ${planNombre}.\n\n💡 Amplía tu plan para seguir usando el Agente IA.\n\nContacta con nosotros: hola@diabolus.es`,
        usage: { count, limit, plan, pct, remaining: 0 },
      }, 429)
    }

    // Warning >= 80%
    if (pct >= 80) {
      c.set('usageWarning', { count, limit, remaining, pct })
    }

  } catch (err) {
    // Si falla la comprobación → dejamos pasar (fail open)
    console.warn('[Usage] check failed, allowing request:', err)
  }

  return next()
}

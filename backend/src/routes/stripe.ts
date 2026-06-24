// @ts-nocheck
/**
 * stripe.ts — Módulo de suscripciones Diabolus
 * Edge Runtime ONLY — fetch directo, sin SDK de Stripe
 * Price: price_1Tlwsw1UnR4OJAljw7DR4M2R (€49/mes — El Pacto)
 */
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

const STRIPE_PRICE_ID = 'price_1Tlwsw1UnR4OJAljw7DR4M2R'
const APP_URL         = 'https://diabolus.es'
const SUPABASE_URL_FB = 'https://emygbvxkhfbwyhbapaae.supabase.co'

// ── Helpers ────────────────────────────────────────────────────────────────

function stripeKey(): string {
  return process.env.STRIPE_SECRET_KEY || ''
}
function webhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET || ''
}
function sbUrl(): string {
  return process.env.SUPABASE_URL || SUPABASE_URL_FB
}
function sbKey(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || ''
}

/** Llamada a la API de Stripe (form-encoded) */
async function stripeReq(secret: string, path: string, method: string, body?: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  })
  return res.json()
}

/** Llamada a Supabase REST */
async function sb(url: string, key: string, path: string, opts?: any) {
  return fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...opts?.headers,
    },
    ...opts,
  })
}

/** Verifica el JWT con el SDK de Supabase (igual que authMiddleware) */
async function getUser(token: string) {
  try {
    const supabase = getSupabaseAdmin()
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return null
    return user
  } catch {
    return null
  }
}

/** Verifica la firma del webhook de Stripe (Web Crypto — Edge-safe) */
async function verifyWebhookSig(payload: string, header: string, secret: string): Promise<boolean> {
  try {
    const parts = header.split(',').reduce((acc: any, part) => {
      const [k, v] = part.trim().split('=')
      acc[k] = v
      return acc
    }, {} as Record<string, string>)

    const ts  = parts['t']
    const sig = parts['v1']
    if (!ts || !sig) return false

    const signed = `${ts}.${payload}`
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const buf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signed))
    const expected = Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    if (expected.length !== sig.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
    return diff === 0
  } catch {
    return false
  }
}

// ── Router ─────────────────────────────────────────────────────────────────

export const stripeRoutes = new Hono()

// ── POST /api/stripe/checkout ─────────────────────────────────────────────
stripeRoutes.post('/checkout', async (c) => {
  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '')
    if (!token) return c.json({ error: 'Unauthorized' }, 401)

    const url    = sbUrl()
    const key    = sbKey()
    const secret = stripeKey()

    // Auth con SDK (mismo mecanismo que authMiddleware)
    const user = await getUser(token)
    if (!user?.id) return c.json({ error: 'Invalid token' }, 401)

    // Obtener salón del usuario
    const salonRes = await sb(url, key, `salons?user_id=eq.${user.id}&select=id,name,stripe_customer_id,plan&limit=1`)
    const salons   = await salonRes.json()
    const salon    = Array.isArray(salons) ? salons[0] : null

    if (salon?.plan === 'pacto') {
      return c.json({ error: 'Ya tienes El Pacto activo' }, 400)
    }

    let customerId = salon?.stripe_customer_id
    if (!customerId) {
      const customer = await stripeReq(secret, '/customers', 'POST', {
        email: user.email,
        name: salon?.name || user.email,
        'metadata[user_id]': user.id,
        'metadata[salon_id]': salon?.id || '',
      })
      if (customer.error) {
        console.error('[Stripe] Error creando customer:', customer.error)
        return c.json({ error: 'Error al crear cliente en Stripe' }, 500)
      }
      customerId = customer.id
      // Guardar stripe_customer_id
      await sb(url, key, `salons?user_id=eq.${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ stripe_customer_id: customerId }),
      })
    }

    // Crear sesión de Checkout
    const session = await stripeReq(secret, '/checkout/sessions', 'POST', {
      mode: 'subscription',
      customer: customerId,
      'line_items[0][price]': STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
      'metadata[user_id]': user.id,
      'metadata[salon_id]': salon?.id || '',
      'subscription_data[metadata][user_id]': user.id,
      'subscription_data[metadata][salon_id]': salon?.id || '',
      success_url: `${APP_URL}/dashboard.html?pacto=ok`,
      cancel_url:  `${APP_URL}/dashboard.html?pacto=cancel`,
      'payment_method_types[0]': 'card',
      locale: 'es',
    })

    if (session.error) {
      console.error('[Stripe] Error creando sesión:', session.error)
      return c.json({ error: session.error.message }, 400)
    }

    return c.json({ url: session.url })
  } catch (err: any) {
    console.error('[Stripe /checkout]', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

// ── GET /api/stripe/subscription ──────────────────────────────────────────
stripeRoutes.get('/subscription', async (c) => {
  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '')
    if (!token) return c.json({ error: 'Unauthorized' }, 401)

    const url = sbUrl()
    const key = sbKey()

    const user = await getUser(token)
    if (!user?.id) return c.json({ error: 'Invalid token' }, 401)

    const profileRes = await sb(
      url, key,
      `salons?user_id=eq.${user.id}&select=plan,stripe_customer_id,stripe_subscription_id,plan_expires_at&limit=1`,
    )
    const profiles = await profileRes.json()
    const profile  = Array.isArray(profiles) ? profiles[0] : null

    return c.json({
      plan:            profile?.plan || 'free',
      active:          profile?.plan === 'pacto',
      pacto_activo:    profile?.plan === 'pacto',
      subscription_id: profile?.stripe_subscription_id || null,
      expires_at:      profile?.plan_expires_at || null,
    })
  } catch (err: any) {
    console.error('[Stripe /subscription]', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

// ── POST /api/stripe/webhook ───────────────────────────────────────────────
stripeRoutes.post('/webhook', async (c) => {
  try {
    const sig     = c.req.header('stripe-signature') || ''
    const secret  = webhookSecret()
    const rawBody = await c.req.text()

    if (!(await verifyWebhookSig(rawBody, sig, secret))) {
      console.error('[Stripe Webhook] Firma inválida')
      return c.json({ error: 'Invalid signature' }, 400)
    }

    const event = JSON.parse(rawBody)
    const url   = sbUrl()
    const key   = sbKey()

    const auditEntry = (userId: string, salonId: string | null, action: string, changes: any) =>
      sb(url, key, 'audit_log', {
        method: 'POST',
        body: JSON.stringify({
          user_id:    userId,
          salon_id:   salonId || null,
          action,
          changes,
          created_at: new Date().toISOString(),
        }),
      })

    switch (event.type) {

      // ── Pago completado → activar plan ────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object
        // Buscar userId en session.metadata o subscription_data.metadata
        const userId  = session.metadata?.user_id
        const salonId = session.metadata?.salon_id
        const subId   = session.subscription

        if (userId) {
          await sb(url, key, `salons?user_id=eq.${userId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              plan: 'pacto',
              pacto_activo: true,
              stripe_subscription_id: subId,
              payment_failed: false,
              updated_at: new Date().toISOString(),
            }),
          })
          await auditEntry(userId, salonId, 'stripe_checkout_completed', {
            subscription_id: subId,
            amount_total: session.amount_total,
          })
        }
        break
      }

      // ── Suscripción actualizada ───────────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub    = event.data.object
        const userId = sub.metadata?.user_id
        if (userId) {
          const isActive = ['active', 'trialing'].includes(sub.status)
          await sb(url, key, `salons?user_id=eq.${userId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              plan:                    isActive ? 'pacto' : 'free',
              pacto_activo:            isActive,
              stripe_subscription_id:  sub.id,
              plan_expires_at:         isActive ? null : new Date(sub.current_period_end * 1000).toISOString(),
              payment_failed:          false,
              updated_at:              new Date().toISOString(),
            }),
          })
        }
        break
      }

      // ── Suscripción cancelada ─────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub    = event.data.object
        const userId = sub.metadata?.user_id
        if (userId) {
          await sb(url, key, `salons?user_id=eq.${userId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              plan:           'free',
              pacto_activo:   false,
              plan_expires_at: new Date(sub.current_period_end * 1000).toISOString(),
              updated_at:     new Date().toISOString(),
            }),
          })
          await auditEntry(userId, null, 'stripe_subscription_cancelled', { subscription_id: sub.id })
        }
        break
      }

      // ── Pago OK ───────────────────────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const inv    = event.data.object
        const userId = inv.subscription_details?.metadata?.user_id
        if (userId) {
          await sb(url, key, `salons?user_id=eq.${userId}`, {
            method: 'PATCH',
            body: JSON.stringify({ payment_failed: false, updated_at: new Date().toISOString() }),
          })
          await auditEntry(userId, null, 'stripe_payment_succeeded', {
            amount_paid: inv.amount_paid,
            invoice_id:  inv.id,
          })
        }
        break
      }

      // ── Pago fallido ──────────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const inv    = event.data.object
        const userId = inv.subscription_details?.metadata?.user_id
        if (userId) {
          await sb(url, key, `salons?user_id=eq.${userId}`, {
            method: 'PATCH',
            body: JSON.stringify({ payment_failed: true, updated_at: new Date().toISOString() }),
          })
          await auditEntry(userId, null, 'stripe_payment_failed', {
            amount_due: inv.amount_due,
            invoice_id: inv.id,
          })
        }
        break
      }

      default:
        console.log(`[Stripe Webhook] Evento no manejado: ${event.type}`)
    }

    return c.json({ received: true })
  } catch (err: any) {
    console.error('[Stripe /webhook]', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

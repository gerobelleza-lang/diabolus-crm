/**
 * monitor.ts — Monitor interno de Diabolus
 * 
 * Rutas internas (sin auth de usuario, protegidas por INTERNAL_SECRET):
 *   POST /api/internal/stripe/monitor  — resumen Stripe diario → Telegram
 *   POST /api/internal/diabolus/health — estado general del sistema
 * 
 * Llamado diariamente por Tasklet a las 09:05 (tras el resumen diario).
 */

import { Hono } from 'hono'

export const monitorRoutes = new Hono()

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sbAdmin(c: any) {
  const url = (process.env.SUPABASE_URL as string) || 'https://emygbvxkhfbwyhbapaae.supabase.co'
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY as string) || ''
  return (path: string, opts?: any) =>
    fetch(`${url}/rest/v1/${path}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...opts?.headers,
      },
      ...opts,
    })
}

async function sendTelegram(token: string, chatId: string, text: string) {
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', text }),
  })
}

// ─── POST /api/internal/stripe/monitor ────────────────────────────────────────

monitorRoutes.post('/stripe/monitor', async (c) => {
  try {
    const STRIPE_SECRET = (process.env.STRIPE_SECRET_KEY as string) || ''
    const TG_TOKEN      = (process.env.TELEGRAM_BOT_TOKEN as string) || ''
    const TG_CHAT       = (process.env.TELEGRAM_CHAT_ID as string)   || '8356150792'

    if (!STRIPE_SECRET) {
      return c.json({ error: 'STRIPE_SECRET_KEY not configured' }, 500)
    }

    const sb = sbAdmin(c)

    // ── Stripe: suscripciones activas ─────────────────────────────────────────
    const stripeHeaders = {
      Authorization: `Bearer ${STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }

    const [subActiveRes, subCancelledRes, chargesRes, invoicesFailedRes] = await Promise.all([
      // Suscripciones activas
      fetch('https://api.stripe.com/v1/subscriptions?status=active&limit=100', { headers: stripeHeaders }),
      // Canceladas este mes
      fetch(`https://api.stripe.com/v1/subscriptions?status=canceled&limit=100&created[gte]=${Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000)}`, { headers: stripeHeaders }),
      // Cobros exitosos este mes
      fetch(`https://api.stripe.com/v1/charges?limit=100&created[gte]=${Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000)}`, { headers: stripeHeaders }),
      // Facturas fallidas
      fetch('https://api.stripe.com/v1/invoices?status=open&limit=20', { headers: stripeHeaders }),
    ])

    const [subActive, subCancelled, charges, invoicesFailed] = await Promise.all([
      subActiveRes.json(),
      subCancelledRes.json(),
      chargesRes.json(),
      invoicesFailedRes.json(),
    ])

    // ── Calcular MRR ──────────────────────────────────────────────────────────
    let mrr = 0
    const activeSubs = subActive.data || []
    for (const sub of activeSubs) {
      const items = sub.items?.data || []
      for (const item of items) {
        const amount = item.price?.unit_amount || 0
        const interval = item.price?.recurring?.interval || 'month'
        const qty = item.quantity || 1
        if (interval === 'month') mrr += (amount * qty) / 100
        else if (interval === 'year') mrr += (amount * qty) / 100 / 12
      }
    }

    // ── Cobros fallidos ───────────────────────────────────────────────────────
    const failedCharges = (charges.data || []).filter((ch: any) => ch.status === 'failed')
    const successCharges = (charges.data || []).filter((ch: any) => ch.status === 'succeeded')
    const ingresosMes = successCharges.reduce((sum: number, ch: any) => sum + (ch.amount / 100), 0)

    // ── Supabase: usuarios y salones activos ──────────────────────────────────
    const [salonesRes, usuariosRes] = await Promise.all([
      sb('salons?select=id,nombre,plan,pacto_activo,created_at&order=created_at.desc'),
      sb('auth/users?select=id', { headers: { 'Prefer': 'count=exact' } }),
    ])

    let totalSalones = 0
    let salonesConPacto = 0
    let nuevosEsteMes = 0
    const hoy = new Date()
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1)

    try {
      const salones = await salonesRes.json()
      if (Array.isArray(salones)) {
        totalSalones = salones.length
        salonesConPacto = salones.filter((s: any) => s.pacto_activo).length
        nuevosEsteMes = salones.filter((s: any) => new Date(s.created_at) >= inicioMes).length
      }
    } catch {}

    // ── Construir mensaje Telegram ─────────────────────────────────────────────
    const ahora = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })
    const fecha = new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: 'long' })

    const cancelledThisMonth = (subCancelled.data || []).length
    const openInvoices = (invoicesFailed.data || []).length

    let mensaje = `💰 <b>Stripe Monitor — ${fecha} ${ahora}</b>\n\n`
    mensaje += `<b>MRR actual:</b> €${mrr.toFixed(2)}/mes\n`
    mensaje += `<b>Suscripciones activas:</b> ${activeSubs.length}\n`
    mensaje += `<b>Salones con El Pacto:</b> ${salonesConPacto} / ${totalSalones} total\n`
    mensaje += `<b>Nuevos este mes:</b> ${nuevosEsteMes} salones\n\n`
    mensaje += `<b>Ingresos cobrados (mes):</b> €${ingresosMes.toFixed(2)}\n`
    mensaje += `<b>Cobros fallidos (mes):</b> ${failedCharges.length}\n`
    mensaje += `<b>Facturas Stripe abiertas:</b> ${openInvoices}\n`

    if (cancelledThisMonth > 0) {
      mensaje += `\n⚠️ <b>Cancelaciones este mes:</b> ${cancelledThisMonth}`
    }

    if (failedCharges.length > 0) {
      mensaje += `\n🚨 <b>Hay ${failedCharges.length} cobros fallidos — revisar Stripe dashboard</b>`
    }

    if (activeSubs.length === 0) {
      mensaje += `\n\n💡 Sin suscripciones activas aún — ¡a por el primer cliente!`
    }

    // Enviar a Telegram
    await sendTelegram(TG_TOKEN, TG_CHAT, mensaje)

    return c.json({
      ok: true,
      mrr,
      active_subscriptions: activeSubs.length,
      salones_con_pacto: salonesConPacto,
      total_salones: totalSalones,
      nuevos_este_mes: nuevosEsteMes,
      cobros_fallidos: failedCharges.length,
      cancelaciones_mes: cancelledThisMonth,
    })
  } catch (err: any) {
    console.error('[Monitor/Stripe] Error:', err)
    return c.json({ error: err.message }, 500)
  }
})

// ─── POST /api/internal/diabolus/health ───────────────────────────────────────

monitorRoutes.post('/diabolus/health', async (c) => {
  try {
    const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN as string) || ''
    const TG_CHAT  = (process.env.TELEGRAM_CHAT_ID as string)   || '8356150792'
    const sb = sbAdmin(c)

    // Verificar que los servicios responden
    const checks = await Promise.allSettled([
      // Supabase ping
      sb('salons?limit=1').then(r => ({ name: 'Supabase', ok: r.ok, status: r.status })),
      // Vercel API
      fetch('https://diabolus-crm.vercel.app/health').then(r => ({ name: 'API Vercel', ok: r.ok, status: r.status })),
    ])

    const resultados = checks.map((c, i) => {
      if (c.status === 'fulfilled') return c.value
      return { name: i === 0 ? 'Supabase' : 'API Vercel', ok: false, error: c.reason?.message }
    })

    const allOk = resultados.every(r => r.ok)

    if (!allOk) {
      const problemas = resultados.filter(r => !r.ok).map(r => r.name).join(', ')
      await sendTelegram(TG_TOKEN, TG_CHAT,
        `🚨 <b>Alerta Diabolus Health</b>\n\nServicios con problemas: <b>${problemas}</b>\nRevisar inmediatamente.`
      )
    }

    return c.json({ ok: allOk, checks: resultados })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// @ts-nocheck
/**
 * cobro_entrante.ts — Diablilla avisa cuando llega un cobro en tiempo real
 *
 * Supabase DB Webhook → POST /api/internal/cobro-entrante
 * Se dispara en INSERT sobre la tabla `transactions`
 * Filtra solo ingresos (type = 'ingreso') y notifica por Telegram al dueño del salón
 */

import { Hono } from 'hono'

export const cobroEntranteRoute = new Hono()

cobroEntranteRoute.post('/', async (c) => {
  try {
    const WEBHOOK_SECRET = (c.env as any)?.COBRO_WEBHOOK_SECRET || 'diabolus_cobro_2026'
    const incomingSecret = c.req.header('x-webhook-secret') || c.req.header('x-supabase-secret') || ''

    // Validar secret — Supabase envía el header configurado en el webhook
    if (incomingSecret !== WEBHOOK_SECRET) {
      console.warn('[CobroEntrante] Secret inválido — rechazado')
      return c.json({ error: 'Forbidden' }, 403)
    }

    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    // Supabase DB Webhook payload
    const { type, table, record } = body

    // Solo procesamos INSERT en transactions
    if (type !== 'INSERT' || table !== 'transactions') {
      return c.json({ ok: true, skipped: true })
    }

    if (!record) return c.json({ ok: true, skipped: 'no record' })

    const { id, salon_id, amount, concept, type: txType, client_name, created_at } = record

    // Solo ingresos — ignorar gastos
    if (txType !== 'ingreso') {
      return c.json({ ok: true, skipped: 'not ingreso' })
    }

    const SB_URL = (c.env as any)?.SUPABASE_URL || 'https://emygbvxkhfbwyhbapaae.supabase.co'
    const SB_KEY = (c.env as any)?.SUPABASE_SERVICE_ROLE_KEY || ''
    const TG_TOKEN = (c.env as any)?.TELEGRAM_BOT_TOKEN || '8895422982:AAH__LXR19NuZsZqkIAdxuZNqNCJYA005Xc'

    const sb = (path: string, opts?: any) =>
      fetch(`${SB_URL}/rest/v1/${path}`, {
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          ...opts?.headers,
        },
        ...opts,
      })

    // Buscar el salón para obtener telegram_chat_id y nombre
    let salonNombre = 'tu negocio'
    let chatId = '8356150792' // fallback: Miguel

    if (salon_id) {
      try {
        const r = await sb(`salons?id=eq.${salon_id}&select=name,telegram_chat_id&limit=1`)
        const arr = await r.json()
        const salon = arr?.[0]
        if (salon?.name) salonNombre = salon.name
        if (salon?.telegram_chat_id) chatId = salon.telegram_chat_id
      } catch (e) {
        console.error('[CobroEntrante] Error buscando salón:', e)
      }
    }

    // Formatear importe
    const importe = parseFloat(amount || 0).toFixed(2)
    const concepto = concept || 'Sin concepto'
    const cliente = client_name || 'Cliente desconocido'
    const hora = new Date(created_at || Date.now()).toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Madrid',
    })

    // Elegir emoji y tono según importe
    let emoji = '💰'
    let tono = ''
    const importeNum = parseFloat(importe)
    if (importeNum >= 1000) {
      emoji = '🔥'
      tono = '\n\n*Ese es un buen golpe, Jefe.* 😈'
    } else if (importeNum >= 500) {
      emoji = '💪'
      tono = '\n\n*Así se hace.* 😈'
    } else {
      tono = '\n\n*Que sigan entrando.* 😈'
    }

    const mensaje = `${emoji} *COBRO RECIBIDO — ${hora}*

*${importe}€* acaban de entrar en *${salonNombre}*

👤 Cliente: ${cliente}
📋 Concepto: ${concepto}${tono}

_— Tu Diablilla · diabolus.es_`

    // Enviar por Telegram
    const tgRes = await fetch(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: mensaje,
          parse_mode: 'Markdown',
        }),
      }
    )

    const tgJson = await tgRes.json()
    if (!tgJson.ok) {
      console.error('[CobroEntrante] Telegram error:', tgJson)
    }

    console.log(`[CobroEntrante] Notificado: ${importe}€ — ${concepto} — salón ${salon_id}`)
    return c.json({ ok: true, amount: importe, notified: chatId })
  } catch (err: any) {
    console.error('[CobroEntrante] Error general:', err)
    return c.json({ error: err.message }, 500)
  }
})

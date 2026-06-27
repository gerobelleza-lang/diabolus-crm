/**
 * informe_batalla.ts — Informe de Batalla de la Diablilla
 *
 * Ruta: POST /api/internal/informe-batalla
 * Protegida por INTERNAL_SECRET (header x-internal-secret)
 * 
 * Disparado cada día a las 20:00 Madrid por Tasklet.
 * Recopila el resumen del día y lo envía por Telegram al dueño
 * en el tono de la Diablilla: sarcástica, leal, directa.
 */

import { Hono } from 'hono'

export const informeBatallaRoutes = new Hono()

// ─── Helpers ────────────────────────────────────────────────────────────────

function sbAdmin(c: any) {
  const url = (process.env.SUPABASE_URL as string) || 'https://emygbvxkhfbwyhbapaae.supabase.co'
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY as string) || ''
  return (path: string, opts?: RequestInit) =>
    fetch(`${url}/rest/v1/${path}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(opts?.headers || {}),
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

function hoy(): { inicio: string; fin: string } {
  const now = new Date()
  // Fecha en Madrid
  const madridStr = now.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })
  const [d, m, y] = madridStr.split('/').map(Number)
  const inicio = new Date(y, m - 1, d, 0, 0, 0).toISOString()
  const fin    = new Date(y, m - 1, d, 23, 59, 59).toISOString()
  return { inicio, fin }
}

// ─── POST /api/internal/informe-batalla ─────────────────────────────────────

informeBatallaRoutes.post('/', async (c) => {
  try {
    const INTERNAL_SECRET = (process.env.INTERNAL_SECRET as string) || 'diabolus-internal-2026'
    const TG_TOKEN        = (process.env.TELEGRAM_BOT_TOKEN as string) || '8895422982:AAH__LXR19NuZsZqkIAdxuZNqNCJYA005Xc'
    const TG_CHAT         = (process.env.TELEGRAM_CHAT_ID as string)   || '8356150792'

    // Auth
    const secret = c.req.header('x-internal-secret')
    if (secret !== INTERNAL_SECRET) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const sb = sbAdmin(c)
    const { inicio, fin } = hoy()

    // ── Consultas paralelas ──────────────────────────────────────────────────

    const [
      cobrosHoyRes,
      facturasHoyRes,
      morosasRes,
      facturasVencenRes,
    ] = await Promise.all([
      // Transacciones de tipo ingreso registradas hoy
      sb(`transactions?select=id,amount,description,client_name,status&type=eq.ingreso&created_at=gte.${inicio}&created_at=lte.${fin}&order=created_at.desc`),
      // Facturas emitidas hoy
      sb(`invoices?select=id,total,client_name,status&created_at=gte.${inicio}&created_at=lte.${fin}&order=created_at.desc`),
      // Facturas pendientes/vencidas (morosos)
      sb(`invoices?select=id,total,client_name,due_date,status&status=in.(pendiente,vencida)&order=due_date.asc&limit=5`),
      // Facturas que vencen mañana
      sb(`invoices?select=id,total,client_name,due_date&status=eq.pendiente&due_date=gte.${new Date(Date.now() + 86400000).toISOString().split('T')[0]}&due_date=lt.${new Date(Date.now() + 172800000).toISOString().split('T')[0]}`),
    ])

    let cobrosHoy: any[]       = []
    let facturasHoy: any[]     = []
    let morosas: any[]         = []
    let facturasVencen: any[]  = []

    try { cobrosHoy      = await cobrosHoyRes.json();      if (!Array.isArray(cobrosHoy))      cobrosHoy = [] } catch {}
    try { facturasHoy    = await facturasHoyRes.json();    if (!Array.isArray(facturasHoy))    facturasHoy = [] } catch {}
    try { morosas        = await morosasRes.json();        if (!Array.isArray(morosas))        morosas = [] } catch {}
    try { facturasVencen = await facturasVencenRes.json(); if (!Array.isArray(facturasVencen)) facturasVencen = [] } catch {}

    // ── Métricas ─────────────────────────────────────────────────────────────

    const totalCobrado = cobrosHoy.reduce((s: number, t: any) => s + (parseFloat(t.amount) || 0), 0)
    const totalFacturado = facturasHoy.reduce((s: number, f: any) => s + (parseFloat(f.total) || 0), 0)
    const totalMoroso = morosas.reduce((s: number, f: any) => s + (parseFloat(f.total) || 0), 0)

    // ── Valoración del día ────────────────────────────────────────────────────

    let valoracion = ''
    if (totalCobrado > 500) {
      valoracion = '🔥 <b>Día de victoria.</b> Así me gustan.'
    } else if (totalCobrado > 0) {
      valoracion = '⚡ Algo entró. Pero podemos más.'
    } else if (facturasHoy.length > 0) {
      valoracion = '📤 Hoy enviaste facturas. Ahora toca cobrarlas.'
    } else {
      valoracion = '😈 Día tranquilo. Mañana sin excusas, Jefe.'
    }

    // ── Construir mensaje ─────────────────────────────────────────────────────

    const fecha = new Date().toLocaleDateString('es-ES', {
      timeZone: 'Europe/Madrid',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    })

    let msg = `😈 <b>Informe de Batalla — ${fecha}</b>\n\n`
    msg += `${valoracion}\n\n`

    // Cobros
    if (cobrosHoy.length > 0) {
      msg += `💰 <b>Cobros de hoy:</b> €${totalCobrado.toFixed(2)}\n`
      for (const c of cobrosHoy.slice(0, 3)) {
        msg += `  · ${c.client_name || 'Cliente'}: €${parseFloat(c.amount).toFixed(2)}\n`
      }
      if (cobrosHoy.length > 3) msg += `  · y ${cobrosHoy.length - 3} más\n`
      msg += '\n'
    } else {
      msg += `💰 <b>Cobros hoy:</b> ninguno.\n\n`
    }

    // Facturas emitidas
    if (facturasHoy.length > 0) {
      msg += `📤 <b>Facturas enviadas hoy:</b> ${facturasHoy.length} (€${totalFacturado.toFixed(2)})\n\n`
    }

    // Morosos
    if (morosas.length > 0) {
      msg += `⚠️ <b>Pendiente de cobro:</b> €${totalMoroso.toFixed(2)} en ${morosas.length} factura${morosas.length > 1 ? 's' : ''}\n`
      const peor = morosas[0]
      if (peor) {
        const diasRetraso = peor.due_date
          ? Math.floor((Date.now() - new Date(peor.due_date).getTime()) / 86400000)
          : 0
        if (diasRetraso > 0) {
          msg += `  🔴 ${peor.client_name || 'Desconocido'}: €${parseFloat(peor.total).toFixed(2)} — ${diasRetraso} días de retraso\n`
        }
      }
      msg += '\n'
    }

    // Vencen mañana
    if (facturasVencen.length > 0) {
      msg += `⏰ <b>Vencen mañana:</b> ${facturasVencen.length} factura${facturasVencen.length > 1 ? 's' : ''}\n\n`
    }

    // Cierre
    msg += `—\n`
    if (morosas.length > 0) {
      msg += `Mañana actúo sobre los morosos a las 10:00. Si quieres cambiar algo, dímelo antes.`
    } else {
      msg += `Todo en orden, Jefe. Descansa. Mañana seguimos.`
    }

    // ── Enviar ───────────────────────────────────────────────────────────────

    await sendTelegram(TG_TOKEN, TG_CHAT, msg)

    return c.json({
      ok: true,
      cobros_hoy: cobrosHoy.length,
      total_cobrado: totalCobrado,
      facturas_emitidas: facturasHoy.length,
      morosas: morosas.length,
      total_pendiente: totalMoroso,
    })
  } catch (err: any) {
    console.error('[InformeBatalla] Error:', err)
    return c.json({ error: err.message }, 500)
  }
})

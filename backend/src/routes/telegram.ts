// @ts-nocheck
/**
 * telegram.ts — Adaptador Telegram del núcleo agéntico (Rebanada 4).
 *
 * Este fichero es un adaptador FINO sobre core.ts.
 * Los 7 comandos existentes se mantienen como shortcuts que construyen
 * AgentInput. El cerebro (intenciones, gate, ejecución) vive en core.ts.
 *
 * Seguridad:
 *  - Solo acepta mensajes del TELEGRAM_CHAT_ID autorizado.
 *  - Para multi-tenant futuro: resolveTenant() busca en channel_links.
 *    Si no hay enlace y el chat_id coincide con TELEGRAM_CHAT_ID, usa el primer salon.
 *
 * Confirmación:
 *  - Tarjeta → inline keyboard [✅ Confirmar] [❌ Cancelar]
 *  - callback_query → core(type: 'action_response')
 *
 * Fotos:
 *  - message.photo → descarga vía Telegram Bot API → base64 → core(type: 'image')
 */

import { Hono }                                            from 'hono'
import { getSupabaseAdmin }                                from '../integrations/supabase'
import { processAgentInput, resolveTenant }               from '../agent/core'
import type { AgentOutput }                               from '../agent/core'
import type { ConfirmationCard }                          from '../agent/confirmation'

const telegram    = new Hono()
const telegramBot = new Hono()

// ─── sendTelegramMessage ───────────────────────────────────────────────────────

export async function sendTelegramMessage(
  text: string,
  chatId?: string,
  replyMarkup?: object
): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const cid   = chatId || process.env.TELEGRAM_CHAT_ID
  if (!token || !cid) { console.log('[Telegram Mock]', text); return { ok: true, mock: true } }

  const payload: Record<string, any> = { chat_id: cid, text, parse_mode: 'HTML' }
  if (replyMarkup) payload.reply_markup = replyMarkup

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  })
  return res.json()
}

// ─── answerCallbackQuery ───────────────────────────────────────────────────────

async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ callback_query_id: callbackQueryId, text }),
  })
}

// ─── downloadTelegramPhoto ────────────────────────────────────────────────────

async function downloadTelegramPhoto(
  fileId: string
): Promise<{ base64: string; mime: string } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return null

  // 1. Get file path
  const metaRes  = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)
  const metaData = await metaRes.json()
  const filePath = metaData.result?.file_path
  if (!filePath) return null

  // 2. Download binary
  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  if (!fileRes.ok) return null
  const buffer  = await fileRes.arrayBuffer()

  // 3. Convert to base64 (Edge Runtime compatible)
  const bytes   = new Uint8Array(buffer)
  let binary    = ''
  bytes.forEach(b => binary += String.fromCharCode(b))
  const base64  = btoa(binary)

  // Detect MIME from extension
  const ext    = filePath.split('.').pop()?.toLowerCase() || 'jpg'
  const mime   = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'

  return { base64, mime }
}

// ─── Format confirmation card as Telegram message ────────────────────────────

function formatCardTelegram(card: ConfirmationCard): { text: string; replyMarkup: object } {
  const lines = [
    `📋 <b>${card.summary}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    ...card.fields.map(f => `• <b>${f.label}:</b> ${f.value}`),
  ]

  if (card.preview) {
    lines.push('', '💬 <b>Mensaje a enviar:</b>')
    lines.push(`<i>${card.preview}</i>`)
  }

  lines.push('')
  lines.push('Confirma para ejecutar o cancela para descartar.')

  const replyMarkup = {
    inline_keyboard: [[
      { text: '✅ Confirmar', callback_data: `confirm:${card.pending_action_id}` },
      { text: '❌ Cancelar',  callback_data: `cancel:${card.pending_action_id}`  },
    ]],
  }

  return { text: lines.join('\n'), replyMarkup }
}

// ─── Resolve tenant for Telegram ──────────────────────────────────────────────

async function resolveTelegramTenant(chatId: string): Promise<string | null> {
  // 1. Check channel_links (multi-tenant path)
  const linked = await resolveTenant('telegram', chatId)
  if (linked) return linked

  // 2. Fallback: si es el chat autorizado, usar el primer salon (dev/solo-tenant)
  const allowedChatId = process.env.TELEGRAM_CHAT_ID
  if (chatId !== allowedChatId) return null

  const supabase = getSupabaseAdmin()
  const { data }  = await supabase.from('salons').select('id').limit(1).single()
  return data?.id || null
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

telegramBot.post('/webhook', async (c) => {
  const body = await c.req.json().catch(() => ({}))

  // ── Callback query (botones inline: confirmar/cancelar) ──────────────────
  if (body?.callback_query) {
    const cq     = body.callback_query
    const chatId = String(cq.message?.chat?.id)
    const data   = cq.data || ''

    const tenantId = await resolveTelegramTenant(chatId)
    if (!tenantId) {
      await answerCallback(cq.id, '⛔ No autorizado')
      return c.json({ ok: true })
    }

    const [decision, pendingActionId] = data.split(':')
    if (!pendingActionId || !['confirm', 'cancel'].includes(decision)) {
      await answerCallback(cq.id)
      return c.json({ ok: true })
    }

    await answerCallback(cq.id, decision === 'confirm' ? '⏳ Ejecutando...' : '❌ Cancelando...')

    const output = await processAgentInput({
      tenantId,
      channel:  'telegram',
      type:     'action_response',
      actionResponse: {
        pendingActionId,
        decision: decision as 'confirm' | 'cancel',
      },
    })

    await sendTelegramMessage(output.replyText || 'Listo.', chatId)

    // Editar el mensaje original para eliminar los botones (UX limpia)
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (token && cq.message?.message_id) {
      await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          chat_id:    chatId,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [] },
        }),
      })
    }

    return c.json({ ok: true })
  }

  // ── Message ──────────────────────────────────────────────────────────────
  const message = body?.message
  if (!message) return c.json({ ok: true })

  const chatId  = String(message.chat?.id)
  const rawText = (message.text || message.caption || '').trim()
  const text    = rawText.toLowerCase()

  // Resolver tenant (incluye check de autorización)
  const tenantId = await resolveTelegramTenant(chatId)
  if (!tenantId) {
    console.log(`[TelegramBot] Chat no autorizado o sin enlace: ${chatId}`)
    await sendTelegramMessage(
      '⛔ Este número no está vinculado a ningún negocio en Diabolus.\n\n' +
      'Para vincular tu cuenta, accede a la web y sigue las instrucciones de vinculación.',
      chatId
    )
    return c.json({ ok: true })
  }

  try {

    // ── Foto adjunta → core(type: 'image') ──────────────────────────────
    if (message.photo && message.photo.length > 0) {
      await sendTelegramMessage('🔍 Leyendo el ticket...', chatId)
      // Tomar la foto de mayor resolución (última del array)
      const fileId = message.photo[message.photo.length - 1].file_id
      const photoData = await downloadTelegramPhoto(fileId)

      if (!photoData) {
        await sendTelegramMessage('❌ No pude descargar la foto. Inténtalo de nuevo.', chatId)
        return c.json({ ok: true })
      }

      const output = await processAgentInput({
        tenantId,
        channel:     'telegram',
        type:        'image',
        imageBase64: photoData.base64,
        imageMime:   photoData.mime,
      })

      await sendOutputTelegram(output, chatId)
      return c.json({ ok: true })
    }

    // ── Comandos → shortcuts que construyen AgentInput ───────────────────
    // Los comandos son azúcar sintáctica; el núcleo hace el trabajo real.

    if (text.startsWith('/balance')) {
      const output = await processAgentInput({ tenantId, channel: 'telegram', type: 'text', text: '¿cuál es mi balance?' })
      await sendOutputTelegram(output, chatId)
      return c.json({ ok: true })
    }

    if (text.startsWith('/cobros')) {
      const output = await processAgentInput({ tenantId, channel: 'telegram', type: 'text', text: '¿qué tengo pendiente de cobro?' })
      await sendOutputTelegram(output, chatId)
      return c.json({ ok: true })
    }

    if (text.startsWith('/vencidas')) {
      const output = await processAgentInput({ tenantId, channel: 'telegram', type: 'text', text: '¿qué facturas están vencidas?' })
      await sendOutputTelegram(output, chatId)
      return c.json({ ok: true })
    }

    if (text.startsWith('/quien')) {
      const output = await processAgentInput({ tenantId, channel: 'telegram', type: 'text', text: '¿quién me debe dinero?' })
      await sendOutputTelegram(output, chatId)
      return c.json({ ok: true })
    }

    if (text.startsWith('/reporte')) {
      // El reporte trimestral es más rico; se construye aquí directamente
      await sendTrimestralReport(chatId)
      return c.json({ ok: true })
    }

    if (text.startsWith('/recordatorio')) {
      const arg = rawText.replace(/^\/recordatorio\s*/i, '').trim()
      const naturalText = arg
        ? `manda recordatorio a la factura ${arg}`
        : '¿qué facturas están vencidas para recordar?'
      const output = await processAgentInput({ tenantId, channel: 'telegram', type: 'text', text: naturalText })
      await sendOutputTelegram(output, chatId)
      return c.json({ ok: true })
    }

    if (text.startsWith('/ayuda') || text.startsWith('/start')) {
      await sendTelegramMessage(
        `🤖 <b>Diabolus CRM Bot</b>\n\n` +
        `<b>Consultas</b>\n` +
        `/balance — Ingresos, gastos y balance del mes\n` +
        `/cobros — Pendientes de cobro con nombres\n` +
        `/vencidas — Facturas vencidas con detalle\n` +
        `/quien — Quién te debe dinero\n` +
        `/reporte — Resumen trimestral + estimación fiscal\n\n` +
        `<b>Cobros inteligentes</b>\n` +
        `/recordatorio — Facturas vencidas listas para recordar\n` +
        `/recordatorio FAC-001 — Envía recordatorio por WhatsApp\n\n` +
        `<b>Registrar (lenguaje natural + foto)</b>\n` +
        `• "Cobré 300€ de María" → guarda ingreso con confirmación\n` +
        `• "Gasté 80€ en materiales" → guarda gasto con confirmación\n` +
        `• Envía una foto de ticket → extrae y confirma\n\n` +
        `/ayuda — Esta ayuda`,
        chatId
      )
      return c.json({ ok: true })
    }

    // ── Lenguaje natural (no es comando) → core ──────────────────────────
    if (!text.startsWith('/')) {
      const output = await processAgentInput({ tenantId, channel: 'telegram', type: 'text', text: rawText })
      await sendOutputTelegram(output, chatId)
      return c.json({ ok: true })
    }

    // ── Comando desconocido ──────────────────────────────────────────────
    await sendTelegramMessage('Comando no reconocido. Escribe /ayuda para ver los comandos.', chatId)

  } catch (err) {
    console.error('[TelegramBot] Error:', err)
    await sendTelegramMessage('❌ Error interno. Inténtalo de nuevo.', chatId)
  }

  return c.json({ ok: true })
})

// ─── sendOutputTelegram — formatea AgentOutput para Telegram ─────────────────

async function sendOutputTelegram(output: AgentOutput, chatId: string): Promise<void> {
  if (output.card) {
    const { text, replyMarkup } = formatCardTelegram(output.card)
    await sendTelegramMessage(text, chatId, replyMarkup)
  } else if (output.needsInfo) {
    await sendTelegramMessage(output.needsInfo, chatId)
  } else if (output.replyText) {
    await sendTelegramMessage(output.replyText, chatId)
  }
}

// ─── Reporte trimestral (mantiene lógica rica existente) ─────────────────────

async function sendTrimestralReport(chatId: string): Promise<void> {
  const supabase   = getSupabaseAdmin()
  const now        = new Date()
  const year       = now.getFullYear()
  const quarter    = Math.ceil((now.getMonth() + 1) / 3)
  const startMonth = (quarter - 1) * 3 + 1
  const endMonth   = quarter * 3
  const startDate  = `${year}-${String(startMonth).padStart(2, '0')}-01`
  const lastDay    = new Date(year, endMonth, 0).getDate()
  const endDate    = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const quarterNames = ['', 'T1 (Ene–Mar)', 'T2 (Abr–Jun)', 'T3 (Jul–Sep)', 'T4 (Oct–Dic)']

  const [{ data: txData }, { data: invData }] = await Promise.all([
    supabase.from('transactions').select('amount, type').gte('date', startDate).lte('date', endDate),
    supabase.from('invoices').select('total, status').gte('issue_date', startDate).lte('issue_date', endDate),
  ])

  const ingresos  = (txData  || []).filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0)
  const gastos    = (txData  || []).filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0)
  const beneficio = ingresos - gastos
  const ivaLiquidar = (ingresos * 0.21) - (gastos * 0.21)
  const irpf        = beneficio > 0 ? beneficio * 0.20 : 0
  const cobradas    = (invData || []).filter(i => i.status === 'paid').length
  const pendientes  = (invData || []).filter(i => ['pending', 'sent'].includes(i.status)).length
  const vencidas    = (invData || []).filter(i => i.status === 'overdue').length
  const sign        = (n: number) => n >= 0 ? '✅' : '🔴'

  await sendTelegramMessage(
    `📊 <b>Informe ${quarterNames[quarter]} ${year}</b>\n\n` +
    `<b>Económico</b>\n` +
    `💚 Ingresos: <b>${ingresos.toFixed(2)}€</b>\n` +
    `🔴 Gastos: <b>${gastos.toFixed(2)}€</b>\n` +
    `${sign(beneficio)} Beneficio neto: <b>${beneficio.toFixed(2)}€</b>\n\n` +
    `<b>Estimación fiscal</b>\n` +
    `🏛 IVA a liquidar (Mod. 303): <b>${ivaLiquidar.toFixed(2)}€</b>\n` +
    `🏛 IRPF fracciones (Mod. 130): <b>${irpf.toFixed(2)}€</b>\n\n` +
    `<b>Facturas</b>\n` +
    `✅ Cobradas: ${cobradas}  ⏳ Pendientes: ${pendientes}  🔴 Vencidas: ${vencidas}\n\n` +
    `<i>Datos orientativos. PDF en: /api/reports/trimestral</i>`,
    chatId
  )
}

// ─── Rutas de notificación (N8N / sistema interno) ────────────────────────────

telegram.post('/payment-received', async (c) => {
  const { client_name, amount, invoice_id } = await c.req.json()
  await sendTelegramMessage(`✅ <b>Cobro recibido</b>\n\n👤 ${client_name}\n💶 ${amount}€\n🧾 #${invoice_id}`)
  return c.json({ success: true })
})

telegram.post('/invoice-pending', async (c) => {
  const { client_name, amount, days_overdue, invoice_id } = await c.req.json()
  await sendTelegramMessage(`⚠️ <b>Factura pendiente</b>\n\n👤 ${client_name}\n💶 ${amount}€\n📅 ${days_overdue} días\n🧾 #${invoice_id}`)
  return c.json({ success: true })
})

telegram.post('/new-client', async (c) => {
  const { client_name, phone, email } = await c.req.json()
  await sendTelegramMessage(`🆕 <b>Nuevo cliente</b>\n\n👤 ${client_name}\n📱 ${phone || 'Sin teléfono'}\n📧 ${email || 'Sin email'}`)
  return c.json({ success: true })
})

telegram.post('/daily-summary', async (c) => {
  const { total_income, total_invoices, pending_invoices, new_clients } = await c.req.json()
  const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
  await sendTelegramMessage(
    `📊 <b>Resumen del día — ${today}</b>\n\n💶 ${total_income}€\n🧾 ${total_invoices}\n⏳ ${pending_invoices}\n🆕 ${new_clients}`
  )
  return c.json({ success: true })
})

telegram.post('/system-alert', async (c) => {
  const { error, context } = await c.req.json()
  await sendTelegramMessage(`🚨 <b>Alerta</b>\n\n❌ ${error}\n📍 ${context}`)
  return c.json({ success: true })
})

export default sendTelegramMessage
export const telegramRoutes    = telegram
export const telegramBotRoutes = telegramBot

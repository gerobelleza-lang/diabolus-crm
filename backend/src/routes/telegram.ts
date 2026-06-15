// @ts-nocheck
// backend/src/routes/telegram.ts
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

const telegram = new Hono()
const telegramBot = new Hono()

// ─── Helper: enviar mensaje a Telegram ────────────────────────────────────────
export async function sendTelegramMessage(text: string, chatId?: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const cid = chatId || process.env.TELEGRAM_CHAT_ID

  if (!token || !cid) {
    console.log('[Telegram Mock]', text)
    return { ok: true, mock: true }
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cid, text, parse_mode: 'HTML' }),
  })

  return res.json()
}

// ─── Bot Webhook — recibe mensajes de Telegram ────────────────────────────────
telegramBot.post('/webhook', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const message = body?.message
  if (!message) return c.json({ ok: true })

  const chatId = String(message.chat?.id)
  const text = (message.text || '').trim().toLowerCase()

  // Seguridad: solo responder al chat autorizado (Miguel)
  const allowedChatId = process.env.TELEGRAM_CHAT_ID
  if (chatId !== allowedChatId) {
    console.log(`[TelegramBot] Mensaje de chat no autorizado: ${chatId}`)
    return c.json({ ok: true })
  }

  const supabase = getSupabaseAdmin()
  const now = new Date()
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const todayISO = now.toISOString()

  try {
    // /balance — ingresos, gastos y balance del mes
    if (text.startsWith('/balance')) {
      const { data: transactions } = await supabase
        .from('transactions')
        .select('amount, type')
        .gte('date', firstOfMonth)

      let income = 0, expenses = 0
      for (const t of (transactions || [])) {
        if (t.type === 'income') income += Number(t.amount)
        else expenses += Number(t.amount)
      }
      const balance = income - expenses
      const mes = now.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })

      if (!transactions || transactions.length === 0) {
        await sendTelegramMessage(`📊 <b>Balance — ${mes}</b>\n\nNo hay transacciones registradas este mes.`, chatId)
      } else {
        await sendTelegramMessage(
          `📊 <b>Balance — ${mes}</b>\n\n💚 Ingresos: <b>${income.toFixed(2)}€</b>\n🔴 Gastos: <b>${expenses.toFixed(2)}€</b>\n───────────────\n💰 Balance neto: <b>${balance.toFixed(2)}€</b>`,
          chatId
        )
      }
    }

    // /cobros — total pendiente de cobro
    else if (text.startsWith('/cobros')) {
      const { data: invoices } = await supabase
        .from('invoices')
        .select('total')
        .in('status', ['pending', 'sent'])

      const count = (invoices || []).length
      const total = (invoices || []).reduce((s, i) => s + Number(i.total), 0)

      if (count === 0) {
        await sendTelegramMessage('✅ No hay cobros pendientes registrados.', chatId)
      } else {
        await sendTelegramMessage(
          `⏳ <b>Cobros pendientes</b>\n\n📋 Facturas: <b>${count}</b>\n💶 Total pendiente: <b>${total.toFixed(2)}€</b>`,
          chatId
        )
      }
    }

    // /vencidas — facturas vencidas
    else if (text.startsWith('/vencidas')) {
      const { data: invoices } = await supabase
        .from('invoices')
        .select('total, due_date')
        .in('status', ['pending', 'sent'])
        .lt('due_date', todayISO)

      const count = (invoices || []).length
      const total = (invoices || []).reduce((s, i) => s + Number(i.total), 0)

      if (count === 0) {
        await sendTelegramMessage('✅ No hay facturas vencidas.', chatId)
      } else {
        const lines = (invoices || []).map(i => {
          const days = Math.floor((now.getTime() - new Date(i.due_date).getTime()) / 86400000)
          return `• ${Number(i.total).toFixed(2)}€ — vencida hace <b>${days} días</b>`
        })
        await sendTelegramMessage(
          `🔴 <b>Facturas vencidas</b>\n\n${lines.join('\n')}\n───────────────\n💶 Total en riesgo: <b>${total.toFixed(2)}€</b>`,
          chatId
        )
      }
    }

    // /quien — quién te debe dinero
    else if (text.startsWith('/quien')) {
      const { data: invoices } = await supabase
        .from('invoices')
        .select('total, due_date, clients(name)')
        .in('status', ['pending', 'sent'])

      if (!invoices || invoices.length === 0) {
        await sendTelegramMessage('✅ Nadie te debe dinero ahora mismo.', chatId)
      } else {
        const lines = invoices.map(i => {
          const name = i.clients?.name || 'Sin nombre'
          const amount = Number(i.total).toFixed(2)
          const overdue = i.due_date && new Date(i.due_date) < now ? ' 🔴' : ''
          return `• ${name} — <b>${amount}€</b>${overdue}`
        })
        const totalDeuda = invoices.reduce((s, i) => s + Number(i.total), 0)
        await sendTelegramMessage(
          `👥 <b>Quién te debe dinero</b>\n\n${lines.join('\n')}\n───────────────\n💶 Total: <b>${totalDeuda.toFixed(2)}€</b>\n\n🔴 = factura vencida`,
          chatId
        )
      }
    }

    // /ayuda o /start
    else if (text.startsWith('/ayuda') || text.startsWith('/start')) {
      await sendTelegramMessage(
        `🤖 <b>Diabolus CRM Bot</b>\n\nComandos disponibles:\n\n/balance — Ingresos, gastos y balance del mes\n/cobros — Total pendiente de cobro\n/vencidas — Facturas vencidas\n/quien — Quién te debe dinero\n/ayuda — Esta ayuda`,
        chatId
      )
    }

    // Comando desconocido
    else {
      await sendTelegramMessage(
        `No entiendo ese comando.\n\nEscribe /ayuda para ver los disponibles.`,
        chatId
      )
    }
  } catch (err) {
    console.error('[TelegramBot] Error:', err)
    await sendTelegramMessage('❌ Error interno. Inténtalo de nuevo.', chatId)
  }

  return c.json({ ok: true })
})

// ─── Rutas de notificación (protegidas, para N8N / sistema interno) ───────────

// ✅ Cobro recibido
telegram.post('/payment-received', async (c) => {
  const { client_name, amount, invoice_id } = await c.req.json()
  const message = `✅ <b>Cobro recibido</b>\n\n👤 Cliente: ${client_name}\n💶 Importe: ${amount}€\n🧾 Factura: #${invoice_id}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

// ⚠️ Factura pendiente
telegram.post('/invoice-pending', async (c) => {
  const { client_name, amount, days_overdue, invoice_id } = await c.req.json()
  const message = `⚠️ <b>Factura pendiente</b>\n\n👤 Cliente: ${client_name}\n💶 Importe: ${amount}€\n📅 Días de retraso: ${days_overdue}\n🧾 Factura: #${invoice_id}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

// 🆕 Nuevo cliente
telegram.post('/new-client', async (c) => {
  const { client_name, phone, email } = await c.req.json()
  const message = `🆕 <b>Nuevo cliente registrado</b>\n\n👤 ${client_name}\n📱 ${phone || 'Sin teléfono'}\n📧 ${email || 'Sin email'}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

// 📊 Resumen diario
telegram.post('/daily-summary', async (c) => {
  const { total_income, total_invoices, pending_invoices, new_clients } = await c.req.json()
  const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
  const message = `📊 <b>Resumen del día — ${today}</b>\n\n💶 Ingresos: ${total_income}€\n🧾 Facturas emitidas: ${total_invoices}\n⏳ Pendientes: ${pending_invoices}\n🆕 Nuevos clientes: ${new_clients}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

// 🚨 Alerta del sistema
telegram.post('/system-alert', async (c) => {
  const { error, context } = await c.req.json()
  const message = `🚨 <b>Alerta del sistema</b>\n\n❌ ${error}\n📍 Contexto: ${context}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

export { sendTelegramMessage as default }
export const telegramRoutes = telegram
export const telegramBotRoutes = telegramBot

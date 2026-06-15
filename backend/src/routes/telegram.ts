// @ts-nocheck
// backend/src/routes/telegram.ts
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { parseUserInput } from '../agent/parser'
import { saveTransaction } from './agent'
import { sendReminderWhatsApp } from './invoices'

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
  const rawText = (message.text || '').trim()
  const text = rawText.toLowerCase()

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
    // ── /balance ────────────────────────────────────────────────────────────
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

      const msg = (!transactions || transactions.length === 0)
        ? `📊 <b>Balance — ${mes}</b>\n\nNo hay transacciones registradas este mes.`
        : `📊 <b>Balance — ${mes}</b>\n\n💚 Ingresos: <b>${income.toFixed(2)}€</b>\n🔴 Gastos: <b>${expenses.toFixed(2)}€</b>\n───────────────\n💰 Balance neto: <b>${balance.toFixed(2)}€</b>`
      await sendTelegramMessage(msg, chatId)
    }

    // ── /cobros ─────────────────────────────────────────────────────────────
    else if (text.startsWith('/cobros')) {
      const { data: invoices } = await supabase
        .from('invoices')
        .select('total, clients(name)')
        .in('status', ['pending', 'sent'])

      const count = (invoices || []).length
      const total = (invoices || []).reduce((s, i) => s + Number(i.total), 0)

      const msg = count === 0
        ? '✅ No hay cobros pendientes registrados.'
        : (() => {
            const lines = (invoices || []).map(i => {
              const name = i.clients?.name || 'Sin nombre'
              return `• ${name} — <b>${Number(i.total).toFixed(2)}€</b>`
            })
            return `⏳ <b>Cobros pendientes</b>\n\n${lines.join('\n')}\n───────────────\n💶 Total: <b>${total.toFixed(2)}€</b>`
          })()
      await sendTelegramMessage(msg, chatId)
    }

    // ── /vencidas ────────────────────────────────────────────────────────────
    else if (text.startsWith('/vencidas')) {
      const { data: invoices } = await supabase
        .from('invoices')
        .select('id, number, total, due_date, clients(name)')
        .in('status', ['pending', 'sent'])
        .lt('due_date', todayISO)
        .order('due_date', { ascending: true })

      const count = (invoices || []).length
      const total = (invoices || []).reduce((s, i) => s + Number(i.total), 0)

      const msg = count === 0
        ? '✅ No hay facturas vencidas.'
        : (() => {
            const lines = (invoices || []).map(i => {
              const days = Math.floor((now.getTime() - new Date(i.due_date).getTime()) / 86400000)
              const name = i.clients?.name || 'Sin nombre'
              const num = i.number || i.id.slice(0, 8).toUpperCase()
              return `🔴 <b>${name}</b> — ${Number(i.total).toFixed(2)}€\n   ${num} · hace ${days} días`
            })
            return (
              `🔴 <b>Facturas vencidas (${count})</b>\n\n` +
              lines.join('\n\n') +
              `\n\n───────────────\n💶 Total en riesgo: <b>${total.toFixed(2)}€</b>\n\n` +
              `💡 Envía un recordatorio: <code>/recordatorio [nº factura]</code>`
            )
          })()
      await sendTelegramMessage(msg, chatId)
    }

    // ── /quien ───────────────────────────────────────────────────────────────
    else if (text.startsWith('/quien')) {
      const { data: invoices } = await supabase
        .from('invoices')
        .select('total, due_date, clients(name)')
        .in('status', ['pending', 'sent'])

      const msg = (!invoices || invoices.length === 0)
        ? '✅ Nadie te debe dinero ahora mismo.'
        : (() => {
            const lines = invoices.map(i => {
              const name = i.clients?.name || 'Sin nombre'
              const amount = Number(i.total).toFixed(2)
              const overdue = i.due_date && new Date(i.due_date) < now ? ' 🔴' : ''
              return `• ${name} — <b>${amount}€</b>${overdue}`
            })
            const totalDeuda = invoices.reduce((s, i) => s + Number(i.total), 0)
            return `👥 <b>Quién te debe dinero</b>\n\n${lines.join('\n')}\n───────────────\n💶 Total: <b>${totalDeuda.toFixed(2)}€</b>\n\n🔴 = factura vencida`
          })()
      await sendTelegramMessage(msg, chatId)
    }

    // ── /recordatorio ────────────────────────────────────────────────────────
    else if (text.startsWith('/recordatorio')) {
      const arg = rawText.replace(/^\/recordatorio\s*/i, '').trim()

      if (!arg) {
        // Sin argumento: mostrar facturas vencidas con sus números
        const { data: invoices } = await supabase
          .from('invoices')
          .select('id, number, total, due_date, clients(name)')
          .in('status', ['pending', 'sent'])
          .lt('due_date', todayISO)
          .order('due_date', { ascending: true })

        if (!invoices || invoices.length === 0) {
          await sendTelegramMessage('✅ No hay facturas vencidas para recordar.', chatId)
        } else {
          const lines = invoices.map(i => {
            const name = i.clients?.name || 'Sin nombre'
            const num = i.number || i.id.slice(0, 8).toUpperCase()
            const days = Math.floor((now.getTime() - new Date(i.due_date).getTime()) / 86400000)
            return `• <code>${num}</code> — ${name} — ${Number(i.total).toFixed(2)}€ (${days}d)`
          })
          await sendTelegramMessage(
            `📋 <b>Facturas vencidas — elige una:</b>\n\n${lines.join('\n')}\n\n` +
            `Usa: <code>/recordatorio [número]</code>\nEj: <code>/recordatorio ${invoices[0].number || 'FAC-001'}</code>`,
            chatId
          )
        }
      } else {
        // Con argumento: buscar la factura por número y enviar recordatorio
        const { data: invoice } = await supabase
          .from('invoices')
          .select('*, clients(name, phone), salons(name)')
          .ilike('number', `%${arg}%`)
          .in('status', ['pending', 'sent'])
          .limit(1)
          .single()

        if (!invoice) {
          await sendTelegramMessage(
            `❌ No encontré ninguna factura pendiente con el número <b>${arg}</b>.\n\nUsa /recordatorio sin argumentos para ver la lista.`,
            chatId
          )
        } else {
          const clientName = invoice.clients?.name || 'cliente'
          const invoiceNum = invoice.number || arg
          const total = Number(invoice.total ?? 0)

          if (!invoice.clients?.phone) {
            await sendTelegramMessage(
              `⚠️ <b>${clientName}</b> no tiene teléfono registrado.\nNo se puede enviar el recordatorio por WhatsApp.`,
              chatId
            )
          } else {
            // Confirmar antes de enviar
            await sendTelegramMessage(
              `📤 Enviando recordatorio a <b>${clientName}</b>...\n` +
              `📄 Factura: ${invoiceNum} — 💶 ${total.toFixed(2)}€`,
              chatId
            )

            const result = await sendReminderWhatsApp(invoice)

            if (result.sent) {
              await sendTelegramMessage(
                `✅ <b>Recordatorio enviado</b>\n\n` +
                `👤 ${clientName}\n📄 ${invoiceNum} — ${total.toFixed(2)}€\n📱 ${result.phone}`,
                chatId
              )
            } else {
              await sendTelegramMessage(
                `❌ No se pudo enviar por WhatsApp.\nMotivo: ${result.error || 'Error desconocido'}`,
                chatId
              )
            }
          }
        }
      }
    }

    // ── /ayuda o /start ──────────────────────────────────────────────────────
    else if (text.startsWith('/ayuda') || text.startsWith('/start')) {
      await sendTelegramMessage(
        `🤖 <b>Diabolus CRM Bot</b>\n\n` +
        `<b>Consultas</b>\n` +
        `/balance — Ingresos, gastos y balance del mes\n` +
        `/cobros — Pendientes de cobro con nombres\n` +
        `/vencidas — Facturas vencidas con detalle\n` +
        `/quien — Quién te debe dinero\n\n` +
        `<b>Cobros inteligentes</b>\n` +
        `/recordatorio — Lista vencidas listas para recordar\n` +
        `/recordatorio FAC-001 — Envía WhatsApp al cliente\n\n` +
        `<b>Registrar (lenguaje natural)</b>\n` +
        `• "Cobré 300€ de María" → guarda ingreso\n` +
        `• "Gasté 80€ en materiales" → guarda gasto\n\n` +
        `/ayuda — Esta ayuda`,
        chatId
      )
    }

    // ── Lenguaje natural (no es comando) ─────────────────────────────────────
    else if (!text.startsWith('/')) {
      const parsed = parseUserInput(rawText)

      if (parsed.intent === 'create_income' && parsed.data.amount > 0) {
        const { data: salon } = await supabase.from('salons').select('id').limit(1).single()
        const salonId = salon?.id || null

        const description = parsed.data.clientName && parsed.data.clientName !== 'Cliente'
          ? `${parsed.data.concept} — ${parsed.data.clientName}`
          : parsed.data.concept

        const result = await saveTransaction({
          amount: parsed.data.amount,
          type: 'income',
          description,
          salonId,
        })

        if (result.ok) {
          await sendTelegramMessage(
            `✅ <b>Ingreso guardado</b>\n\n💶 Importe: <b>${parsed.data.amount.toFixed(2)}€</b>\n📝 Concepto: ${description}\n📅 Fecha: ${new Date().toLocaleDateString('es-ES')}\n\nYa está en tu balance del mes.`,
            chatId
          )
        } else {
          await sendTelegramMessage(`❌ No se pudo guardar el ingreso: ${result.error}`, chatId)
        }
      }

      else if (parsed.intent === 'create_expense' && parsed.data.amount > 0) {
        const { data: salon } = await supabase.from('salons').select('id').limit(1).single()
        const salonId = salon?.id || null

        const result = await saveTransaction({
          amount: parsed.data.amount,
          type: 'expense',
          description: parsed.data.concept,
          salonId,
        })

        if (result.ok) {
          await sendTelegramMessage(
            `✅ <b>Gasto guardado</b>\n\n💶 Importe: <b>${parsed.data.amount.toFixed(2)}€</b>\n📝 Concepto: ${parsed.data.concept}\n📅 Fecha: ${new Date().toLocaleDateString('es-ES')}\n\nYa está en tus gastos del mes.`,
            chatId
          )
        } else {
          await sendTelegramMessage(`❌ No se pudo guardar el gasto: ${result.error}`, chatId)
        }
      }

      else if (parsed.intent.startsWith('query_')) {
        const map: Record<string, string> = {
          query_balance: '/balance',
          query_debtors: '/cobros',
          query_overdue: '/vencidas',
          query_who_owes: '/quien',
        }
        const cmd = map[parsed.intent]
        if (cmd) {
          await sendTelegramMessage(`💡 Para eso puedes usar el comando ${cmd}`, chatId)
        } else {
          await sendTelegramMessage(`No entiendo esa consulta.\n\nEscribe /ayuda para ver qué puedo hacer.`, chatId)
        }
      }

      else {
        await sendTelegramMessage(
          `No he entendido el importe. Prueba así:\n• "Cobré 300€ de Juan"\n• "Gasté 80€ en materiales"\n\nO escribe /ayuda para ver los comandos.`,
          chatId
        )
      }
    }

    // ── Comando desconocido ──────────────────────────────────────────────────
    else {
      await sendTelegramMessage(`Comando no reconocido.\nEscribe /ayuda para ver qué puedo hacer.`, chatId)
    }

  } catch (err) {
    console.error('[TelegramBot] Error:', err)
    await sendTelegramMessage('❌ Error interno. Inténtalo de nuevo.', chatId)
  }

  return c.json({ ok: true })
})

// ─── Rutas de notificación (protegidas, para N8N / sistema interno) ───────────

telegram.post('/payment-received', async (c) => {
  const { client_name, amount, invoice_id } = await c.req.json()
  const message = `✅ <b>Cobro recibido</b>\n\n👤 Cliente: ${client_name}\n💶 Importe: ${amount}€\n🧾 Factura: #${invoice_id}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

telegram.post('/invoice-pending', async (c) => {
  const { client_name, amount, days_overdue, invoice_id } = await c.req.json()
  const message = `⚠️ <b>Factura pendiente</b>\n\n👤 Cliente: ${client_name}\n💶 Importe: ${amount}€\n📅 Días de retraso: ${days_overdue}\n🧾 Factura: #${invoice_id}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

telegram.post('/new-client', async (c) => {
  const { client_name, phone, email } = await c.req.json()
  const message = `🆕 <b>Nuevo cliente registrado</b>\n\n👤 ${client_name}\n📱 ${phone || 'Sin teléfono'}\n📧 ${email || 'Sin email'}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

telegram.post('/daily-summary', async (c) => {
  const { total_income, total_invoices, pending_invoices, new_clients } = await c.req.json()
  const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
  const message = `📊 <b>Resumen del día — ${today}</b>\n\n💶 Ingresos: ${total_income}€\n🧾 Facturas emitidas: ${total_invoices}\n⏳ Pendientes: ${pending_invoices}\n🆕 Nuevos clientes: ${new_clients}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

telegram.post('/system-alert', async (c) => {
  const { error, context } = await c.req.json()
  const message = `🚨 <b>Alerta del sistema</b>\n\n❌ ${error}\n📍 Contexto: ${context}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

export { sendTelegramMessage as default }
export const telegramRoutes = telegram
export const telegramBotRoutes = telegramBot

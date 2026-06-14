// backend/src/routes/telegram.ts
import { Hono } from 'hono'

const telegram = new Hono()

async function sendTelegramMessage(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!token || !chatId) {
    console.log('[Telegram Mock]', text)
    return { ok: true, mock: true }
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  })

  return res.json()
}

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

export { sendTelegramMessage }
export const telegramRoutes = telegram

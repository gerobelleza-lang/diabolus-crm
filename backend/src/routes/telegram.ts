// backend/src/routes/telegram.ts
import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'

const app = new Hono()

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!

export async function sendTelegramMessage(text: string, chatId?: string) {
  const targetChatId = chatId || TELEGRAM_CHAT_ID

  if (!TELEGRAM_BOT_TOKEN || !targetChatId) {
    console.log('[Telegram Mock]', text)
    return { ok: true, mock: true }
  }

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: targetChatId,
      text,
      parse_mode: 'HTML',
    }),
  })

  return res.json()
}

// ✅ Cobro recibido
app.post('/payment-received', authMiddleware, async (c) => {
  const { client_name, amount, invoice_id } = await c.req.json()
  const message = `✅ <b>Cobro recibido</b>\n\n👤 Cliente: ${client_name}\n💶 Importe: ${amount}€\n🧾 Factura: #${invoice_id}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

// ⚠️ Factura pendiente
app.post('/invoice-pending', authMiddleware, async (c) => {
  const { client_name, amount, days_overdue, invoice_id } = await c.req.json()
  const message = `⚠️ <b>Factura pendiente</b>\n\n👤 Cliente: ${client_name}\n💶 Importe: ${amount}€\n📅 Días de retraso: ${days_overdue}\n🧾 Factura: #${invoice_id}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

// 🆕 Nuevo cliente
app.post('/new-client', authMiddleware, async (c) => {
  const { client_name, phone, email } = await c.req.json()
  const message = `🆕 <b>Nuevo cliente registrado</b>\n\n👤 ${client_name}\n📱 ${phone || 'Sin teléfono'}\n📧 ${email || 'Sin email'}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

// 📊 Resumen diario
app.post('/daily-summary', authMiddleware, async (c) => {
  const { total_income, total_invoices, pending_invoices, new_clients } = await c.req.json()
  const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
  const message = `📊 <b>Resumen del día — ${today}</b>\n\n💶 Ingresos: ${total_income}€\n🧾 Facturas emitidas: ${total_invoices}\n⏳ Pendientes: ${pending_invoices}\n🆕 Nuevos clientes: ${new_clients}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

// 🚨 Alerta del sistema
app.post('/system-alert', authMiddleware, async (c) => {
  const { error, context } = await c.req.json()
  const message = `🚨 <b>Alerta del sistema</b>\n\n❌ ${error}\n📍 Contexto: ${context}`
  const result = await sendTelegramMessage(message)
  return c.json({ success: true, result })
})

export const telegramRoutes = app

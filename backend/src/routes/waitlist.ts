// @ts-nocheck
import { Hono } from 'hono'

const app = new Hono()

const SUPABASE_URL = 'https://emygbvxkhfbwyhbapaae.supabase.co'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = '8356150792'

app.post('/join', async (c) => {
  try {
    const { nombre, email, empresa } = await c.req.json()

    if (!email || !email.includes('@')) {
      return c.json({ error: 'Email inválido' }, 400)
    }

    // Guardar en Supabase
    const res = await fetch(`${SUPABASE_URL}/rest/v1/waitlist`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ nombre: nombre || null, email, empresa: empresa || null })
    })

    if (res.status === 409) {
      return c.json({ ok: true, msg: 'Ya estás en la lista 😈' })
    }

    if (!res.ok) {
      const err = await res.text()
      console.error('Supabase error:', err)
      return c.json({ error: 'Error al guardar' }, 500)
    }

    // Notificar a Miguel por Telegram
    const msg = `🔥 *Nueva solicitud en waitlist*\n\n👤 ${nombre || 'Sin nombre'}\n📧 ${email}\n🏢 ${empresa || 'Sin empresa'}`
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'Markdown'
      })
    })

    return c.json({ ok: true, msg: 'Apuntado. Te avisamos cuando abra 😈' })
  } catch (e) {
    console.error(e)
    return c.json({ error: 'Error interno' }, 500)
  }
})

// GET: listar waitlist (solo super admin)
app.get('/', async (c) => {
  const auth = c.req.header('Authorization')
  if (!auth) return c.json({ error: 'No autorizado' }, 401)

  const res = await fetch(`${SUPABASE_URL}/rest/v1/waitlist?order=created_at.desc`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  })
  const data = await res.json()
  return c.json(data)
})

export { app as waitlistRoutes }
export default app

// @ts-nocheck
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { authRoutes } from './routes/auth'
import { dashboardRoutes } from './routes/dashboard'
import { clientRoutes } from './routes/clients'
import { transactionRoutes } from './routes/transactions'
import { invoiceRoutes } from './routes/invoices'
import { agentRoutes } from './routes/agent'
import { reportRoutes } from './routes/reports'
import { stripeRoutes } from './routes/stripe'
import { webhookRoutes } from './routes/webhooks'
import { demonioRoutes } from './routes/demonio'
import { telegramRoutes, telegramBotRoutes } from './routes/telegram'
import { gestorRoutes, gestorPublicRoutes } from './routes/gestor'
import { whatsappRoutes } from './routes/whatsapp'
import { authMiddleware } from './middleware/auth'
import { getSupabaseAdmin } from './integrations/supabase'

export function createApp() {
  const app = new Hono()

  // ─── Global Middleware ─────────────────────────────────────────────────────
  app.use('*', logger())
  app.use(
    '*',
    cors({
      origin: (origin) => {
        const allowed = [
          'https://gerobelleza-lang.github.io',
          'http://localhost:3000',
          'http://localhost:5500',
          'http://127.0.0.1:5500',
        ]
        return allowed.includes(origin) ? origin : null
      },
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true,
    })
  )

  // ─── Health & Root ─────────────────────────────────────────────────────────
  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() })
  )

  // ─── Public Routes ─────────────────────────────────────────────────────────
  app.route('/auth', authRoutes)

  // ─── Stripe & External Webhooks (Public, no auth) ──────────────────────────
  app.route('/api/stripe', stripeRoutes)
  app.route('/webhooks', webhookRoutes)

  // ─── WhatsApp Webhook (Public — Twilio envía mensajes aquí) ────────────────
  // POST /webhooks/whatsapp
  app.route('/webhooks/whatsapp', whatsappRoutes)

  // ─── Telegram Bot Webhook (Public — Telegram envía mensajes aquí) ───────────
  app.route('/telegram', telegramBotRoutes)

  // ─── Gestor Portal (Public — acceso con token de gestor) ───────────────────
  app.route('/gestor', gestorPublicRoutes)

  // ─── Demonio Callback (Public — N8N webhook, no user auth) ─────────────────
  app.post('/api/demonio/callback', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const { task_id, status, result, error, preview } = body

      if (!task_id || !status) {
        return c.json({ error: 'Missing task_id or status' }, 400)
      }

      const supabase = getSupabaseAdmin()

      const { error: updateErr } = await supabase
        .from('demonio_tasks')
        .update({
          status,
          result: result ?? null,
          error: error ?? null,
          preview: preview ?? null,
          updated_at: new Date().toISOString()
        })
        .eq('id', task_id)

      if (updateErr) {
        return c.json({ error: 'Failed to update task' }, 500)
      }

      if (status === 'completed') {
        const { data: task } = await supabase
          .from('demonio_tasks')
          .select('*')
          .eq('id', task_id)
          .single()

        if (task) {
          await supabase.from('audit_log').insert([{
            user_id: task.user_id,
            salon_id: task.salon_id,
            action: `demonio_${task.action}`,
            changes: result,
            created_at: new Date().toISOString()
          }])
        }
      }

      return c.json({ received: true })
    } catch (err) {
      console.error('[Demonio Callback] Error:', err)
      return c.json({ error: 'Internal error' }, 500)
    }
  })

  // ─── Protected Routes ──────────────────────────────────────────────────────
  app.use('/api/*', authMiddleware)
  app.route('/api/dashboard', dashboardRoutes)
  app.route('/api/clients', clientRoutes)
  app.route('/api/transactions', transactionRoutes)
  app.route('/api/invoices', invoiceRoutes)
  app.route('/api/agent', agentRoutes)
  app.route('/api/reports', reportRoutes)
  app.route('/api/demonio', demonioRoutes)
  app.route('/api/gestor', gestorRoutes)
  app.route('/api/notifications/telegram', telegramRoutes)

  // ─── Error Handling ────────────────────────────────────────────────────────
  app.notFound((c) =>
    c.json({ error: 'Not Found', path: c.req.path }, 404)
  )
  app.onError((err, c) => {
    console.error(`[ERROR] ${err.message}`, err)
    return c.json({ error: err.message || 'Internal Server Error' }, 500)
  })

  return app
}

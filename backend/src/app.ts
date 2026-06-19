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
import { chatRoutes } from './routes/chat'
import { exportPublicRoutes } from './routes/export'
import { onboardingRoutes } from './routes/onboarding'
import { categoriesRoutes } from './routes/categories'
import { whatsappRoutes } from './routes/whatsapp'
import { documentsRoutes, documentsPublicRoutes } from './routes/documents'
import { cazadorRoutes, cazadorInternalRoute } from './routes/cazador'
import { supportRoutes } from './routes/support'
import { legalRoutes } from './routes/legal'
import { albaranRoute } from './routes/albaran'
import { authMiddleware } from './middleware/auth'
import { getSupabaseAdmin } from './integrations/supabase'
import { accrueCommissions } from './routes/export'

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
  app.route('/webhooks/whatsapp', whatsappRoutes)
  app.route('/telegram', telegramBotRoutes)

  // ─── Export Downloads (Public — validado por token firmado 15 min) ─────────
  app.route('/api/export', exportPublicRoutes)

  // ─── Gestor Portal (Public — acceso con token de gestor) ───────────────────
  app.route('/gestor', gestorPublicRoutes)

  // ─── Documents Verify (Public — cualquiera puede verificar un hash) ────────
  app.route('/api/documents/verify', documentsPublicRoutes)

  // ─── Support Email (Public — auth via x-support-secret) ────────────────────
  app.route('/api/support', supportRoutes)

  // ─── Demonio Callback (Public — N8N webhook, no user auth) ─────────────────
  app.post('/api/demonio/callback', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const { task_id, status, result, error, preview } = body
      if (!task_id || !status) return c.json({ error: 'Missing task_id or status' }, 400)
      const supabase = getSupabaseAdmin()
      const { error: updateErr } = await supabase
        .from('demonio_tasks')
        .update({ status, result: result ?? null, error: error ?? null, preview: preview ?? null, updated_at: new Date().toISOString() })
        .eq('id', task_id)
      if (updateErr) return c.json({ error: 'Failed to update task' }, 500)
      if (status === 'completed') {
        const { data: task } = await supabase.from('demonio_tasks').select('*').eq('id', task_id).single()
        if (task) await supabase.from('audit_log').insert([{ user_id: task.user_id, salon_id: task.salon_id, action: `demonio_${task.action}`, changes: result, created_at: new Date().toISOString() }])
      }
      return c.json({ received: true })
    } catch (err) {
      console.error('[Demonio Callback] Error:', err)
      return c.json({ error: 'Internal error' }, 500)
    }
  })

  // ─── Internal: Commissions Accrue (called by monthly trigger) ─────────────
  app.post('/api/internal/commissions/accrue', async (c) => {
    try {
      const supabase = getSupabaseAdmin()
      const result = await accrueCommissions(supabase)
      return c.json({ ok: true, ...result })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // ─── Internal: Cazador Run (called by daily trigger — no user auth) ────────
  app.post('/api/internal/cazador/run', cazadorInternalRoute)

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
  app.route('/api/chat', chatRoutes)
  app.route('/api/onboarding', onboardingRoutes)
  app.route('/api/categories', categoriesRoutes)
  app.route('/api/notifications/telegram', telegramRoutes)
  app.route('/api/documents', documentsRoutes)
  app.route('/api/cazador', cazadorRoutes)
  app.route('/api/legal', legalRoutes)       // ← Módulo Legal
  app.route('/api/albaranes', albaranRoute)  // ← Albaranes (Panel Móvil)

  // ─── Error Handling ────────────────────────────────────────────────────────
  app.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404))
  app.onError((err, c) => {
    console.error(`[ERROR] ${err.message}`, err)
    return c.json({ error: err.message || 'Internal Server Error' }, 500)
  })

  return app
}

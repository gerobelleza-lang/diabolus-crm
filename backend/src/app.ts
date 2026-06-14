import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { authRoutes } from './routes/auth'
import { dashboardRoutes } from './routes/dashboard'
import { clientRoutes } from './routes/clients'
import { transactionRoutes } from './routes/transactions'
import { invoiceRoutes } from './routes/invoices'
import { agentRoutes } from './routes/agent'
import { authMiddleware } from './middleware/auth'

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

  // ─── Public Routes ─────────────────────────────────────────────────────────
  app.get('/', (c) =>
    c.json({
      status: 'ok',
      service: 'Diabolus CRM API',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    })
  )
  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() })
  )

  app.route('/auth', authRoutes)

  // ─── Protected Routes ──────────────────────────────────────────────────────
  app.use('/api/*', authMiddleware)
  app.route('/api/dashboard', dashboardRoutes)
  app.route('/api/clients', clientRoutes)
  app.route('/api/transactions', transactionRoutes)
  app.route('/api/invoices', invoiceRoutes)
  app.route('/api/agent', agentRoutes)

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

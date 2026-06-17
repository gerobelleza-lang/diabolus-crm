// @ts-nocheck
/**
 * stripe.ts — STUB (Fase 6 pendiente)
 * El SDK real de Stripe usa APIs de Node.js incompatibles con Edge Runtime.
 * Este stub mantiene las rutas registradas para que app.ts compile y arranque,
 * sin importar nada de Stripe.
 */
import { Hono } from 'hono'

export const stripeRoutes = new Hono()

stripeRoutes.all('*', (c) =>
  c.json({ error: 'Stripe integration coming in Fase 6' }, 503)
)

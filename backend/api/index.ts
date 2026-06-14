/**
 * Diabolus CRM — Vercel Node.js Runtime Entry Point
 * Hono.js catch-all handler
 */
import { handle } from 'hono/vercel'
import { createApp } from '../src/app'

// Node.js runtime required for PDFKit (Buffer, streams)
export const config = { runtime: 'nodejs' }

const app = createApp()
export default handle(app)

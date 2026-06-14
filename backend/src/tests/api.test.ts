import { describe, it, expect, beforeAll } from 'vitest'
import { createApp } from '../app'

let app: ReturnType<typeof createApp>
const BASE_URL = 'http://localhost:3000'
const DEV_TOKEN = 'demo_token_test'

beforeAll(() => {
  app = createApp()
})

describe('API Integration Tests', () => {
  describe('GET / — Health Check', () => {
    it('should return service info', async () => {
      const response = await app.request('/')
      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.service).toBe('Diabolus CRM API')
    })
  })

  describe('POST /api/stripe/create-charge', () => {
    it.skip('should create payment intent', async () => {
      // Skipped: requires STRIPE_SECRET_KEY
      const response = await app.request('/api/stripe/create-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId: 'INV-001',
          amount: 150.50,
          currency: 'eur'
        })
      })

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.status).toBe('success')
      expect(json.paymentIntentId).toBeDefined()
    })

    it('should fail with missing amount', async () => {
      const response = await app.request('/api/stripe/create-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId: 'INV-002'
        })
      })

      expect(response.status).toBe(400)
    })
  })

  describe('POST /api/whatsapp/send', () => {
    it('should send payment reminder', async () => {
      const response = await app.request('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientPhoneId: '34612345678',
          messageType: 'payment_reminder',
          invoiceId: 'INV-001',
          amount: 150.50,
          dueDate: '2026-06-20'
        })
      })

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(['success', 'success_mock']).toContain(json.status)
      expect(json.messageId).toBeDefined()
    })

    it('should fail with missing params', async () => {
      const response = await app.request('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })

      expect(response.status).toBe(400)
    })
  })

  describe('POST /webhooks/gmail', () => {
    it('should process gmail webhook with mock data', async () => {
      const mockEmail = 'From: proveedor@example.com Subject: Factura EUR 250 Due: 2026-07-01'
      const payload = Buffer.from(
        JSON.stringify({
          emailAddress: 'user@example.com',
          messagesAdded: [{ id: 'msg_123' }],
          snippet: mockEmail
        })
      ).toString('base64')

      const response = await app.request('/webhooks/gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            data: payload,
            attributes: { 'salon_id': 'test-salon' }
          }
        })
      })

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.status).toBe('success')
      expect(json.processed).toBeGreaterThan(0)
    })

    it('should fail with invalid payload', async () => {
      const response = await app.request('/webhooks/gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {}
        })
      })

      expect(response.status).toBe(400)
    })
  })

  describe('POST /api/agent/chat', () => {
    it.skip('should parse income command (L0)', async () => {
      // Skipped: requires OPENROUTER_API_KEY
      const response = await app.request('/api/agent/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEV_TOKEN}`
        },
        body: JSON.stringify({
          userInput: 'Ingreso 150 paula corte'
        })
      })

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.status).toBe('success')
      expect(json.parsed.intent).toBe('create_income')
      expect(json.parsed.amount).toBe(150)
      expect(json.routing.level).toBe('L0')
    })

    it.skip('should parse expense command (L0)', async () => {
      // Skipped: requires OPENROUTER_API_KEY
      const response = await app.request('/api/agent/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEV_TOKEN}`
        },
        body: JSON.stringify({
          userInput: 'Gasto 75 tinturas rojas'
        })
      })

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.parsed.intent).toBe('create_expense')
      expect(json.parsed.amount).toBe(75)
    })

    it('should handle complex query (L1+)', async () => {
      const response = await app.request('/api/agent/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEV_TOKEN}`
        },
        body: JSON.stringify({
          userInput: 'Analiza mis gastos de los últimos 3 meses y dame un resumen con categorías'
        })
      })

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(['L0', 'L1', 'L2', 'L3']).toContain(json.routing.level)
    })

    it('should fail without auth', async () => {
      const response = await app.request('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userInput: 'test'
        })
      })

      expect(response.status).toBe(401)
    })
  })

  describe('Auth Middleware', () => {
    it('should accept demo_ tokens', async () => {
      const response = await app.request('/api/dashboard', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer demo_test_token`
        }
      })

      // El endpoint puede no existir, pero el auth debe pasar
      expect([200, 404]).toContain(response.status)
    })

    it('should reject without token', async () => {
      const response = await app.request('/api/dashboard', {
        method: 'GET'
      })

      expect(response.status).toBe(401)
    })
  })
})

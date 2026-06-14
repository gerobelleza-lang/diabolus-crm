import { Hono } from 'hono'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-11-20'
})

export const stripeRoutes = new Hono()

/**
 * POST /api/stripe/create-charge
 * Crea un payment intent para cobrar una factura
 */
stripeRoutes.post('/create-charge', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))

    const { invoiceId, amount, currency = 'eur', description } = body as {
      invoiceId?: string
      amount?: number
      currency?: string
      description?: string
    }

    if (!invoiceId || !amount || amount <= 0) {
      return c.json({
        error: 'Missing or invalid: invoiceId, amount (>0)'
      }, 400)
    }

    // Stripe amount in cents
    const amountCents = Math.round(amount * 100)

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: currency.toLowerCase(),
      metadata: {
        invoiceId,
        salonId: c.get('salonId') || 'demo'
      },
      description: description || `Invoice ${invoiceId}`
    })

    return c.json({
      status: 'success',
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount,
      currency
    })
  } catch (err) {
    console.error('[Stripe] Error:', err)
    return c.json({ error: 'Stripe error' }, 500)
  }
})

/**
 * POST /api/stripe/webhook
 * Webhook para confirmación de pagos
 */
stripeRoutes.post('/webhook', async (c) => {
  try {
    const signature = c.req.header('stripe-signature')
    const body = await c.req.text()

    if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
      return c.json({ error: 'Missing webhook signature' }, 400)
    }

    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    )

    // Handle events
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object as Stripe.PaymentIntent
        console.log(`✓ Payment succeeded: ${paymentIntent.id}`)
        // TODO: Update invoice status to 'paid'
        // TODO: Send confirmation email
        break

      case 'payment_intent.payment_failed':
        const failedIntent = event.data.object as Stripe.PaymentIntent
        console.log(`✗ Payment failed: ${failedIntent.id}`)
        // TODO: Notify user
        break

      default:
        console.log(`Unhandled event: ${event.type}`)
    }

    return c.json({ received: true })
  } catch (err) {
    console.error('[Stripe Webhook] Error:', err)
    return c.json({ error: 'Webhook error' }, 500)
  }
})

/**
 * GET /api/stripe/payment-intent/:id
 * Obtiene estado de un pago
 */
stripeRoutes.get('/payment-intent/:id', async (c) => {
  try {
    const { id } = c.req.param()

    const paymentIntent = await stripe.paymentIntents.retrieve(id)

    return c.json({
      status: paymentIntent.status,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      clientSecret: paymentIntent.client_secret
    })
  } catch (err) {
    console.error('[Stripe] Error:', err)
    return c.json({ error: 'Payment intent not found' }, 404)
  }
})

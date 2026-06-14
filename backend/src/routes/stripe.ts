import { Hono } from 'hono'
import Stripe from 'stripe'
import { getSupabaseAdmin } from '../integrations/supabase.js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-08-16'
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
        invoiceId: invoiceId || '',
        salonId: 'demo'
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
        await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent)
        break

      case 'payment_intent.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.PaymentIntent)
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

/**
 * Maneja pago exitoso
 */
async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  const invoiceId = paymentIntent.metadata?.invoiceId as string | undefined
  const salonId = paymentIntent.metadata?.salonId as string | undefined

  console.log(`✓ Payment succeeded: ${paymentIntent.id}`)

  if (!invoiceId || !salonId) {
    console.warn('Missing invoiceId or salonId in payment metadata')
    return
  }

  try {
    const supabase = getSupabaseAdmin()

    // Actualizar estado de factura a 'paid'
    const { error } = await supabase
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString()
      })
      .eq('id', invoiceId)
      .eq('salon_id', salonId)

    if (error) {
      console.error('Failed to update invoice:', error)
      return
    }

    console.log(`✓ Invoice ${invoiceId} marked as paid`)

    // TODO: Send confirmation email to client
    // TODO: Send notification to business owner
  } catch (err) {
    console.error('Error processing payment success:', err)
  }
}

/**
 * Maneja pago fallido
 */
async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
  const invoiceId = paymentIntent.metadata?.invoiceId as string | undefined
  const salonId = paymentIntent.metadata?.salonId as string | undefined

  console.log(`✗ Payment failed: ${paymentIntent.id}`)

  if (!invoiceId || !salonId) {
    console.warn('Missing invoiceId or salonId in payment metadata')
    return
  }

  try {
    // TODO: Mark invoice as payment_failed
    // TODO: Send retry notification to client
    console.log(`Payment failure notification sent for invoice ${invoiceId}`)
  } catch (err) {
    console.error('Error processing payment failure:', err)
  }
}

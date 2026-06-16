// @ts-nocheck
/**
 * agent.ts — Adaptador web del núcleo agéntico.
 *
 * Este fichero es un adaptador HTTP fino sobre core.ts.
 * Toda la lógica vive en core.ts; aquí solo se parsea el request,
 * se llama a processAgentInput y se serializa la respuesta.
 *
 * Rutas:
 *   POST /api/agent/chat    — texto natural → core (type: 'text')
 *   POST /api/agent/photo   — imagen base64 → core (type: 'image')
 *   POST /api/agent/confirm — confirmar acción → core (type: 'action_response', confirm)
 *   POST /api/agent/cancel  — cancelar acción  → core (type: 'action_response', cancel)
 */

import { Hono }                from 'hono'
import { processAgentInput }   from '../agent/core'

export const agentRoutes = new Hono()

// ─── POST /api/agent/chat ──────────────────────────────────────────────────────

agentRoutes.post('/chat', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    if (!body?.userInput || typeof body.userInput !== 'string' || !body.userInput.trim()) {
      return c.json({ error: 'Missing userInput' }, 400)
    }

    const salonId = c.get('salonId') as string
    const userId  = c.get('userId')  as string

    const output = await processAgentInput({
      tenantId: salonId,
      channel:  'web',
      type:     'text',
      text:     body.userInput,
      userId,
    })

    if (output.card) {
      return c.json({ status: 'pending_confirmation', card: output.card })
    }
    if (output.needsInfo) {
      return c.json({ status: 'needs_info', message: output.needsInfo })
    }
    return c.json({
      status:  'success',
      message: output.replyText,
      routing: output.routing,
    })
  } catch (err) {
    console.error('[Agent/Chat] Error:', err)
    return c.json({ error: 'Agent error' }, 500)
  }
})

// ─── POST /api/agent/photo ─────────────────────────────────────────────────────

agentRoutes.post('/photo', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { image, mimeType = 'image/jpeg' } = body

    if (!image || typeof image !== 'string') {
      return c.json({ error: 'Missing image (base64)' }, 400)
    }

    const salonId = c.get('salonId') as string
    const userId  = c.get('userId')  as string

    const output = await processAgentInput({
      tenantId:    salonId,
      channel:     'web',
      type:        'image',
      imageBase64: image,
      imageMime:   mimeType,
      userId,
    })

    if (output.card) {
      return c.json({
        status:         'pending_confirmation',
        card:           output.card,
        source:         'photo',
        campos_dudosos: output.camposDudosos,
        confianza:      output.confianza,
      })
    }
    if (output.needsInfo) {
      return c.json({ status: 'needs_info', message: output.needsInfo })
    }
    return c.json({ status: 'success', message: output.replyText })
  } catch (err) {
    console.error('[Agent/Photo] Error:', err)
    return c.json({ error: 'Error procesando la imagen' }, 500)
  }
})

// ─── POST /api/agent/confirm ───────────────────────────────────────────────────

agentRoutes.post('/confirm', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    if (!body?.pending_action_id) return c.json({ error: 'Missing pending_action_id' }, 400)

    const salonId = c.get('salonId') as string

    const output = await processAgentInput({
      tenantId: salonId,
      channel:  'web',
      type:     'action_response',
      actionResponse: { pendingActionId: body.pending_action_id, decision: 'confirm' },
    })

    return c.json({ status: output.replyText?.startsWith('❌') ? 'error' : 'success', message: output.replyText })
  } catch (err) {
    console.error('[Agent/Confirm] Error:', err)
    return c.json({ error: 'Confirm error' }, 500)
  }
})

// ─── POST /api/agent/cancel ────────────────────────────────────────────────────

agentRoutes.post('/cancel', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    if (!body?.pending_action_id) return c.json({ error: 'Missing pending_action_id' }, 400)

    const salonId = c.get('salonId') as string

    const output = await processAgentInput({
      tenantId: salonId,
      channel:  'web',
      type:     'action_response',
      actionResponse: { pendingActionId: body.pending_action_id, decision: 'cancel' },
    })

    return c.json({ status: 'success', message: output.replyText })
  } catch (err) {
    console.error('[Agent/Cancel] Error:', err)
    return c.json({ error: 'Cancel error' }, 500)
  }
})

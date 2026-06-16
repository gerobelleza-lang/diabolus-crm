// @ts-nocheck
/**
 * whatsapp.ts — Adaptador WhatsApp (Twilio) del núcleo agéntico (Rebanada 4).
 *
 * Recibe webhooks de Twilio, normaliza a AgentInput y llama a core.ts.
 *
 * Seguridad:
 *  - Solo números vinculados en channel_links pueden interactuar.
 *  - Un número no vinculado recibe únicamente el mensaje de vinculación.
 *
 * Confirmación (sin botones nativos en WhatsApp):
 *  - La tarjeta se envía como texto + "Responde SÍ para confirmar o NO para cancelar."
 *  - El pending_action_id se guarda en channel_links.last_pending_action_id.
 *  - Si el siguiente mensaje es SÍ/SI/s → confirm; NO/n → cancel.
 *
 * Fotos:
 *  - MediaUrl0 + MediaContentType0 → descarga con auth Twilio → base64 → core(type: 'image')
 *
 * Respuesta vía TwiML (HTTP reply, más simple que Twilio API para Edge Runtime).
 */

import { Hono }                                                   from 'hono'
import { processAgentInput, resolveTenant, storeLastPending, getLastPending } from '../agent/core'
import type { AgentOutput }                                       from '../agent/core'
import type { ConfirmationCard }                                  from '../agent/confirmation'

export const whatsappRoutes = new Hono()

// ─── TwiML helper ─────────────────────────────────────────────────────────────

function twimlReply(message: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message><Body>${escapeXml(message)}</Body></Message></Response>`
  return new Response(xml, { headers: { 'Content-Type': 'text/xml' } })
}

function twimlSilent(): Response {
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { 'Content-Type': 'text/xml' } }
  )
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ─── Format confirmation card as WhatsApp text ────────────────────────────────

function formatCardWhatsApp(card: ConfirmationCard): string {
  const lines = [
    `📋 *${card.summary}*`,
    '─────────────────',
    ...card.fields.map(f => `• *${f.label}:* ${f.value}`),
  ]

  if (card.preview) {
    lines.push('')
    lines.push('💬 *Mensaje a enviar:*')
    lines.push(`_${card.preview}_`)
  }

  lines.push('')
  lines.push('Responde *SÍ* para confirmar o *NO* para cancelar.')
  return lines.join('\n')
}

// ─── Download Twilio media ────────────────────────────────────────────────────

async function downloadTwilioMedia(
  mediaUrl: string
): Promise<{ base64: string; mime: string } | null> {
  const sid   = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return null

  const res = await fetch(mediaUrl, {
    headers: { 'Authorization': `Basic ${btoa(`${sid}:${token}`)}` },
  })
  if (!res.ok) return null

  const mime   = res.headers.get('content-type') || 'image/jpeg'
  const buffer = await res.arrayBuffer()
  const bytes  = new Uint8Array(buffer)
  let binary   = ''
  bytes.forEach(b => binary += String.fromCharCode(b))
  const base64 = btoa(binary)

  return { base64, mime }
}

// ─── Normalize phone number ───────────────────────────────────────────────────

function normalizePhone(raw: string): string {
  // Twilio sends "whatsapp:+34612345678" → strip prefix
  return raw.replace(/^whatsapp:/i, '').trim()
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

whatsappRoutes.post('/webhook', async (c) => {
  try {
    // Twilio sends application/x-www-form-urlencoded
    const formData   = await c.req.formData().catch(() => new FormData())
    const from       = normalizePhone(formData.get('From')?.toString() || '')
    const body       = (formData.get('Body')?.toString()   || '').trim()
    const numMedia   = parseInt(formData.get('NumMedia')?.toString() || '0', 10)
    const mediaUrl   = formData.get('MediaUrl0')?.toString()   || ''
    const mediaMime  = formData.get('MediaContentType0')?.toString() || 'image/jpeg'

    if (!from) return twimlSilent()

    // ── Resolver tenant ──────────────────────────────────────────────────
    const tenantId = await resolveTenant('whatsapp', from)
    if (!tenantId) {
      return twimlReply(
        '⛔ Este número no está vinculado a ningún negocio en Diabolus.\n\n' +
        'Para vincular tu WhatsApp, accede a tu cuenta en la web y sigue las instrucciones de vinculación.'
      )
    }

    // ── Foto adjunta → core(type: 'image') ──────────────────────────────
    if (numMedia > 0 && mediaUrl) {
      const photoData = await downloadTwilioMedia(mediaUrl)
      if (!photoData) {
        return twimlReply('❌ No pude descargar la imagen. Inténtalo de nuevo.')
      }

      const output = await processAgentInput({
        tenantId,
        channel:     'whatsapp',
        type:        'image',
        imageBase64: photoData.base64,
        imageMime:   photoData.mime,
      })

      return await sendOutputWhatsApp(output, 'whatsapp', from, tenantId)
    }

    const textNormalized = body.toLowerCase().trim()

    // ── SÍ / NO → acción pendiente ───────────────────────────────────────
    if (/^(s[ií]|s|yes|confirmar|confirmo|ok|dale)$/i.test(textNormalized)) {
      const lastPending = await getLastPending('whatsapp', from)
      if (!lastPending) {
        return twimlReply('No hay ninguna acción pendiente de confirmar. ¿Qué quieres hacer?')
      }
      const output = await processAgentInput({
        tenantId,
        channel:  'whatsapp',
        type:     'action_response',
        actionResponse: { pendingActionId: lastPending, decision: 'confirm' },
      })
      // Limpiar la acción pendiente
      await storeLastPending('whatsapp', from, null)
      return twimlReply(output.replyText || 'Listo.')
    }

    if (/^(no|n|cancelar|cancelo)$/i.test(textNormalized)) {
      const lastPending = await getLastPending('whatsapp', from)
      if (!lastPending) {
        return twimlReply('No hay ninguna acción pendiente. ¿Qué quieres hacer?')
      }
      const output = await processAgentInput({
        tenantId,
        channel:  'whatsapp',
        type:     'action_response',
        actionResponse: { pendingActionId: lastPending, decision: 'cancel' },
      })
      await storeLastPending('whatsapp', from, null)
      return twimlReply(output.replyText || 'Cancelado.')
    }

    // ── Texto natural → core ────────────────────────────────────────────
    if (!body) return twimlSilent()

    const output = await processAgentInput({
      tenantId,
      channel: 'whatsapp',
      type:    'text',
      text:    body,
    })

    return await sendOutputWhatsApp(output, 'whatsapp', from, tenantId)

  } catch (err) {
    console.error('[WhatsApp] Error:', err)
    return twimlReply('❌ Error interno. Inténtalo de nuevo en unos segundos.')
  }
})

// ─── sendOutputWhatsApp ───────────────────────────────────────────────────────

async function sendOutputWhatsApp(
  output: AgentOutput,
  channel: string,
  from: string,
  tenantId: string
): Promise<Response> {
  if (output.card) {
    const message = formatCardWhatsApp(output.card)
    // Guardar la acción pendiente para capturar SÍ/NO
    await storeLastPending(channel, from, output.card.pending_action_id)
    return twimlReply(message)
  }
  if (output.needsInfo) return twimlReply(output.needsInfo)
  return twimlReply(output.replyText || '¿En qué puedo ayudarte?')
}

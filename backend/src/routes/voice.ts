/**
 * voice.ts — Facturación por voz
 * POST /api/agent/voice
 *
 * Acepta: multipart/form-data con campo "audio" (webm, mp4, ogg, wav, mp3)
 * Flujo: audio → Groq Whisper → Diablilla processAgentInput → respuesta
 *
 * Devuelve:
 * {
 *   transcription: string,     // texto transcrito
 *   status: 'success' | 'pending_confirmation' | 'needs_info',
 *   message?: string,          // respuesta de Diablilla
 *   card?: object,             // tarjeta de confirmación (si crear_factura)
 * }
 */

import { Hono } from 'hono'
import { processAgentInput } from '../agent/core'

type Variables = {
  userId: string
  salonId: string
  userEmail: string
  gestorId: string
  usageWarning: boolean
  salon_id: string
}

export const voiceRoute = new Hono<{ Variables: Variables }>()

// ── Transcribe audio via Groq Whisper ─────────────────────────────────────────
async function transcribeAudio(audioBlob: Blob, filename: string): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) throw new Error('GROQ_API_KEY not configured')

  const form = new FormData()
  form.append('file', audioBlob, filename)
  form.append('model', 'whisper-large-v3')
  form.append('language', 'es')
  form.append('response_format', 'json')

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqKey}` },
    body: form,
  })

  if (!res.ok) {
    const err = await res.text()
    console.error('[voice] Groq transcription error:', err)
    throw new Error('Transcription failed')
  }

  const result: { text?: string } = await res.json()
  return result.text?.trim() || ''
}

// ── Download WhatsApp media by ID ─────────────────────────────────────────────
export async function downloadWhatsAppMedia(mediaId: string): Promise<{ blob: Blob; mime: string }> {
  const waToken = process.env.WHATSAPP_TOKEN || ''
  if (!waToken) throw new Error('WHATSAPP_TOKEN not configured')

  // Step 1: Get media URL
  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${waToken}` },
  })
  if (!metaRes.ok) throw new Error(`Meta media lookup failed: ${metaRes.status}`)

  const metaData: { url?: string; mime_type?: string } = await metaRes.json()
  if (!metaData.url) throw new Error('No media URL returned')

  // Step 2: Download the actual file
  const fileRes = await fetch(metaData.url, {
    headers: { 'Authorization': `Bearer ${waToken}` },
  })
  if (!fileRes.ok) throw new Error(`Media download failed: ${fileRes.status}`)

  const blob = await fileRes.blob()
  return { blob, mime: metaData.mime_type || 'audio/ogg' }
}

// ── Transcribe WhatsApp audio (for use in webhook) ────────────────────────────
export async function transcribeWhatsAppAudio(mediaId: string): Promise<string> {
  const { blob, mime } = await downloadWhatsAppMedia(mediaId)
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm'
  return transcribeAudio(blob, `wa_voice.${ext}`)
}

// ── POST /api/agent/voice ─────────────────────────────────────────────────────
voiceRoute.post('/', async (c) => {
  try {
    const groqKey = process.env.GROQ_API_KEY
    if (!groqKey) {
      return c.json({ error: 'Voz no configurada. Falta GROQ_API_KEY.' }, 503)
    }

    // Parse audio from form-data
    let formData: FormData
    try {
      formData = await c.req.formData()
    } catch {
      return c.json({ error: 'Error leyendo audio' }, 400)
    }

    const audioFile = formData.get('audio')
    if (!audioFile || typeof audioFile === 'string') {
      return c.json({ error: 'No se recibió audio. Envía campo "audio" en form-data.' }, 400)
    }

    const file = audioFile as File
    const filename = file.name || 'voice.webm'

    // Step 1: Transcribe
    const transcription = await transcribeAudio(file, filename)

    if (!transcription) {
      return c.json({
        transcription: '',
        status: 'error',
        message: 'No pude entender el audio. Intenta hablar más claro o más cerca del micrófono.',
      })
    }

    // Step 2: Feed to Diablilla
    const salonId = c.get('salonId') as string
    const userId = c.get('userId') as string
    const usageWarning = c.get('usageWarning')

    const output = await processAgentInput({
      tenantId: salonId,
      channel: 'web',
      type: 'text',
      text: transcription,
      userId,
    })

    // Step 3: Return combined result
    if (output.card) {
      return c.json({
        transcription,
        status: 'pending_confirmation',
        card: output.card,
        usage_warning: usageWarning || null,
      })
    }

    if (output.needsInfo) {
      return c.json({
        transcription,
        status: 'needs_info',
        message: output.needsInfo,
        usage_warning: usageWarning || null,
      })
    }

    return c.json({
      transcription,
      status: 'success',
      message: output.replyText,
      routing: output.routing,
      usage_warning: usageWarning || null,
    })

  } catch (err: unknown) {
    console.error('[voice] Error:', err)
    const message = err instanceof Error ? err.message : 'Error procesando audio'
    return c.json({ error: message }, 500)
  }
})

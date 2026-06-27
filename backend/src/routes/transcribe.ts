/**
 * Diabolus CRM — Transcripción de audio con Groq Whisper
 * POST /api/agent/transcribe
 *
 * Acepta: multipart/form-data con campo "audio" (webm o mp4)
 * Devuelve: { text: string }
 *
 * Requiere env var: GROQ_API_KEY
 * Cuenta gratuita en: https://console.groq.com
 * Modelo: whisper-large-v3 (gratis, ~200 req/día free tier)
 */

import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'

export const transcribeRoute = new Hono()

transcribeRoute.use('/*', authMiddleware)

transcribeRoute.post('/', async (c) => {
  try {
    const groqKey = process.env.GROQ_API_KEY
    if (!groqKey) {
      return c.json({ error: 'Transcripción no configurada. Añade GROQ_API_KEY en Vercel.' }, 503)
    }

    // Leer form-data con el blob de audio
    let formData: FormData
    try {
      formData = await c.req.formData()
    } catch (e) {
      return c.json({ error: 'Error leyendo audio' }, 400)
    }

    const audioFile = formData.get('audio')
    if (!audioFile || typeof audioFile === 'string') {
      return c.json({ error: 'No se recibió audio' }, 400)
    }

    // Re-empaquetar para Groq API (OpenAI-compatible)
    const groqForm = new FormData()
    groqForm.append('file', audioFile, (audioFile as File).name || 'voice.mp4')
    groqForm.append('model', 'whisper-large-v3')
    groqForm.append('language', 'es')
    groqForm.append('response_format', 'json')

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
      },
      body: groqForm,
    })

    if (!groqRes.ok) {
      const err = await groqRes.text()
      console.error('[transcribe] Groq error:', err)
      return c.json({ error: 'Error de transcripción' }, 502)
    }

    const result = await groqRes.json()
    const text = result.text?.trim() || ''

    return c.json({ text })

  } catch (err) {
    console.error('[transcribe] error:', err)
    return c.json({ error: 'Error interno' }, 500)
  }
})

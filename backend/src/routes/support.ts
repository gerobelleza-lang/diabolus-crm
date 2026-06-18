// @ts-nocheck
import { Hono } from 'hono'

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const MIGUEL_CHAT_ID = '8356150792'
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const SUPPORT_SECRET = process.env.SUPPORT_WEBHOOK_SECRET || ''

const DIABOLUS_KNOWLEDGE = `
Eres el agente de soporte de Diabolus CRM. Responde SIEMPRE en el mismo idioma del email (español/inglés).
Eres profesional, conciso y con personalidad — Diabolus es una marca con carácter.

## Sobre Diabolus CRM
Diabolus es un "centro de mando inteligente" para autónomos y pequeñas empresas en España.
NO es un ERP, NO es un programa de contabilidad tradicional, NO envía datos a la AEAT.

## Qué hace Diabolus
- **Tesorería conversacional**: gestiona cobros, pagos y saldo hablando con el agente
- **Facturas (borrador)**: crea y envía presupuestos/facturas a clientes. Los datos sirven para que tu gestor presente el modelo 303.
- **Sellado SHA-256**: sella documentos digitalmente con prueba criptográfica de existencia (sin subirlos al servidor — privacidad total)
- **Agente IA**: entiende lenguaje natural en Telegram, WhatsApp y chat web
- **Módulo Legal** (+5€/mes en plan Pro): genera contratos, NDAs, presupuestos vinculantes. Firma digital nivel 1 (SHA-256 sellado de tiempo) y nivel 2 (Firmafiy — firma electrónica avanzada)
- **Gestor integration**: comparte cierres mensuales y exportaciones con tu gestor/asesor
- **Multi-tenant SaaS**: Miguel Ángel Martinez es el Super Admin del producto

## Precios
El producto está en beta privada (lanzamiento comercial sept 2026). Para precios e información: escribe a hola@diabolus.es o visita la web.

## Lo que NO hace Diabolus
- NO presenta modelos fiscales a la AEAT directamente
- NO es una gestoría ni asesoría fiscal
- NO almacena tu clave de firma de la AEAT
- NO es un programa de facturación oficial (las facturas son borradores/ayuda)

## Soporte técnico
- Para bugs o incidencias técnicas: describe exactamente qué pasó y qué esperabas
- Para preguntas sobre funcionalidades: responde con lo que sabes
- Si no puedes responder → di que lo escalas al equipo y notifica internamente

## Tono
- Profesional pero cercano
- Menciona el nombre del producto cuando tiene sentido
- Firma como "El equipo de Diabolus"
- Añade: "Si necesitas más ayuda, responde a este email o escribe a hola@diabolus.es"
`

async function sendTelegramAlert(subject: string, from: string, summary: string) {
  const text = `📨 *Email soporte no resuelto*\n\nDe: \`${from}\`\nAsunto: ${subject}\n\nResumen: ${summary}\n\n_Responde directamente al usuario._`
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: MIGUEL_CHAT_ID, text, parse_mode: 'Markdown' }),
  })
}

async function sendEmailReply(to: string, subject: string, htmlBody: string, replyToMessageId?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${RESEND_API_KEY}`,
  }
  const body: any = {
    from: 'Diabolus CRM <support@diabolus.es>',
    to: [to],
    subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    html: htmlBody,
    reply_to: 'support@diabolus.es',
  }
  if (replyToMessageId) {
    body.headers = { 'In-Reply-To': replyToMessageId, References: replyToMessageId }
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return res.ok
}

export const supportRoutes = new Hono()

// POST /api/support/email — llamado por n8n cuando llega un email a support@diabolus.es
supportRoutes.post('/email', async (c) => {
  // Validar secret interno
  const secret = c.req.header('x-support-secret') || ''
  if (SUPPORT_SECRET && secret !== SUPPORT_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json().catch(() => ({}))

  // Accept both Hostinger native format and legacy mapped format
  let from_email: string, from_name: string, subject: string, emailBody: string, message_id: string

  if (body.event === 'message.received' && body.data) {
    // Hostinger native: { event, data: { from, subject, plainBody, messageId, ... } }
    const d = body.data
    const fromRaw: string = d.from || ''
    const fromMatch = fromRaw.match(/^(.+?)\s*<([^>]+)>$/)
    if (fromMatch) {
      from_name = fromMatch[1].trim()
      from_email = fromMatch[2].trim()
    } else {
      from_email = fromRaw.trim()
      from_name = ''
    }
    subject = d.subject || '(sin asunto)'
    emailBody = d.plainBody || d.plainHtml || ''
    message_id = d.messageId || ''
  } else {
    // Legacy mapped format: { from_email, from_name, subject, body, message_id }
    from_email = body.from_email || ''
    from_name = body.from_name || ''
    subject = body.subject || ''
    emailBody = body.body || ''
    message_id = body.message_id || ''
  }

  if (!from_email || !subject || !emailBody) {
    return c.json({ error: 'Missing required fields: from_email, subject, body' }, 400)
  }

  const displayName = from_name ? `${from_name} <${from_email}>` : from_email

  try {
    // Llamar a OpenRouter para generar respuesta
    const llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://diabolus-crm-api.vercel.app',
        'X-Title': 'Diabolus Support Agent',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4-5',
        messages: [
          { role: 'system', content: DIABOLUS_KNOWLEDGE },
          {
            role: 'user',
            content: `Email recibido de ${displayName}\nAsunto: ${subject}\n\nContenido:\n${emailBody}`,
          },
        ],
        max_tokens: 600,
        temperature: 0.4,
      }),
    })

    let agentReply = ''
    let needsEscalation = false

    if (llmRes.ok) {
      const llmData = await llmRes.json()
      agentReply = llmData.choices?.[0]?.message?.content || ''

      // Detectar si el agente no puede responder
      const escalationPhrases = [
        'escalo', 'escalando', 'lo escalo', 'nuestro equipo', 'te contactaremos',
        'no tengo información', 'no puedo responder', 'no sé', 'no dispongo',
      ]
      needsEscalation = escalationPhrases.some((p) =>
        agentReply.toLowerCase().includes(p)
      )
    } else {
      needsEscalation = true
      agentReply = `Hola,\n\nGracias por contactar con el soporte de Diabolus.\n\nHemos recibido tu mensaje y nuestro equipo te responderá lo antes posible.\n\nUn saludo,\nEl equipo de Diabolus\n\nSi necesitas más ayuda, escríbenos a hola@diabolus.es`
    }

    // Si necesita escalación → notificar a Miguel por Telegram
    if (needsEscalation) {
      const summary = emailBody.substring(0, 200)
      await sendTelegramAlert(subject, displayName, summary)
    }

    // Formatear respuesta HTML
    const htmlReply = `
      <div style="font-family: 'Helvetica Neue', sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a2e;">
        <div style="background: #15101F; padding: 20px 30px; border-radius: 8px 8px 0 0;">
          <h2 style="color: #E3BE7A; margin: 0; font-size: 18px;">😈 Diabolus CRM — Soporte</h2>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0; border-top: none;">
          ${agentReply
            .split('\n')
            .map((line) => `<p style="margin: 0 0 12px 0; line-height: 1.6;">${line}</p>`)
            .join('')}
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;" />
          <p style="font-size: 12px; color: #888;">
            Diabolus CRM · <a href="https://gerobelleza-lang.github.io/diabolus-crm" style="color: #8B5CF6;">diabolus.es</a>
            · <a href="mailto:hola@diabolus.es" style="color: #8B5CF6;">hola@diabolus.es</a>
          </p>
        </div>
      </div>
    `

    // Enviar respuesta por email
    const sent = await sendEmailReply(from_email, subject, htmlReply, message_id)

    return c.json({
      ok: true,
      replied: sent,
      escalated: needsEscalation,
      agent_response_length: agentReply.length,
    })
  } catch (err: any) {
    console.error('[Support Agent] Error:', err)
    // En caso de error total → notificar a Miguel
    await sendTelegramAlert(subject, displayName, `ERROR: ${err.message}`).catch(() => {})
    return c.json({ error: 'Internal error', message: err.message }, 500)
  }
})

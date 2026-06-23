// @ts-nocheck
import { Hono } from 'hono'

const app = new Hono()

const SUPABASE_URL = 'https://emygbvxkhfbwyhbapaae.supabase.co'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = '8356150792'
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''

function buildPergaminoEmail(nombre: string): string {
  const nombreDisplay = nombre && nombre.trim() ? nombre.trim() : 'Viajero'
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>El Pacto está casi firmado</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:Georgia,'Times New Roman',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:40px 20px;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Sello superior -->
        <tr>
          <td align="center" style="padding-bottom:24px;">
            <div style="display:inline-block;width:60px;height:60px;background:#1a0a0a;border:2px solid #8b1a1a;border-radius:50%;line-height:60px;text-align:center;font-size:28px;">😈</div>
          </td>
        </tr>

        <!-- Pergamino -->
        <tr>
          <td style="background:linear-gradient(180deg,#1c1208 0%,#221609 40%,#1c1208 100%);border:1px solid #5a3a0a;border-radius:4px;padding:56px 56px 48px;position:relative;">

            <!-- Ornamento superior -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding-bottom:32px;">
                  <div style="color:#8b6914;font-size:11px;letter-spacing:6px;text-transform:uppercase;">✦ &nbsp; Diabolus CRM &nbsp; ✦</div>
                </td>
              </tr>
            </table>

            <!-- Línea decorativa -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="border-top:1px solid #5a3a0a;padding-bottom:40px;"></td>
              </tr>
            </table>

            <!-- Título -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding-bottom:12px;">
                  <h1 style="margin:0;color:#c8a84b;font-size:13px;letter-spacing:4px;text-transform:uppercase;font-weight:normal;">Documento Previo al Pacto</h1>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-bottom:40px;">
                  <h2 style="margin:0;color:#e8d5a0;font-size:32px;font-weight:normal;line-height:1.3;">El Pacto está<br>casi firmado.</h2>
                </td>
              </tr>
            </table>

            <!-- Cuerpo del pergamino -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-bottom:28px;">
                  <p style="margin:0;color:#c8b87a;font-size:16px;line-height:1.8;text-align:center;">
                    <em>${nombreDisplay},</em>
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:28px;">
                  <p style="margin:0;color:#b8a870;font-size:15px;line-height:1.9;text-align:center;">
                    Tu nombre ha sido inscrito en el Registro de los que decidieron<br>
                    dejar de trabajar <em>para</em> su negocio<br>
                    y empezar a <strong style="color:#e8d5a0;">hacerlo trabajar para ellos.</strong>
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:28px;">
                  <p style="margin:0;color:#b8a870;font-size:15px;line-height:1.9;text-align:center;">
                    Cuando las puertas abran,<br>
                    serás de los primeros en cruzarlas.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:40px;">
                  <p style="margin:0;color:#9a8a60;font-size:14px;line-height:1.9;text-align:center;font-style:italic;">
                    Hasta ese día, el demonio espera.<br>
                    Y los que esperan con nosotros,<br>
                    siempre salen ganando.
                  </p>
                </td>
              </tr>
            </table>

            <!-- Separador -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding-bottom:32px;">
                  <div style="width:80px;border-top:1px solid #5a3a0a;display:inline-block;"></div>
                  &nbsp;&nbsp;
                  <span style="color:#8b6914;font-size:14px;">✦</span>
                  &nbsp;&nbsp;
                  <div style="width:80px;border-top:1px solid #5a3a0a;display:inline-block;"></div>
                </td>
              </tr>
            </table>

            <!-- Firma -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding-bottom:8px;">
                  <p style="margin:0;color:#c8a84b;font-size:20px;font-style:italic;">Diablilla</p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-bottom:40px;">
                  <p style="margin:0;color:#7a6a40;font-size:11px;letter-spacing:3px;text-transform:uppercase;">Tu Agente. Tu Demonio. Tu Pacto.</p>
                </td>
              </tr>
            </table>

            <!-- Línea decorativa final -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="border-top:1px solid #5a3a0a;padding-bottom:24px;"></td>
              </tr>
            </table>

            <!-- Ornamento inferior -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center">
                  <div style="color:#5a4a20;font-size:11px;letter-spacing:4px;">✦ &nbsp; diabolus.es &nbsp; ✦</div>
                </td>
              </tr>
            </table>

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td align="center" style="padding-top:24px;">
            <p style="margin:0;color:#3a3a3a;font-size:11px;line-height:1.6;">
              Has solicitado unirte a la lista de espera de Diabolus CRM.<br>
              Si no fuiste tú, ignora este mensaje.<br>
              <a href="https://diabolus.es" style="color:#5a3a0a;text-decoration:none;">diabolus.es</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}

app.post('/join', async (c) => {
  try {
    const { nombre, email, empresa } = await c.req.json()

    if (!email || !email.includes('@')) {
      return c.json({ error: 'Email inválido' }, 400)
    }

    // Guardar en Supabase
    const res = await fetch(`${SUPABASE_URL}/rest/v1/waitlist`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ nombre: nombre || null, email, empresa: empresa || null })
    })

    if (res.status === 409) {
      return c.json({ ok: true, msg: 'Ya estás en la lista 😈' })
    }

    if (!res.ok) {
      const err = await res.text()
      console.error('Supabase error:', err)
      return c.json({ error: 'Error al guardar' }, 500)
    }

    // Notificar a Miguel por Telegram
    const msg = `🔥 *Nueva solicitud en waitlist*\n\n👤 ${nombre || 'Sin nombre'}\n📧 ${email}\n🏢 ${empresa || 'Sin empresa'}`
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'Markdown'
      })
    })

    // Enviar email pergamino via Resend
    if (RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Diabolus CRM <noreply@diabolus.es>',
          to: [email],
          subject: 'El Pacto está casi firmado. 😈',
          html: buildPergaminoEmail(nombre || '')
        })
      })
    }

    return c.json({ ok: true, msg: 'Apuntado. Te avisamos cuando abra 😈' })
  } catch (e) {
    console.error(e)
    return c.json({ error: 'Error interno' }, 500)
  }
})

// GET: listar waitlist (solo super admin)
app.get('/', async (c) => {
  const auth = c.req.header('Authorization')
  if (!auth) return c.json({ error: 'No autorizado' }, 401)

  const res = await fetch(`${SUPABASE_URL}/rest/v1/waitlist?order=created_at.desc`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  })
  const data = await res.json()
  return c.json(data)
})

export { app as waitlistRoutes }
export default app

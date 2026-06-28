import { Hono } from 'hono'

const app = new Hono()

const SUPABASE_URL = process.env.SUPABASE_URL as string
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = '8356150792'
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''

const MAX_PLAZAS = 100

// ─── EMAIL ACTO 1: MISTERIO ─────────────────────────────────────────────────
function buildEmailActo1(nombre: string): string {
  const n = nombre && nombre.trim() ? nombre.trim() : 'Iniciado'
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Has sido inscrito.</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:Georgia,'Times New Roman',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:40px 20px;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Sello -->
        <tr>
          <td align="center" style="padding-bottom:24px;">
            <div style="display:inline-block;width:64px;height:64px;background:#0f0505;border:2px solid #6b1a1a;border-radius:50%;line-height:64px;text-align:center;font-size:30px;">😈</div>
          </td>
        </tr>

        <!-- Pergamino -->
        <tr>
          <td style="background:linear-gradient(180deg,#130d05 0%,#1a1108 50%,#130d05 100%);border:1px solid #4a2e08;border-radius:3px;padding:52px 52px 44px;">

            <!-- Ornamento -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center" style="padding-bottom:28px;">
                <div style="color:#6b5210;font-size:10px;letter-spacing:7px;text-transform:uppercase;">✦ &nbsp; Diabolus &nbsp; ✦</div>
              </td></tr>
            </table>

            <!-- Línea -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="border-top:1px solid #4a2e08;padding-bottom:40px;"></td></tr>
            </table>

            <!-- Título -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center" style="padding-bottom:10px;">
                <p style="margin:0;color:#8a6a30;font-size:11px;letter-spacing:5px;text-transform:uppercase;">Registro Oficial</p>
              </td></tr>
              <tr><td align="center" style="padding-bottom:44px;">
                <h1 style="margin:0;color:#e0c878;font-size:34px;font-weight:normal;line-height:1.3;">Tu nombre<br>ha sido tomado.</h1>
              </td></tr>
            </table>

            <!-- Cuerpo -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="padding-bottom:32px;">
                <p style="margin:0;color:#b8a060;font-size:16px;line-height:1.9;text-align:center;">
                  <em>${n}.</em>
                </p>
              </td></tr>
              <tr><td style="padding-bottom:32px;">
                <p style="margin:0;color:#a89050;font-size:15px;line-height:2;text-align:center;">
                  No sabemos si estás listo.<br>
                  Pero tu nombre ya está inscrito<br>
                  en el Registro del Pacto.
                </p>
              </td></tr>
              <tr><td style="padding-bottom:32px;">
                <p style="margin:0;color:#907840;font-size:15px;line-height:2;text-align:center;">
                  Próximamente recibirás instrucciones.<br>
                  No te decimos cuándo.<br>
                  No te decimos qué.<br>
                  Solo que <strong style="color:#e0c878;">lo que viene, cambia las cosas.</strong>
                </p>
              </td></tr>
              <tr><td style="padding-bottom:44px;">
                <p style="margin:0;color:#706030;font-size:13px;line-height:1.9;text-align:center;font-style:italic;">
                  Mientras tanto, no hagas nada.<br>
                  El demonio ya está trabajando.
                </p>
              </td></tr>
            </table>

            <!-- Separador -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center" style="padding-bottom:32px;">
                <span style="color:#6b5210;font-size:18px;">✦ &nbsp; ✦ &nbsp; ✦</span>
              </td></tr>
            </table>

            <!-- Firma -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center" style="padding-bottom:6px;">
                <p style="margin:0;color:#c8a84b;font-size:22px;font-style:italic;">Diablilla</p>
              </td></tr>
              <tr><td align="center" style="padding-bottom:40px;">
                <p style="margin:0;color:#5a4820;font-size:10px;letter-spacing:4px;text-transform:uppercase;">Tu Agente. Tu Demonio. Tu Pacto.</p>
              </td></tr>
            </table>

            <!-- Línea final -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="border-top:1px solid #4a2e08;padding-bottom:22px;"></td></tr>
              <tr><td align="center">
                <div style="color:#4a3810;font-size:10px;letter-spacing:4px;">✦ &nbsp; diabolus.es &nbsp; ✦</div>
              </td></tr>
            </table>

          </td>
        </tr>

        <!-- Footer legal -->
        <tr>
          <td align="center" style="padding-top:24px;">
            <p style="margin:0;color:#333;font-size:11px;line-height:1.7;">
              Has solicitado unirte a la lista de espera de Diabolus.<br>
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

// ─── GET /count: plazas restantes (público) ─────────────────────────────────
app.get('/count', async (c) => {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/waitlist?select=id`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'count=exact'
      }
    }
  )
  const count = parseInt(res.headers.get('content-range')?.split('/')[1] || '0', 10)
  const remaining = Math.max(0, MAX_PLAZAS - count)
  return c.json({ total: count, remaining, max: MAX_PLAZAS, closed: remaining === 0 })
})

// ─── POST /join ──────────────────────────────────────────────────────────────
app.post('/join', async (c) => {
  try {
    const { nombre, email, empresa } = await c.req.json()

    if (!email || !email.includes('@')) {
      return c.json({ error: 'Email inválido' }, 400)
    }

    // Verificar plazas
    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/waitlist?select=id`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'count=exact'
        }
      }
    )
    const count = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0', 10)
    if (count >= MAX_PLAZAS) {
      return c.json({ error: 'El Pacto está completo. Las 100 plazas han sido tomadas.', closed: true }, 403)
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
      return c.json({ ok: true, msg: 'Ya estás inscrito. El demonio no olvida. 😈' })
    }

    if (!res.ok) {
      const err = await res.text()
      console.error('Supabase error:', err)
      return c.json({ error: 'Error al guardar' }, 500)
    }

    const newCount = count + 1
    const remaining = MAX_PLAZAS - newCount

    // Telegram a Miguel
    const msg = `🔥 *Nueva inscripción en el Pacto*\n\n👤 ${nombre || 'Sin nombre'}\n📧 ${email}\n🏢 ${empresa || '—'}\n\n🎯 Plazas restantes: *${remaining}/${MAX_PLAZAS}*`
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
    })

    // Email Acto 1 — misterio
    if (RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Diabolus <noreply@diabolus.es>',
          to: [email],
          subject: 'Tu nombre ha sido tomado. 😈',
          html: buildEmailActo1(nombre || '')
        })
      })
    }

    return c.json({
      ok: true,
      msg: 'Inscrito. Próximamente recibirás instrucciones. 😈',
      remaining
    })
  } catch (e) {
    console.error(e)
    return c.json({ error: 'Error interno' }, 500)
  }
})

// ─── GET /: listar waitlist (solo super admin) ───────────────────────────────
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

// @ts-nocheck
// Email transaccional via Resend (Edge-compatible — pure fetch)

const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || 'Diabolus CRM <noreply@diaboluscrm.com>'

async function sendEmail(to: string, subject: string, html: string): Promise<{ sent: boolean; error?: string }> {
  if (!RESEND_API_KEY) {
    console.log('[Email] No RESEND_API_KEY — mock mode, would send to:', to, '|', subject)
    return { sent: false, error: 'No RESEND_API_KEY configured' }
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return { sent: false, error: (err as any).message || 'Resend error' }
    }
    return { sent: true }
  } catch (err) {
    return { sent: false, error: String(err) }
  }
}

// ─── Email: Bienvenida al registrarse ─────────────────────────────────────────
export async function sendWelcomeEmail(to: string, businessName: string) {
  const subject = `¡Bienvenido a Diabolus CRM, ${businessName}!`
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Bienvenido a Diabolus CRM</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;margin:0;padding:0;">
  <div style="max-width:560px;margin:40px auto;padding:40px;background:#111;border-radius:12px;border:1px solid #222;">
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="font-size:28px;font-weight:800;color:#dc2626;margin:0;letter-spacing:-0.5px;">🔥 DIABOLUS CRM</h1>
      <p style="color:#666;margin:8px 0 0;">El demonio que ordena tu negocio</p>
    </div>
    <h2 style="color:#fff;font-size:20px;margin-bottom:16px;">¡Bienvenido, ${businessName}!</h2>
    <p style="color:#aaa;line-height:1.6;">Tu cuenta está activa y lista para usar. Ya tienes acceso al panel de control completo con todo lo que necesitas para gestionar tu negocio.</p>
    <div style="background:#1a1a1a;border-radius:8px;padding:20px;margin:24px 0;border:1px solid #333;">
      <p style="margin:0 0 12px;color:#888;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Lo que puedes hacer ahora mismo</p>
      <ul style="margin:0;padding:0 0 0 20px;color:#ccc;line-height:2.2;">
        <li>Añadir tus clientes y contactos</li>
        <li>Crear y enviar facturas por WhatsApp</li>
        <li>Controlar cobros pendientes y vencidos</li>
        <li>Registrar ingresos y gastos al instante</li>
        <li>Consultar tu agente IA por Telegram</li>
      </ul>
    </div>
    <div style="text-align:center;margin:32px 0;">
      <a href="https://gerobelleza-lang.github.io/diabolus-crm" style="background:#dc2626;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;display:inline-block;">Ir al panel →</a>
    </div>
    <p style="color:#555;font-size:12px;text-align:center;margin-top:32px;border-top:1px solid #222;padding-top:20px;">Diabolus CRM · Centro de mando inteligente para autónomos y empresas</p>
  </div>
</body>
</html>`
  return sendEmail(to, subject, html)
}

// ─── Email: Confirmación de factura enviada ───────────────────────────────────
export async function sendInvoiceSentEmail(
  to: string,
  invoiceNum: string,
  clientName: string,
  total: number,
  salonName: string
) {
  const subject = `✅ Factura ${invoiceNum} enviada a ${clientName}`
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;margin:0;padding:0;">
  <div style="max-width:560px;margin:40px auto;padding:40px;background:#111;border-radius:12px;border:1px solid #222;">
    <div style="text-align:center;margin-bottom:28px;">
      <h1 style="font-size:22px;font-weight:800;color:#dc2626;margin:0;">🔥 DIABOLUS CRM</h1>
    </div>
    <div style="background:#052e16;border:1px solid #166534;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
      <p style="margin:0;color:#4ade80;font-size:16px;font-weight:600;">✅ Factura enviada por WhatsApp</p>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:12px 0;color:#888;border-bottom:1px solid #222;">Número de factura</td>
        <td style="padding:12px 0;color:#fff;text-align:right;border-bottom:1px solid #222;font-weight:600;">${invoiceNum}</td>
      </tr>
      <tr>
        <td style="padding:12px 0;color:#888;border-bottom:1px solid #222;">Cliente</td>
        <td style="padding:12px 0;color:#fff;text-align:right;border-bottom:1px solid #222;">${clientName}</td>
      </tr>
      <tr>
        <td style="padding:12px 0;color:#888;">Importe</td>
        <td style="padding:12px 0;color:#4ade80;text-align:right;font-weight:700;font-size:20px;">${total.toFixed(2)}€</td>
      </tr>
    </table>
    <p style="color:#666;font-size:13px;margin-top:24px;line-height:1.6;">El cliente ha recibido la factura en su WhatsApp. Te avisaremos cuando realice el pago.</p>
    <p style="color:#444;font-size:12px;text-align:center;margin-top:32px;border-top:1px solid #222;padding-top:20px;">${salonName} · Diabolus CRM</p>
  </div>
</body>
</html>`
  return sendEmail(to, subject, html)
}

// ─── Email: Confirmación de recordatorio de cobro enviado ─────────────────────
export async function sendReminderSentEmail(
  to: string,
  invoiceNum: string,
  clientName: string,
  total: number,
  salonName: string
) {
  const subject = `📤 Recordatorio enviado a ${clientName} — ${invoiceNum}`
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;margin:0;padding:0;">
  <div style="max-width:560px;margin:40px auto;padding:40px;background:#111;border-radius:12px;border:1px solid #222;">
    <div style="text-align:center;margin-bottom:28px;">
      <h1 style="font-size:22px;font-weight:800;color:#dc2626;margin:0;">🔥 DIABOLUS CRM</h1>
    </div>
    <div style="background:#1c1917;border:1px solid #92400e;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
      <p style="margin:0;color:#fbbf24;font-size:16px;font-weight:600;">📤 Recordatorio de cobro enviado</p>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:12px 0;color:#888;border-bottom:1px solid #222;">Factura</td>
        <td style="padding:12px 0;color:#fff;text-align:right;border-bottom:1px solid #222;font-weight:600;">${invoiceNum}</td>
      </tr>
      <tr>
        <td style="padding:12px 0;color:#888;border-bottom:1px solid #222;">Cliente</td>
        <td style="padding:12px 0;color:#fff;text-align:right;border-bottom:1px solid #222;">${clientName}</td>
      </tr>
      <tr>
        <td style="padding:12px 0;color:#888;">Importe pendiente</td>
        <td style="padding:12px 0;color:#fbbf24;text-align:right;font-weight:700;font-size:20px;">${total.toFixed(2)}€</td>
      </tr>
    </table>
    <p style="color:#666;font-size:13px;margin-top:24px;line-height:1.6;">Se ha enviado un aviso amable al cliente por WhatsApp recordándole el pago pendiente.</p>
    <p style="color:#444;font-size:12px;text-align:center;margin-top:32px;border-top:1px solid #222;padding-top:20px;">${salonName} · Diabolus CRM</p>
  </div>
</body>
</html>`
  return sendEmail(to, subject, html)
}

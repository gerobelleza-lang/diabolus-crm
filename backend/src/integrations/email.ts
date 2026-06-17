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
      <tr><td style="padding:12px 0;color:#888;border-bottom:1px solid #222;">Número de factura</td><td style="padding:12px 0;color:#fff;text-align:right;border-bottom:1px solid #222;font-weight:600;">${invoiceNum}</td></tr>
      <tr><td style="padding:12px 0;color:#888;border-bottom:1px solid #222;">Cliente</td><td style="padding:12px 0;color:#fff;text-align:right;border-bottom:1px solid #222;">${clientName}</td></tr>
      <tr><td style="padding:12px 0;color:#888;">Importe</td><td style="padding:12px 0;color:#4ade80;text-align:right;font-weight:700;font-size:20px;">${total.toFixed(2)}€</td></tr>
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
      <tr><td style="padding:12px 0;color:#888;border-bottom:1px solid #222;">Factura</td><td style="padding:12px 0;color:#fff;text-align:right;border-bottom:1px solid #222;font-weight:600;">${invoiceNum}</td></tr>
      <tr><td style="padding:12px 0;color:#888;border-bottom:1px solid #222;">Cliente</td><td style="padding:12px 0;color:#fff;text-align:right;border-bottom:1px solid #222;">${clientName}</td></tr>
      <tr><td style="padding:12px 0;color:#888;">Importe pendiente</td><td style="padding:12px 0;color:#fbbf24;text-align:right;font-weight:700;font-size:20px;">${total.toFixed(2)}€</td></tr>
    </table>
    <p style="color:#666;font-size:13px;margin-top:24px;line-height:1.6;">Se ha enviado un aviso amable al cliente por WhatsApp recordándole el pago pendiente.</p>
    <p style="color:#444;font-size:12px;text-align:center;margin-top:32px;border-top:1px solid #222;padding-top:20px;">${salonName} · Diabolus CRM</p>
  </div>
</body>
</html>`
  return sendEmail(to, subject, html)
}

// ─── Email: Invitación del gestor a cliente ───────────────────────────────────
export async function sendGestorInviteEmail(
  to: string,
  gestorName: string,
  acceptUrl: string
) {
  const subject = `${gestorName} te invita a conectar tu negocio en Diabolus CRM`
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Invitación de gestor — Diabolus CRM</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;margin:0;padding:0;">
  <div style="max-width:560px;margin:40px auto;padding:40px;background:#111;border-radius:12px;border:1px solid #222;">
    <div style="text-align:center;margin-bottom:28px;">
      <h1 style="font-size:22px;font-weight:800;color:#dc2626;margin:0;">🔥 DIABOLUS CRM</h1>
      <p style="color:#555;margin:6px 0 0;font-size:13px;">Centro de mando inteligente</p>
    </div>
    <div style="background:#1a0a0a;border:1px solid #3d1515;border-radius:10px;padding:18px 20px;margin-bottom:24px;">
      <p style="margin:0;color:#dc2626;font-size:15px;font-weight:600;">📨 Invitación de tu gestor</p>
    </div>
    <h2 style="color:#fff;font-size:18px;margin-bottom:12px;">${gestorName} quiere conectar contigo</h2>
    <p style="color:#aaa;line-height:1.6;margin-bottom:20px;">
      Tu gestor o asesoría <strong style="color:#fff;">${gestorName}</strong> te invita a conectar tu cuenta de Diabolus CRM.
      Así podrá acceder a los datos que necesita para ayudarte con la gestión, de forma ordenada y sin que tengas que
      enviarle nada manualmente.
    </p>
    <div style="background:#0e0e0e;border:1px solid #1e1e1e;border-radius:8px;padding:16px;margin-bottom:24px;">
      <p style="margin:0 0 8px;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">¿Qué verá tu gestor?</p>
      <ul style="margin:0;padding:0 0 0 18px;color:#ccc;line-height:2;">
        <li>Resumen de ingresos y gastos por trimestre</li>
        <li>Estado de tus facturas (cobradas, pendientes, vencidas)</li>
        <li>Movimientos contables del período</li>
      </ul>
      <p style="margin:12px 0 0;color:#555;font-size:12px;">⚠️ No verá estimaciones de IVA ni datos fiscales internos.</p>
    </div>
    <div style="text-align:center;margin:32px 0;">
      <a href="${acceptUrl}" style="background:#dc2626;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;display:inline-block;">Aceptar invitación →</a>
    </div>
    <p style="color:#555;font-size:12px;line-height:1.6;text-align:center;">
      Válida 7 días. Si no esperabas esta invitación, ignórala — nadie tendrá acceso sin que aceptes.
    </p>
    <p style="color:#333;font-size:12px;text-align:center;margin-top:24px;border-top:1px solid #1e1e1e;padding-top:20px;">
      Diabolus CRM · Tesorería que se gestiona hablando
    </p>
  </div>
</body>
</html>`
  return sendEmail(to, subject, html)
}

// ─── Email: Cierre mensual al gestor ─────────────────────────────────────────
// ⚠️ No incluye IVA — regla de producto
export async function sendMonthlyClosingEmail(
  to: string,
  gestorName: string,
  data: any,
  closingId: string | null
) {
  const { period, summary, invoices, expenses_by_category, has_movements, salon_name } = data
  const portalUrl = `https://gerobelleza-lang.github.io/diabolus-crm/gestor.html`

  const categoryRows = (expenses_by_category ?? [])
    .slice(0, 8)
    .map((c: any) => `
      <tr>
        <td style="padding:8px 0;color:#aaa;border-bottom:1px solid #1a1a1a;text-transform:capitalize;">${c.category}</td>
        <td style="padding:8px 0;color:#fff;text-align:right;border-bottom:1px solid #1a1a1a;font-weight:600;">${(c.amount as number).toFixed(2)}€</td>
      </tr>`).join('')

  const invoiceStatusLabel: Record<string,string> = { paid:'Cobrada', pending:'Pendiente', overdue:'Vencida' }
  const invoiceStatusColor: Record<string,string> = { paid:'#4ade80', pending:'#fbbf24', overdue:'#f87171' }

  const invoiceRows = (invoices?.list ?? [])
    .slice(0, 10)
    .map((i: any) => `
      <tr>
        <td style="padding:8px 6px;border-bottom:1px solid #1a1a1a;font-weight:600;color:#fff;">${i.number || '—'}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #1a1a1a;color:#ccc;">${i.client}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #1a1a1a;font-weight:600;color:#4ade80;">${(i.total as number)?.toFixed(2)}€</td>
        <td style="padding:8px 6px;border-bottom:1px solid #1a1a1a;color:${invoiceStatusColor[i.status]||'#aaa'}">${invoiceStatusLabel[i.status]||i.status}</td>
      </tr>`).join('')

  const saldoColor = summary?.saldo >= 0 ? '#4ade80' : '#f87171'

  const noMovementsBlock = !has_movements ? `
    <div style="background:#1a1a1a;border-radius:8px;padding:20px;text-align:center;margin:24px 0;">
      <p style="color:#666;font-size:14px;">No hay movimientos registrados en este periodo.</p>
    </div>` : ''

  const summaryBlock = has_movements ? `
    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      <tr>
        <td style="padding:12px 0;color:#888;border-bottom:1px solid #222;">Ingresos</td>
        <td style="padding:12px 0;color:#4ade80;text-align:right;border-bottom:1px solid #222;font-weight:700;font-size:18px;">${summary.income.toFixed(2)}€</td>
      </tr>
      <tr>
        <td style="padding:12px 0;color:#888;border-bottom:1px solid #222;">Gastos</td>
        <td style="padding:12px 0;color:#f87171;text-align:right;border-bottom:1px solid #222;font-weight:700;font-size:18px;">${summary.expenses.toFixed(2)}€</td>
      </tr>
      <tr>
        <td style="padding:14px 0;color:#fff;font-weight:700;">Saldo neto</td>
        <td style="padding:14px 0;text-align:right;font-weight:800;font-size:22px;color:${saldoColor};">${summary.saldo.toFixed(2)}€</td>
      </tr>
    </table>` : ''

  const catBlock = has_movements && expenses_by_category?.length ? `
    <div style="margin:24px 0;">
      <p style="color:#555;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Gastos por categoría</p>
      <table style="width:100%;border-collapse:collapse;">${categoryRows}</table>
    </div>` : ''

  const invBlock = has_movements && invoices?.total > 0 ? `
    <div style="margin:24px 0;">
      <p style="color:#555;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">
        Facturas emitidas — ${invoices.total} total
        <span style="margin-left:12px;color:#4ade80">${invoices.paid} cobradas</span>
        <span style="margin-left:8px;color:#fbbf24">${invoices.pending} pendientes</span>
        ${invoices.overdue ? `<span style="margin-left:8px;color:#f87171">${invoices.overdue} vencidas</span>` : ''}
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="color:#555;"><th style="padding:6px;text-align:left;font-weight:400;">Nº</th><th style="padding:6px;text-align:left;font-weight:400;">Cliente</th><th style="padding:6px;font-weight:400;">Importe</th><th style="padding:6px;font-weight:400;">Estado</th></tr>
        ${invoiceRows}
      </table>
      ${invoices.total > 10 ? `<p style="color:#555;font-size:12px;text-align:center;margin-top:8px;">+ ${invoices.total - 10} facturas más en el portal</p>` : ''}
    </div>` : ''

  const subject = has_movements
    ? `📊 Cierre de ${period.label} — ${salon_name}`
    : `📋 Sin movimientos en ${period.label} — ${salon_name}`

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;margin:0;padding:0;">
  <div style="max-width:600px;margin:40px auto;padding:40px;background:#111;border-radius:12px;border:1px solid #222;">
    <div style="text-align:center;margin-bottom:28px;">
      <h1 style="font-size:22px;font-weight:800;color:#dc2626;margin:0;">🔥 DIABOLUS CRM</h1>
      <p style="color:#555;margin:6px 0 0;font-size:13px;">Entrega mensual automática</p>
    </div>
    <div style="background:#0d1117;border:1px solid #1e3a5f;border-radius:8px;padding:14px 16px;margin-bottom:20px;">
      <p style="margin:0;color:#93c5fd;font-size:14px;">📊 <strong>${period.label}</strong> · ${salon_name}</p>
      <p style="margin:4px 0 0;color:#555;font-size:12px;">Periodo: ${period.from} → ${period.to}</p>
    </div>
    <p style="color:#aaa;line-height:1.6;margin-bottom:8px;">Hola ${gestorName}, aquí tienes el cierre del mes de <strong style="color:#fff;">${period.label}</strong> de tu cliente <strong style="color:#fff;">${salon_name}</strong>.</p>
    ${noMovementsBlock}
    ${summaryBlock}
    ${catBlock}
    ${invBlock}
    <div style="text-align:center;margin:32px 0 24px;">
      <a href="${portalUrl}" style="background:#dc2626;color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block;">Ver detalle completo en el portal →</a>
    </div>
    <p style="color:#333;font-size:11px;text-align:center;border-top:1px solid #1e1e1e;padding-top:16px;margin-top:8px;">
      Diabolus CRM · Este informe no incluye estimaciones de IVA
    </p>
  </div>
</body></html>`

  return sendEmail(to, subject, html)
}

// ─── Email: Solicitud de revisión al cliente ──────────────────────────────────
export async function sendClosingReviewRequestEmail(
  to: string,
  salonName: string,
  gestorName: string,
  periodLabel: string,
  reviewUrl: string
) {
  const subject = `${gestorName} quiere enviarte el cierre de ${periodLabel} — dale el visto bueno`
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;margin:0;padding:0;">
  <div style="max-width:560px;margin:40px auto;padding:40px;background:#111;border-radius:12px;border:1px solid #222;">
    <div style="text-align:center;margin-bottom:28px;">
      <h1 style="font-size:22px;font-weight:800;color:#dc2626;margin:0;">🔥 DIABOLUS CRM</h1>
    </div>
    <div style="background:#1a0f00;border:1px solid #78350f;border-radius:8px;padding:14px 16px;margin-bottom:20px;">
      <p style="margin:0;color:#fbbf24;font-size:15px;font-weight:600;">📋 Cierre de ${periodLabel} listo para revisión</p>
    </div>
    <h2 style="color:#fff;font-size:18px;margin-bottom:12px;">Aprueba el cierre antes de que se envíe</h2>
    <p style="color:#aaa;line-height:1.6;margin-bottom:20px;">
      Tu gestor <strong style="color:#fff;">${gestorName}</strong> ha preparado el resumen contable de <strong style="color:#fff;">${periodLabel}</strong> para <strong style="color:#fff;">${salonName}</strong>.<br><br>
      Como tienes activada la revisión previa, necesitas darle el visto bueno antes de que llegue a tu gestor. Revísalo y pulsa "Aprobar".
    </p>
    <div style="background:#0e0e0e;border:1px solid #1e1e1e;border-radius:8px;padding:14px 16px;margin-bottom:24px;">
      <p style="margin:0 0 8px;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Qué incluye el cierre</p>
      <ul style="margin:0;padding:0 0 0 18px;color:#ccc;line-height:2;">
        <li>Ingresos y gastos del mes</li>
        <li>Gastos desglosados por categoría</li>
        <li>Facturas emitidas y su estado</li>
      </ul>
      <p style="margin:10px 0 0;color:#555;font-size:12px;">⚠️ No incluye estimaciones de IVA.</p>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${reviewUrl}" style="background:#dc2626;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;display:inline-block;">Revisar y aprobar →</a>
    </div>
    <p style="color:#555;font-size:12px;text-align:center;line-height:1.6;">
      Enlace válido 7 días. Si no haces nada, el cierre no se enviará automáticamente.
    </p>
    <p style="color:#333;font-size:12px;text-align:center;margin-top:24px;border-top:1px solid #1e1e1e;padding-top:16px;">
      Diabolus CRM · Tesorería que se gestiona hablando
    </p>
  </div>
</body></html>`

  return sendEmail(to, subject, html)
}

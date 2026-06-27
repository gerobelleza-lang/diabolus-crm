/**
 * Diabolus CRM — Ruta de Albaranes
 * POST /api/albaranes           → crear + email + registrar
 * GET  /api/albaranes           → listar albaranes del salón
 * GET  /api/albaranes/:id       → detalle
 *
 * Un albarán es un documento de entrega/prestación. No es factura oficial.
 * Se registra en la tabla invoices con prefix ALB- y status 'sent'.
 */

import { Hono } from 'hono'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { createClient } from '@supabase/supabase-js'

type Variables = { userId: string; salonId: string; userEmail: string; gestorId: string; usageWarning: boolean; salon_id: string }

const app = new Hono<{ Variables: Variables }>()

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Edge-compatible email via Resend REST API (no SDK)
async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || 'Diabolus CRM <noreply@diabolus.es>',
      to: [to],
      subject,
      html,
    }),
  })
  return res.ok
}

// ─── Autenticación JWT ────────────────────────────────────────────────────────
async function authMiddleware(c: any, next: any) {
  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  // Dev tokens
  if (token.startsWith('demo_') || token.startsWith('dev_')) {
    c.set('salon_id', c.req.query('salon_id') ||
      (await c.req.json().catch(() => ({}))).salon_id || 'e3cdcbf9-de82-44d8-81e4-e4348dce6714')
    return next()
  }

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) return c.json({ error: 'Unauthorized' }, 401)
  c.set('user', data.user)
  return next()
}

// ─── GET /api/albaranes — Listar ─────────────────────────────────────────────
app.get('/', authMiddleware, async (c) => {
  const body: any = c.req.query()
  const salon_id = body.salon_id || c.get('salon_id')
  if (!salon_id) return c.json({ error: 'salon_id requerido' }, 400)

  const { data, error } = await supabase
    .from('invoices')
    .select(`
      id, number, total, status, notes, created_at, sent_at, pdf_url,
      clients(id, name, email)
    `)
    .eq('salon_id', salon_id)
    .like('number', 'ALB-%')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ albaranes: data })
})

// ─── POST /api/albaranes — Crear ─────────────────────────────────────────────
app.post('/', authMiddleware, async (c) => {
  const body = await c.req.json()
  const {
    salon_id,
    client_id,
    client_name_override, // si no hay client_id
    client_email_override,
    items = [],           // [{ description, quantity, unit_price }]
    notes = '',
    send_email = true,
  } = body

  if (!salon_id) return c.json({ error: 'salon_id requerido' }, 400)
  if (!items.length) return c.json({ error: 'items requerido (mín. 1)' }, 400)

  // ── 1. Obtener datos del salón ──────────────────────────────────────────────
  const { data: salon } = await supabase
    .from('salons')
    .select('name, email, phone, address')
    .eq('id', salon_id)
    .single()

  // ── 2. Obtener / construir datos del cliente ────────────────────────────────
  let clientName = client_name_override || 'Cliente'
  let clientEmail = client_email_override || null

  if (client_id) {
    const { data: client } = await supabase
      .from('clients')
      .select('name, email, phone')
      .eq('id', client_id)
      .single()
    if (client) {
      clientName  = client.name  || clientName
      clientEmail = client.email || clientEmail
    }
  }

  // ── 3. Calcular totales ─────────────────────────────────────────────────────
  const lineItems = items.map((it: any) => ({
    description: it.description || 'Servicio',
    quantity:    Number(it.quantity   || 1),
    unit_price:  Number(it.unit_price || it.price || 0),
    subtotal:    Number(it.quantity || 1) * Number(it.unit_price || it.price || 0),
  }))
  const total = lineItems.reduce((s: number, l: any) => s + l.subtotal, 0)

  // ── 4. Número de albarán ────────────────────────────────────────────────────
  const now = new Date()
  const yy   = String(now.getFullYear()).slice(-2)
  const mm   = String(now.getMonth() + 1).padStart(2, '0')
  const rand = String(Math.floor(Math.random() * 900) + 100)
  const albNumber = `ALB-${yy}${mm}-${rand}`

  // ── 5. Insertar en invoices (sin pdf_url aún) ───────────────────────────────
  const { data: inv, error: invErr } = await supabase
    .from('invoices')
    .insert({
      salon_id,
      client_id: client_id || null,
      number: albNumber,
      total,
      status: 'sent',
      notes: notes || `Albarán generado automáticamente — ${clientName}`,
      issued_at: now.toISOString().split('T')[0],
    })
    .select()
    .single()

  if (invErr) return c.json({ error: invErr.message }, 500)

  // ── 6. Generar PDF ──────────────────────────────────────────────────────────
  let pdfBytes: Uint8Array | null = null
  try {
    const pdfDoc  = await PDFDocument.create()
    const page    = pdfDoc.addPage([595, 842]) // A4
    const { width, height } = page.getSize()

    const fontBold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
    const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica)

    const colorPurple = rgb(0.61, 0.46, 0.98)  // #9B76FB
    const colorDark   = rgb(0.08, 0.07, 0.14)
    const colorGray   = rgb(0.5, 0.5, 0.5)
    const colorLine   = rgb(0.88, 0.88, 0.88)

    let y = height - 60

    // ── Header band ──────────────────────────────────────────────────────────
    page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: colorDark })

    page.drawText('ALBARÁN', {
      x: 40, y: height - 50,
      size: 26, font: fontBold, color: colorPurple
    })
    page.drawText(albNumber, {
      x: 40, y: height - 72,
      size: 11, font: fontNormal, color: rgb(0.8, 0.8, 0.8)
    })

    const dateStr = now.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })
    page.drawText(dateStr, {
      x: width - 200, y: height - 50,
      size: 10, font: fontNormal, color: rgb(0.8, 0.8, 0.8)
    })

    // ── Emisor ───────────────────────────────────────────────────────────────
    y = height - 120
    page.drawText('EMISOR', { x: 40, y, size: 8, font: fontBold, color: colorGray })
    y -= 14
    page.drawText(salon?.name || 'Mi negocio', { x: 40, y, size: 12, font: fontBold, color: colorDark })
    if (salon?.email) { y -= 14; page.drawText(salon.email, { x: 40, y, size: 10, font: fontNormal, color: colorGray }) }
    if (salon?.phone) { y -= 13; page.drawText(salon.phone, { x: 40, y, size: 10, font: fontNormal, color: colorGray }) }

    // ── Cliente ───────────────────────────────────────────────────────────────
    let yc = height - 120
    page.drawText('DESTINATARIO', { x: 320, y: yc, size: 8, font: fontBold, color: colorGray })
    yc -= 14
    page.drawText(clientName, { x: 320, y: yc, size: 12, font: fontBold, color: colorDark })
    if (clientEmail) { yc -= 14; page.drawText(clientEmail, { x: 320, y: yc, size: 10, font: fontNormal, color: colorGray }) }

    // ── Línea separadora ─────────────────────────────────────────────────────
    y = Math.min(y, yc) - 24
    page.drawLine({ start: { x: 40, y }, end: { x: width - 40, y }, thickness: 0.5, color: colorLine })

    // ── Cabecera tabla ────────────────────────────────────────────────────────
    y -= 22
    page.drawRectangle({ x: 40, y: y - 4, width: width - 80, height: 22, color: rgb(0.96, 0.96, 0.99) })
    page.drawText('DESCRIPCIÓN',   { x: 48,       y: y + 5, size: 8.5, font: fontBold, color: colorGray })
    page.drawText('CANT.',         { x: 340,       y: y + 5, size: 8.5, font: fontBold, color: colorGray })
    page.drawText('P. UNIT.',      { x: 390,       y: y + 5, size: 8.5, font: fontBold, color: colorGray })
    page.drawText('SUBTOTAL',      { x: 460,       y: y + 5, size: 8.5, font: fontBold, color: colorGray })
    y -= 6

    // ── Líneas ────────────────────────────────────────────────────────────────
    for (const line of lineItems) {
      y -= 20
      page.drawLine({ start: { x: 40, y }, end: { x: width - 40, y }, thickness: 0.3, color: colorLine })
      y -= 2
      const desc = String(line.description).slice(0, 55)
      page.drawText(desc,                   { x: 48,  y, size: 10, font: fontNormal, color: colorDark })
      page.drawText(String(line.quantity),  { x: 348, y, size: 10, font: fontNormal, color: colorDark })
      page.drawText(`${line.unit_price.toFixed(2)} €`, { x: 390, y, size: 10, font: fontNormal, color: colorDark })
      page.drawText(`${line.subtotal.toFixed(2)} €`,   { x: 460, y, size: 10, font: fontBold,   color: colorDark })
    }

    // ── Total ─────────────────────────────────────────────────────────────────
    y -= 28
    page.drawLine({ start: { x: 360, y }, end: { x: width - 40, y }, thickness: 1, color: colorPurple })
    y -= 18
    page.drawText('TOTAL', { x: 380, y, size: 11, font: fontBold, color: colorGray })
    page.drawText(`${total.toFixed(2)} €`, { x: 450, y, size: 14, font: fontBold, color: colorPurple })

    // ── Notas ─────────────────────────────────────────────────────────────────
    if (notes) {
      y -= 40
      page.drawText('Notas:', { x: 40, y, size: 9, font: fontBold, color: colorGray })
      y -= 14
      page.drawText(String(notes).slice(0, 120), { x: 40, y, size: 9, font: fontNormal, color: colorGray })
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    page.drawText('Documento generado por Diabolus CRM · diabolus.es · No tiene valor fiscal.', {
      x: 40, y: 30, size: 7.5, font: fontNormal, color: colorGray
    })

    pdfBytes = await pdfDoc.save()
  } catch (pdfErr) {
    console.error('PDF generation error:', pdfErr)
  }

  // ── 7. Subir PDF a Storage ──────────────────────────────────────────────────
  let pdfUrl: string | null = null
  if (pdfBytes) {
    try {
      const filePath = `${salon_id}/albaranes/${inv.id}.pdf`
      const { error: storErr } = await supabase.storage
        .from('invoices')
        .upload(filePath, pdfBytes, { contentType: 'application/pdf', upsert: true })

      if (!storErr) {
        const { data: signed } = await supabase.storage
          .from('invoices')
          .createSignedUrl(filePath, 900) // 15 min
        pdfUrl = signed?.signedUrl || null

        // Actualizar registro con pdf_url
        await supabase.from('invoices').update({ pdf_url: filePath }).eq('id', inv.id)
      }
    } catch (e) {
      console.error('Storage error:', e)
    }
  }

  // ── 8. Enviar email al cliente ──────────────────────────────────────────────
  let emailSent = false
  if (send_email && clientEmail && pdfBytes) {
    try {
      const emailHtml = `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e">
            <div style="background:#050508;padding:32px;border-radius:12px 12px 0 0;text-align:center">
              <h1 style="color:#9B76FB;font-size:28px;font-weight:800;margin:0">DIABOLUS</h1>
              <p style="color:#888;font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin:6px 0 0">Centro de mando inteligente</p>
            </div>
            <div style="background:#fff;padding:32px;border-radius:0 0 12px 12px;border:1px solid #eee">
              <h2 style="color:#1a1a2e;font-size:20px;margin:0 0 8px">Albarán ${albNumber}</h2>
              <p style="color:#555;margin:0 0 20px">Hola <strong>${clientName}</strong>,</p>
              <p style="color:#555">Te adjuntamos el albarán correspondiente a los servicios prestados por <strong>${salon?.name || 'tu proveedor'}</strong>.</p>
              <table style="width:100%;border-collapse:collapse;margin:24px 0">
                ${lineItems.map((l: any) => `
                  <tr style="border-bottom:1px solid #eee">
                    <td style="padding:10px 0;color:#333">${l.description}</td>
                    <td style="padding:10px 0;color:#666;text-align:center">${l.quantity}×</td>
                    <td style="padding:10px 0;color:#333;text-align:right">${l.subtotal.toFixed(2)} €</td>
                  </tr>
                `).join('')}
                <tr>
                  <td colspan="2" style="padding:14px 0;font-weight:700;color:#1a1a2e">TOTAL</td>
                  <td style="padding:14px 0;font-weight:700;color:#9B76FB;text-align:right;font-size:18px">${total.toFixed(2)} €</td>
                </tr>
              </table>
              ${notes ? `<p style="color:#777;font-size:13px;background:#f9f9f9;padding:12px;border-radius:8px">${notes}</p>` : ''}
              <p style="color:#aaa;font-size:12px;margin-top:24px">Este albarán ha sido generado automáticamente. No tiene valor fiscal.</p>
            </div>
          </div>`
      emailSent = await sendEmail(
        clientEmail,
        `Albarán ${albNumber} — ${salon?.name || 'Tu proveedor'}`,
        emailHtml
      )
    } catch (e) {
      console.error('Email error:', e)
    }
  }

  // ── 9. Registrar en audit_log ───────────────────────────────────────────────
  await supabase.from('audit_log').insert({
    salon_id,
    tool_name: 'crear_albaran',
    payload: { albNumber, client_id, clientName, total, items_count: lineItems.length },
    result: { invoice_id: inv.id, email_sent: emailSent, pdf_generated: !!pdfBytes },
    confirmed: true,
    level: 'L0',
  }).then(() => {})

  return c.json({
    ok: true,
    albaran: {
      id: inv.id,
      number: albNumber,
      total,
      client: { name: clientName, email: clientEmail },
      email_sent: emailSent,
      pdf_url: pdfUrl,
      items: lineItems,
    },
    message: `✅ Albarán ${albNumber} creado${emailSent ? ` y enviado a ${clientEmail}` : ''}. Total: ${total.toFixed(2)} €.`
  })
})

export { app as albaranRoute }

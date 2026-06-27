// invoice-pdf.ts — Edge Runtime compatible (pdf-lib, no Node.js APIs)
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

/**
 * Genera un PDF de factura profesional usando pdf-lib (Edge Runtime compatible).
 * Devuelve Uint8Array para subir a Supabase Storage o streaming directo.
 */
export async function generateInvoicePDF(invoice: any): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842]) // A4

  const fontBold    = await doc.embedFont(StandardFonts.HelveticaBold)
  const font        = await doc.embedFont(StandardFonts.Helvetica)
  const fontOblique = await doc.embedFont(StandardFonts.HelveticaOblique)

  const { width, height } = page.getSize()
  const margin   = 50
  const colRight = width - margin

  // ── Colores ─────────────────────────────────────────────────────
  const black     = rgb(0.05, 0.05, 0.05)
  const gray      = rgb(0.45, 0.45, 0.45)
  const lightGray = rgb(0.92, 0.92, 0.92)
  const accent    = rgb(0.43, 0.09, 0.57)   // Diabolus purple
  const accentPale = rgb(0.95, 0.92, 1.0)
  const white     = rgb(1, 1, 1)

  // ── Datos del salón ──────────────────────────────────────────────
  const salonName        = invoice.salons?.name           || 'Diabolus CRM'
  const salonNombreFiscal = invoice.salons?.nombre_fiscal || salonName
  const salonNif         = invoice.salons?.nif            || ''
  const salonAddress     = invoice.salons?.address        || ''
  const salonEmail       = invoice.salons?.email          || ''
  const salonPhone       = invoice.salons?.phone          || ''

  // ── Datos de factura ────────────────────────────────────────────
  const invoiceNum = invoice.number || `FAC-${(invoice.id || '').slice(0, 8).toUpperCase()}`
  const invoiceDate = invoice.date
    ? new Date(invoice.date).toLocaleDateString('es-ES')
    : new Date(invoice.created_at).toLocaleDateString('es-ES')
  const dueDate = invoice.due_date
    ? new Date(invoice.due_date).toLocaleDateString('es-ES')
    : null

  const ivaPct    = Number(invoice.iva_pct ?? 21)
  const total     = Number(invoice.total ?? 0)
  // base = amount si existe, sino derivar del total
  const base      = Number(invoice.amount ?? 0) > 0
    ? Number(invoice.amount)
    : total / (1 + ivaPct / 100)
  const ivaAmount = total - base
  const description = invoice.description || 'Servicios profesionales'

  // ── HEADER morado ────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: height - 115, width, height: 115, color: accent })

  // Nombre del salón
  page.drawText(salonName, {
    x: margin, y: height - 52,
    size: 22, font: fontBold, color: white
  })

  // Subtítulo fiscal
  const fiscalLine = [salonNombreFiscal !== salonName ? salonNombreFiscal : '', salonNif].filter(Boolean).join('  ·  ')
  if (fiscalLine) {
    page.drawText(fiscalLine, {
      x: margin, y: height - 70,
      size: 9, font, color: rgb(0.88, 0.80, 1)
    })
  }
  if (salonAddress) {
    page.drawText(salonAddress, {
      x: margin, y: height - 84,
      size: 8.5, font, color: rgb(0.76, 0.68, 0.92)
    })
  }
  if (salonEmail || salonPhone) {
    page.drawText([salonEmail, salonPhone].filter(Boolean).join('  ·  '), {
      x: margin, y: height - 97,
      size: 8, font, color: rgb(0.70, 0.62, 0.85)
    })
  }

  // "FACTURA" top-right
  const facLabel = 'FACTURA'
  page.drawText(facLabel, {
    x: colRight - fontBold.widthOfTextAtSize(facLabel, 24),
    y: height - 54, size: 24, font: fontBold, color: white
  })
  page.drawText(invoiceNum, {
    x: colRight - font.widthOfTextAtSize(invoiceNum, 11),
    y: height - 78, size: 11, font, color: rgb(0.90, 0.85, 1)
  })

  let y = height - 145

  // ── Fila de fechas + estado ───────────────────────────────────────
  page.drawText('Fecha emisión:', { x: margin,       y, size: 9, font: fontBold, color: gray })
  page.drawText(invoiceDate,      { x: margin + 90,  y, size: 9, font,           color: black })

  if (dueDate) {
    page.drawText('Vencimiento:', { x: margin + 210, y, size: 9, font: fontBold, color: gray })
    page.drawText(dueDate,        { x: margin + 295, y, size: 9, font,           color: black })
  }

  // Badge de estado
  const statusMap: Record<string, [string, any]> = {
    pending: ['PENDIENTE', rgb(0.96, 0.62, 0.04)],
    paid:    ['COBRADA',   rgb(0.06, 0.73, 0.51)],
    overdue: ['VENCIDA',   rgb(0.94, 0.27, 0.27)],
    sent:    ['ENVIADA',   rgb(0.30, 0.60, 0.95)],
    draft:   ['BORRADOR',  gray],
  }
  const [statusLabel, statusColor] = statusMap[invoice.status] || ['BORRADOR', gray]
  const bw = fontBold.widthOfTextAtSize(statusLabel, 9) + 16
  page.drawRectangle({ x: colRight - bw, y: y - 4, width: bw, height: 18, color: statusColor, opacity: 0.15 })
  page.drawText(statusLabel, { x: colRight - bw + 8, y, size: 9, font: fontBold, color: statusColor })

  y -= 22
  page.drawLine({ start: { x: margin, y }, end: { x: colRight, y }, thickness: 0.5, color: lightGray })

  // ── EMISOR | CLIENTE ─────────────────────────────────────────────
  const col2 = width / 2 + 10
  y -= 20
  page.drawText('EMISOR',  { x: margin, y, size: 8, font: fontBold, color: accent })
  page.drawText('CLIENTE', { x: col2,   y, size: 8, font: fontBold, color: accent })

  y -= 15
  page.drawText(salonNombreFiscal || salonName, { x: margin, y, size: 11, font: fontBold, color: black })
  page.drawText(invoice.clients?.name || 'Cliente', { x: col2, y, size: 11, font: fontBold, color: black })

  y -= 15
  if (salonNif) {
    page.drawText(`NIF: ${salonNif}`, { x: margin, y, size: 9, font, color: gray })
  }
  if (invoice.clients?.email) {
    page.drawText(invoice.clients.email, { x: col2, y, size: 9, font, color: gray })
  }

  y -= 13
  if (salonEmail) {
    page.drawText(salonEmail, { x: margin, y, size: 9, font, color: gray })
  }
  if (invoice.clients?.phone) {
    page.drawText(`Tel: ${invoice.clients.phone}`, { x: col2, y, size: 9, font, color: gray })
  }

  y -= 30
  page.drawLine({ start: { x: margin, y }, end: { x: colRight, y }, thickness: 0.5, color: lightGray })

  // ── TABLA DE LÍNEAS ──────────────────────────────────────────────
  y -= 18
  // Cabecera tabla
  page.drawRectangle({ x: margin, y: y - 5, width: colRight - margin, height: 22, color: accentPale })
  page.drawText('CONCEPTO / DESCRIPCIÓN', { x: margin + 8, y,           size: 8.5, font: fontBold, color: accent })
  page.drawText('BASE',                    { x: colRight - 170, y,       size: 8.5, font: fontBold, color: accent })
  page.drawText(`IVA (${ivaPct}%)`,        { x: colRight - 110, y,       size: 8.5, font: fontBold, color: accent })
  page.drawText('TOTAL',                   { x: colRight - 50,  y,       size: 8.5, font: fontBold, color: accent })

  y -= 28
  // Texto del concepto (con word-wrap)
  const maxDescWidth = colRight - margin - 185
  const words = description.split(' ')
  let line = ''
  const lineStartY = y
  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(testLine, 10) > maxDescWidth && line) {
      page.drawText(line, { x: margin + 8, y, size: 10, font, color: black })
      y -= 14; line = word
    } else {
      line = testLine
    }
  }
  if (line) {
    page.drawText(line, { x: margin + 8, y, size: 10, font, color: black })
  }

  // Importes alineados a la primera línea del concepto
  page.drawText(`${base.toFixed(2)} €`,      { x: colRight - 170, y: lineStartY, size: 10, font,     color: black })
  page.drawText(`${ivaAmount.toFixed(2)} €`, { x: colRight - 110, y: lineStartY, size: 10, font,     color: black })
  page.drawText(`${total.toFixed(2)} €`,     { x: colRight - 50,  y: lineStartY, size: 10, font: fontBold, color: black })

  y -= 20
  page.drawLine({ start: { x: margin, y }, end: { x: colRight, y }, thickness: 0.5, color: lightGray })

  // ── RESUMEN DE TOTALES ────────────────────────────────────────────
  y -= 14
  const totLabelX = colRight - 200
  const totValX   = colRight - 55

  page.drawText('Base imponible:',    { x: totLabelX, y, size: 10, font,     color: gray })
  page.drawText(`${base.toFixed(2)} €`, { x: totValX - font.widthOfTextAtSize(`${base.toFixed(2)} €`, 10), y, size: 10, font, color: black })

  y -= 15
  page.drawText(`IVA (${ivaPct}%):`,  { x: totLabelX, y, size: 10, font,     color: gray })
  page.drawText(`${ivaAmount.toFixed(2)} €`, { x: totValX - font.widthOfTextAtSize(`${ivaAmount.toFixed(2)} €`, 10), y, size: 10, font, color: black })

  y -= 22
  // Caja total
  page.drawRectangle({ x: colRight - 230, y: y - 9, width: 235, height: 34, color: accent })
  page.drawText('TOTAL A PAGAR:', { x: colRight - 220, y: y + 4, size: 12, font: fontBold, color: white })
  const totalStr = `${total.toFixed(2)} €`
  page.drawText(totalStr, {
    x: colRight - fontBold.widthOfTextAtSize(totalStr, 13) - 5,
    y: y + 4, size: 13, font: fontBold, color: white
  })

  // ── PIE ──────────────────────────────────────────────────────────
  const footerY = 55
  page.drawLine({ start: { x: margin, y: footerY }, end: { x: colRight, y: footerY }, thickness: 0.5, color: lightGray })
  page.drawText(
    `Generado con Diabolus CRM · ${new Date().toLocaleDateString('es-ES')}`,
    { x: margin, y: footerY - 14, size: 7.5, font, color: gray }
  )
  page.drawText(
    'Documento orientativo. No tiene validez fiscal oficial. Consulte con su gestor.',
    { x: margin, y: footerY - 26, size: 7.5, font: fontOblique, color: rgb(0.68, 0.68, 0.68) }
  )

  return doc.save()
}

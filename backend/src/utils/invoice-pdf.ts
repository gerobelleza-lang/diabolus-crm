// @ts-nocheck
// invoice-pdf.ts — Edge Runtime compatible (pdf-lib, no Node.js APIs)
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

/**
 * Genera un PDF de factura usando pdf-lib (Edge Runtime compatible).
 * Devuelve Uint8Array para subir a Supabase Storage.
 */
export async function generateInvoicePDF(invoice: any): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842]) // A4

  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold)
  const helvetica = await doc.embedFont(StandardFonts.Helvetica)

  const { width, height } = page.getSize()
  const margin = 50
  const colRight = width - margin

  const black = rgb(0.05, 0.05, 0.05)
  const gray = rgb(0.4, 0.4, 0.4)
  const accent = rgb(0.55, 0.1, 0.9)
  const lightGray = rgb(0.95, 0.95, 0.95)

  // Cabecera morada
  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: accent })

  const salonName = invoice.salons?.name || 'Diabolus CRM'
  page.drawText(salonName, { x: margin, y: height - 52, size: 22, font: helveticaBold, color: rgb(1,1,1) })
  page.drawText('FACTURA', { x: colRight - 100, y: height - 52, size: 22, font: helveticaBold, color: rgb(1,1,1) })

  const invoiceNum = invoice.number || `INV-${invoice.id?.slice(0, 8).toUpperCase()}`
  const invoiceDate = invoice.date
    ? new Date(invoice.date).toLocaleDateString('es-ES')
    : new Date(invoice.created_at).toLocaleDateString('es-ES')
  const total = Number(invoice.total ?? invoice.amount ?? 0)

  let y = height - 110

  page.drawText(`Numero: ${invoiceNum}`, { x: margin, y, size: 11, font: helveticaBold, color: black })
  page.drawText(`Fecha: ${invoiceDate}`, { x: colRight - 150, y, size: 11, font: helvetica, color: gray })
  y -= 20
  page.drawText(`Estado: ${(invoice.status || 'draft').toUpperCase()}`, { x: margin, y, size: 10, font: helvetica, color: gray })

  y -= 20
  page.drawLine({ start: { x: margin, y }, end: { x: colRight, y }, thickness: 1, color: lightGray })

  // Cliente
  y -= 30
  page.drawText('CLIENTE', { x: margin, y, size: 9, font: helveticaBold, color: accent })
  y -= 16
  page.drawText(invoice.clients?.name || 'Cliente', { x: margin, y, size: 13, font: helveticaBold, color: black })
  if (invoice.clients?.email) {
    y -= 16
    page.drawText(invoice.clients.email, { x: margin, y, size: 10, font: helvetica, color: gray })
  }
  if (invoice.clients?.phone) {
    y -= 14
    page.drawText(invoice.clients.phone, { x: margin, y, size: 10, font: helvetica, color: gray })
  }

  y -= 30
  page.drawLine({ start: { x: margin, y }, end: { x: colRight, y }, thickness: 1, color: lightGray })

  // Concepto
  y -= 30
  page.drawText('CONCEPTO', { x: margin, y, size: 9, font: helveticaBold, color: accent })
  page.drawText('IMPORTE', { x: colRight - 80, y, size: 9, font: helveticaBold, color: accent })
  y -= 20

  const description = invoice.description || 'Servicios profesionales'
  const words = description.split(' ')
  let line = ''
  const maxWidth = width - margin * 2 - 100
  const firstY = y
  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word
    const testWidth = helvetica.widthOfTextAtSize(testLine, 11)
    if (testWidth > maxWidth && line) {
      page.drawText(line, { x: margin, y, size: 11, font: helvetica, color: black })
      y -= 16
      line = word
    } else {
      line = testLine
    }
  }
  if (line) {
    page.drawText(line, { x: margin, y, size: 11, font: helvetica, color: black })
    y -= 16
  }
  page.drawText(`EUR${total.toFixed(2)}`, { x: colRight - 80, y: firstY, size: 11, font: helveticaBold, color: black })

  // Totales
  y -= 30
  page.drawLine({ start: { x: margin, y }, end: { x: colRight, y }, thickness: 1, color: lightGray })
  y -= 20
  const base = total / 1.21
  const iva = total - base
  page.drawText('Base imponible:', { x: colRight - 200, y, size: 10, font: helvetica, color: gray })
  page.drawText(`EUR${base.toFixed(2)}`, { x: colRight - 80, y, size: 10, font: helvetica, color: gray })
  y -= 16
  page.drawText('IVA (21%):', { x: colRight - 200, y, size: 10, font: helvetica, color: gray })
  page.drawText(`EUR${iva.toFixed(2)}`, { x: colRight - 80, y, size: 10, font: helvetica, color: gray })
  y -= 20
  page.drawRectangle({ x: colRight - 220, y: y - 8, width: 220 + margin, height: 34, color: accent })
  page.drawText('TOTAL:', { x: colRight - 200, y: y + 4, size: 13, font: helveticaBold, color: rgb(1,1,1) })
  page.drawText(`EUR${total.toFixed(2)}`, { x: colRight - 80, y: y + 4, size: 13, font: helveticaBold, color: rgb(1,1,1) })

  // Pie
  page.drawText('Generado con Diabolus CRM', { x: margin, y: 30, size: 8, font: helvetica, color: gray })

  return doc.save()
}

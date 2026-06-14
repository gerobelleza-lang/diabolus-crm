// @ts-nocheck
/**
 * Diabolus CRM — Invoice PDF Generator
 * Genera PDFs de factura con diseño profesional usando pdfkit
 */

import PDFDocument from 'pdfkit'

export interface InvoiceData {
  id: string
  invoice_number?: string
  amount: number
  description: string
  status: string
  created_at: string
  clients: {
    name: string
    email?: string
    phone?: string
  }
  salons?: {
    name: string
    email?: string
    phone?: string
    address?: string
    nif?: string
  }
  hash?: string
}

export async function generateInvoicePDF(invoice: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `Factura ${invoice.invoice_number || invoice.id.slice(0, 8).toUpperCase()}`,
        Author: 'Diabolus CRM',
        Subject: 'Factura',
      },
    })

    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    // ── Colores corporativos ──
    const ROJO = '#E53E3E'
    const NEGRO = '#1A202C'
    const GRIS = '#718096'
    const GRIS_CLARO = '#F7FAFC'
    const BORDE = '#E2E8F0'

    const pageWidth = doc.page.width
    const margin = 50

    // ── HEADER — Franja roja ──
    doc.rect(0, 0, pageWidth, 110).fill(NEGRO)

    // Logo Diabolus
    doc
      .fontSize(28)
      .font('Helvetica-Bold')
      .fillColor('#FFFFFF')
      .text('DIABOLUS', margin, 30)

    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor('#FC8181')
      .text('CRM · Gestión Inteligente', margin, 62)

    // Badge FACTURA
    doc.rect(pageWidth - 180, 25, 130, 60).fill(ROJO)
    doc
      .fontSize(14)
      .font('Helvetica-Bold')
      .fillColor('#FFFFFF')
      .text('FACTURA', pageWidth - 175, 38, { width: 120, align: 'center' })

    const invoiceNum = invoice.invoice_number || `INV-${invoice.id.slice(0, 8).toUpperCase()}`
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#FECACA')
      .text(invoiceNum, pageWidth - 175, 57, { width: 120, align: 'center' })

    // ── Datos del emisor (salón) ──
    doc.moveDown(4)
    const topY = 130

    doc
      .fontSize(11)
      .font('Helvetica-Bold')
      .fillColor(NEGRO)
      .text('DE:', margin, topY)
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor(NEGRO)
      .text(invoice.salons?.name || 'Mi Negocio', margin, topY + 16)

    if (invoice.salons?.nif) {
      doc.fontSize(9).fillColor(GRIS).text(`NIF: ${invoice.salons.nif}`, margin, topY + 30)
    }
    if (invoice.salons?.email) {
      doc.fontSize(9).fillColor(GRIS).text(invoice.salons.email, margin, topY + 44)
    }
    if (invoice.salons?.phone) {
      doc.fontSize(9).fillColor(GRIS).text(invoice.salons.phone, margin, topY + 58)
    }

    // ── Datos del cliente ──
    const colRight = pageWidth / 2 + 20
    doc
      .fontSize(11)
      .font('Helvetica-Bold')
      .fillColor(NEGRO)
      .text('PARA:', colRight, topY)
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor(NEGRO)
      .text(invoice.clients?.name || 'Cliente', colRight, topY + 16)
    if (invoice.clients?.email) {
      doc.fontSize(9).fillColor(GRIS).text(invoice.clients.email, colRight, topY + 30)
    }
    if (invoice.clients?.phone) {
      doc.fontSize(9).fillColor(GRIS).text(invoice.clients.phone, colRight, topY + 44)
    }

    // ── Línea separadora ──
    const sepY = topY + 85
    doc.rect(margin, sepY, pageWidth - margin * 2, 1).fill(BORDE)

    // ── Meta datos ──
    const metaY = sepY + 15
    const fecha = new Date(invoice.created_at).toLocaleDateString('es-ES', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    })

    doc.fontSize(9).font('Helvetica').fillColor(GRIS)
    doc.text(`Fecha de emisión: ${fecha}`, margin, metaY)
    doc.text(`Nº Factura: ${invoiceNum}`, margin, metaY + 14)
    doc.text(`Estado: ${invoice.status === 'paid' ? '✓ Pagada' : 'Pendiente'}`, margin, metaY + 28)

    // ── Tabla de conceptos ──
    const tableY = metaY + 60

    // Cabecera tabla
    doc.rect(margin, tableY, pageWidth - margin * 2, 30).fill(NEGRO)
    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor('#FFFFFF')
      .text('CONCEPTO', margin + 12, tableY + 9)
    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor('#FFFFFF')
      .text('IMPORTE', pageWidth - margin - 90, tableY + 9)

    // Fila de concepto
    const rowY = tableY + 30
    doc.rect(margin, rowY, pageWidth - margin * 2, 45).fill(GRIS_CLARO)
    doc.rect(margin, rowY, pageWidth - margin * 2, 45).stroke(BORDE)

    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor(NEGRO)
      .text(invoice.description || 'Servicios profesionales', margin + 12, rowY + 8, {
        width: pageWidth - margin * 2 - 120,
      })

    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor(NEGRO)
      .text(`€${Number(invoice.amount).toFixed(2)}`, pageWidth - margin - 90, rowY + 8)

    // ── Total ──
    const totalY = rowY + 55
    doc.rect(pageWidth - 230, totalY, 180, 45).fill(ROJO)

    doc
      .fontSize(12)
      .font('Helvetica-Bold')
      .fillColor('#FFFFFF')
      .text('TOTAL', pageWidth - 220, totalY + 8)

    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .fillColor('#FFFFFF')
      .text(`€${Number(invoice.amount).toFixed(2)}`, pageWidth - 220, totalY + 23)

    // ── Hash / Firma digital ──
    if (invoice.hash) {
      const hashY = totalY + 70
      doc.rect(margin, hashY, pageWidth - margin * 2, 40).fill('#FFF5F5')
      doc.rect(margin, hashY, pageWidth - margin * 2, 40).stroke('#FEB2B2')

      doc
        .fontSize(8)
        .font('Helvetica-Bold')
        .fillColor(ROJO)
        .text('🔐 FIRMA DIGITAL DIABOLUS', margin + 10, hashY + 8)

      doc
        .fontSize(7)
        .font('Helvetica')
        .fillColor(GRIS)
        .text(`Hash: ${invoice.hash.slice(0, 64)}...`, margin + 10, hashY + 22, {
          width: pageWidth - margin * 2 - 20,
        })
    }

    // ── Footer ──
    const footerY = doc.page.height - 60
    doc.rect(0, footerY, pageWidth, 60).fill(NEGRO)

    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#718096')
      .text(
        'Generado por Diabolus CRM · diabolus-crm-api.vercel.app · Documento con validez fiscal',
        margin,
        footerY + 12,
        { align: 'center', width: pageWidth - margin * 2 }
      )

    doc
      .fontSize(7)
      .fillColor('#4A5568')
      .text(
        `Generado el ${new Date().toLocaleString('es-ES')}`,
        margin,
        footerY + 30,
        { align: 'center', width: pageWidth - margin * 2 }
      )

    doc.end()
  })
}

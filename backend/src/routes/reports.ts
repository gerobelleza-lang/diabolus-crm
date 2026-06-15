// @ts-nocheck
// backend/src/routes/reports.ts
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

type Variables = { userId: string; salonId: string }
export const reportRoutes = new Hono<{ Variables: Variables }>()

// GET /api/reports/trimestral?year=2026&quarter=2&format=pdf|json
reportRoutes.get('/trimestral', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const now = new Date()
  const year = parseInt(c.req.query('year') || String(now.getFullYear()))
  const quarter = parseInt(c.req.query('quarter') || String(Math.ceil((now.getMonth() + 1) / 3)))
  const format = c.req.query('format') || 'pdf'

  if (quarter < 1 || quarter > 4) return c.json({ error: 'quarter must be 1–4' }, 400)

  const startMonth = (quarter - 1) * 3 + 1
  const endMonth = quarter * 3
  const startDate = `${year}-${String(startMonth).padStart(2, '0')}-01`
  const lastDay = new Date(year, endMonth, 0).getDate()
  const endDate = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  // Transactions
  const { data: transactions, error: txError } = await supabase
    .from('transactions')
    .select('amount, type, date, description')
    .eq('salon_id', salonId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })

  if (txError) return c.json({ error: txError.message }, 500)

  // Invoices
  const { data: invoices, error: invError } = await supabase
    .from('invoices')
    .select('total, status, issue_date, number, clients(name)')
    .eq('salon_id', salonId)
    .gte('issue_date', startDate)
    .lte('issue_date', endDate)

  if (invError) return c.json({ error: invError.message }, 500)

  // ── Cálculos ───────────────────────────────────────────────────────────────
  const ingresos = (transactions || []).filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0)
  const gastos   = (transactions || []).filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0)
  const beneficio = ingresos - gastos

  const ivaRepercutido = ingresos * 0.21
  const ivaSoportado   = gastos   * 0.21
  const ivaLiquidar    = ivaRepercutido - ivaSoportado
  const irpf           = beneficio > 0 ? beneficio * 0.20 : 0

  const facturasTotales   = (invoices || []).length
  const facturasCobradas  = (invoices || []).filter(i => i.status === 'paid').length
  const facturasPendientes = (invoices || []).filter(i => ['pending', 'sent'].includes(i.status)).length
  const facturasVencidas  = (invoices || []).filter(i => i.status === 'overdue').length

  const quarterNames = ['', 'T1 (Ene–Mar)', 'T2 (Abr–Jun)', 'T3 (Jul–Sep)', 'T4 (Oct–Dic)']
  const fmt = (n: number) => `${n.toFixed(2)} €`

  // ── JSON ───────────────────────────────────────────────────────────────────
  if (format === 'json') {
    return c.json({
      periodo: `${quarterNames[quarter]} ${year}`,
      year, quarter,
      fechas: { desde: startDate, hasta: endDate },
      ingresos, gastos, beneficio,
      iva: { repercutido: ivaRepercutido, soportado: ivaSoportado, liquidar: ivaLiquidar },
      irpf_estimado: irpf,
      facturas: { total: facturasTotales, cobradas: facturasCobradas, pendientes: facturasPendientes, vencidas: facturasVencidas },
      num_transacciones: transactions?.length || 0,
    })
  }

  // ── PDF ────────────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create()
  const page   = pdfDoc.addPage([595.28, 841.89]) // A4
  const { width, height } = page.getSize()

  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const BLACK  = rgb(0.1, 0.1, 0.1)
  const RED    = rgb(0.75, 0.1, 0.1)
  const GREEN  = rgb(0.1, 0.45, 0.1)
  const GRAY   = rgb(0.5, 0.5, 0.5)
  const BLUE   = rgb(0.08, 0.08, 0.45)
  const ORANGE = rgb(0.8, 0.45, 0)
  const WHITE  = rgb(1, 1, 1)

  let y = height - 55

  // Header
  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: BLUE })
  page.drawText('DIABOLUS CRM', { x: 50, y: height - 40, font: bold, size: 24, color: WHITE })
  page.drawText(
    `Informe Trimestral · ${quarterNames[quarter]} ${year}`,
    { x: 50, y: height - 62, font: regular, size: 13, color: rgb(0.8, 0.8, 1) }
  )

  y = height - 108

  // Section helper
  const section = (title: string) => {
    y -= 6
    page.drawRectangle({ x: 45, y: y - 5, width: width - 90, height: 22, color: rgb(0.93, 0.93, 0.97) })
    page.drawText(title, { x: 52, y: y + 2, font: bold, size: 11, color: BLUE })
    y -= 24
  }

  const row = (label: string, value: string, valueColor = BLACK, isBold = false) => {
    page.drawText(label, { x: 62, y, font: regular, size: 10, color: GRAY })
    if (value) page.drawText(value, { x: 390, y, font: isBold ? bold : regular, size: 10, color: valueColor })
    y -= 18
  }

  const divider = () => {
    y -= 2
    page.drawLine({ start: { x: 62, y }, end: { x: width - 62, y }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) })
    y -= 8
  }

  // Resumen económico
  section('RESUMEN ECONÓMICO')
  row('Ingresos totales', fmt(ingresos), GREEN)
  row('Gastos totales', fmt(gastos), RED)
  divider()
  row('Beneficio neto', fmt(beneficio), beneficio >= 0 ? GREEN : RED, true)

  y -= 10

  // Estimación fiscal
  section('ESTIMACIÓN FISCAL (orientativa)')
  row('IVA repercutido  (21% s/ ingresos)', fmt(ivaRepercutido))
  row('IVA soportado  (21% s/ gastos)', fmt(ivaSoportado))
  divider()
  row('IVA neto a liquidar  →  Modelo 303', fmt(ivaLiquidar), ivaLiquidar >= 0 ? RED : GREEN, true)
  y -= 4
  row('IRPF pago fraccionado  →  Modelo 130', fmt(irpf), RED, true)
  row('(Solo estimación orientativa — confirma con tu gestoría)', '')

  y -= 10

  // Facturación
  section('FACTURACIÓN DEL TRIMESTRE')
  row('Total facturas emitidas', String(facturasTotales))
  row('Cobradas', String(facturasCobradas), GREEN)
  row('Pendientes de cobro', String(facturasPendientes), ORANGE)
  row('Vencidas sin cobrar', String(facturasVencidas), RED)

  y -= 10

  // Últimos movimientos
  section('ÚLTIMOS MOVIMIENTOS')
  const lastTx = (transactions || []).slice(-10)
  if (lastTx.length === 0) {
    page.drawText('Sin movimientos registrados en este periodo', { x: 62, y, font: regular, size: 10, color: GRAY })
    y -= 18
  } else {
    for (const tx of lastTx) {
      const sign  = tx.type === 'income' ? '+' : '–'
      const color = tx.type === 'income' ? GREEN : RED
      const desc  = (tx.description || 'Sin descripción').slice(0, 48)
      const dateStr = tx.date ? new Date(tx.date).toLocaleDateString('es-ES') : ''
      page.drawText(dateStr, { x: 62, y, font: regular, size: 9, color: GRAY })
      page.drawText(desc,    { x: 118, y, font: regular, size: 9, color: BLACK })
      page.drawText(`${sign}${Number(tx.amount).toFixed(2)} €`, { x: 430, y, font: bold, size: 9, color })
      y -= 16
    }
  }

  // Footer
  page.drawLine({ start: { x: 45, y: 44 }, end: { x: width - 45, y: 44 }, thickness: 0.5, color: GRAY })
  page.drawText(
    `Generado por Diabolus CRM · ${now.toLocaleDateString('es-ES')} · Datos orientativos, consulta con tu gestoría`,
    { x: 50, y: 28, font: regular, size: 8, color: GRAY }
  )

  const pdfBytes = await pdfDoc.save()

  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="diabolus-informe-T${quarter}-${year}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
})

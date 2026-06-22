// @ts-nocheck
// backend/src/routes/reports.ts — añade GET /api/reports/monthly-summary
import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

type Variables = { userId: string; salonId: string }
export const reportRoutes = new Hono<{ Variables: Variables }>()

// ─── GET /api/reports/trimestral ─────────────────────────────────────────────
// (existente — sin cambios)
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

  const { data: transactions, error: txError } = await supabase
    .from('transactions')
    .select('amount, type, date, description')
    .eq('salon_id', salonId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })

  if (txError) return c.json({ error: txError.message }, 500)

  const { data: invoices, error: invError } = await supabase
    .from('invoices')
    .select('total, status, issue_date, number, clients(name)')
    .eq('salon_id', salonId)
    .gte('issue_date', startDate)
    .lte('issue_date', endDate)

  if (invError) return c.json({ error: invError.message }, 500)

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
  const fmt = (n: number) => `${n.toFixed(2)} EUR`

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

  const pdfDoc = await PDFDocument.create()
  const page   = pdfDoc.addPage([595.28, 841.89])
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

  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: BLUE })
  page.drawText('DIABOLUS CRM', { x: 50, y: height - 40, font: bold, size: 24, color: WHITE })
  page.drawText(
    `Informe Trimestral · ${quarterNames[quarter]} ${year}`,
    { x: 50, y: height - 62, font: regular, size: 13, color: rgb(0.8, 0.8, 1) }
  )

  y = height - 108

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

  section('RESUMEN ECONOMICO')
  row('Ingresos totales', fmt(ingresos), GREEN)
  row('Gastos totales', fmt(gastos), RED)
  divider()
  row('Beneficio neto', fmt(beneficio), beneficio >= 0 ? GREEN : RED, true)

  y -= 10

  section('ESTIMACION FISCAL (orientativa)')
  row('IVA repercutido  (21% s/ ingresos)', fmt(ivaRepercutido))
  row('IVA soportado  (21% s/ gastos)', fmt(ivaSoportado))
  divider()
  row('IVA neto a liquidar  ->  Modelo 303', fmt(ivaLiquidar), ivaLiquidar >= 0 ? RED : GREEN, true)
  y -= 4
  row('IRPF pago fraccionado  ->  Modelo 130', fmt(irpf), RED, true)
  row('(Solo estimacion orientativa - confirma con tu gestoria)', '')

  y -= 10

  section('FACTURACION DEL TRIMESTRE')
  row('Total facturas emitidas', String(facturasTotales))
  row('Cobradas', String(facturasCobradas), GREEN)
  row('Pendientes de cobro', String(facturasPendientes), ORANGE)
  row('Vencidas sin cobrar', String(facturasVencidas), RED)

  y -= 10

  section('ULTIMOS MOVIMIENTOS')
  const lastTx = (transactions || []).slice(-10)
  if (lastTx.length === 0) {
    page.drawText('Sin movimientos registrados en este periodo', { x: 62, y, font: regular, size: 10, color: GRAY })
    y -= 18
  } else {
    for (const tx of lastTx) {
      const sign  = tx.type === 'income' ? '+' : '-'
      const color = tx.type === 'income' ? GREEN : RED
      const desc  = (tx.description || 'Sin descripcion').slice(0, 48)
      const dateStr = tx.date ? new Date(tx.date).toLocaleDateString('es-ES') : ''
      page.drawText(dateStr, { x: 62, y, font: regular, size: 9, color: GRAY })
      page.drawText(desc,    { x: 118, y, font: regular, size: 9, color: BLACK })
      page.drawText(`${sign}${Number(tx.amount).toFixed(2)} EUR`, { x: 430, y, font: bold, size: 9, color })
      y -= 16
    }
  }

  page.drawLine({ start: { x: 45, y: 44 }, end: { x: width - 45, y: 44 }, thickness: 0.5, color: GRAY })
  page.drawText(
    `Generado por Diabolus CRM · ${now.toLocaleDateString('es-ES')} · Datos orientativos, consulta con tu gestoria`,
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

// ─── GET /api/reports/monthly-summary ────────────────────────────────────────
// ?month=YYYY-MM  (defecto: mes actual)
// ?format=json|pdf  (defecto: json)
reportRoutes.get('/monthly-summary', async (c) => {
  const salonId = c.get('salonId')
  const supabase = getSupabaseAdmin()

  const now    = new Date()
  const param  = c.req.query('month') // YYYY-MM
  const format = c.req.query('format') || 'json'

  let year: number, month: number
  if (param && /^\d{4}-\d{2}$/.test(param)) {
    [year, month] = param.split('-').map(Number)
  } else {
    year  = now.getFullYear()
    month = now.getMonth() + 1
  }

  const startDate = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay   = new Date(year, month, 0).getDate()
  const endDate   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  // ── Datos ────────────────────────────────────────────────────────────────
  const { data: txList, error: txErr } = await supabase
    .from('transactions')
    .select('id, amount, type, category, description, date, status, clients(name)')
    .eq('salon_id', salonId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })

  if (txErr) return c.json({ error: txErr.message }, 500)

  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('total, status, issue_date, number, clients(name)')
    .eq('salon_id', salonId)
    .gte('issue_date', startDate)
    .lte('issue_date', endDate)

  if (invErr) return c.json({ error: invErr.message }, 500)

  const { data: salonRow } = await supabase
    .from('salons')
    .select('nombre, nombre_fiscal')
    .eq('id', salonId)
    .single()

  const salonNombre = salonRow?.nombre || salonRow?.nombre_fiscal || 'Mi Negocio'

  // ── Totales ───────────────────────────────────────────────────────────────
  const txs = txList || []
  const totalIngresos = txs.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0)
  const totalGastos   = txs.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0)
  const neto          = totalIngresos - totalGastos

  // ── Por categoría ─────────────────────────────────────────────────────────
  const catMap: Record<string, { ingresos: number; gastos: number }> = {}
  for (const tx of txs) {
    const cat = tx.category || 'Sin categoría'
    if (!catMap[cat]) catMap[cat] = { ingresos: 0, gastos: 0 }
    if (tx.type === 'income')  catMap[cat].ingresos += Number(tx.amount)
    if (tx.type === 'expense') catMap[cat].gastos   += Number(tx.amount)
  }
  const porCategoria = Object.entries(catMap)
    .map(([cat, v]) => ({ categoria: cat, ingresos: v.ingresos, gastos: v.gastos, neto: v.ingresos - v.gastos }))
    .sort((a, b) => Math.abs(b.gastos + b.ingresos) - Math.abs(a.gastos + a.ingresos))

  // ── Facturas ──────────────────────────────────────────────────────────────
  const invs = invoices || []
  const facturasResumen = {
    total:      invs.length,
    cobradas:   invs.filter(i => i.status === 'paid').length,
    pendientes: invs.filter(i => ['pending', 'sent'].includes(i.status)).length,
    vencidas:   invs.filter(i => i.status === 'overdue').length,
    importe_cobrado:   invs.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0),
    importe_pendiente: invs.filter(i => ['pending','sent','overdue'].includes(i.status)).reduce((s, i) => s + Number(i.total), 0),
  }

  // Nombre del mes en español
  const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
  const periodoLabel = `${MESES[month]} ${year}`

  // ── JSON ──────────────────────────────────────────────────────────────────
  if (format === 'json') {
    return c.json({
      periodo:      periodoLabel,
      month_param:  `${year}-${String(month).padStart(2,'0')}`,
      fechas:       { desde: startDate, hasta: endDate },
      salon:        salonNombre,
      resumen:      { ingresos: totalIngresos, gastos: totalGastos, neto },
      por_categoria: porCategoria,
      facturas:     facturasResumen,
      transacciones: txs.map(t => ({
        id: t.id,
        fecha: t.date,
        tipo: t.type,
        categoria: t.category,
        descripcion: t.description,
        importe: Number(t.amount),
        cliente: (t.clients as any)?.name || null,
        estado: t.status,
      })),
    })
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create()
  const page   = pdfDoc.addPage([595.28, 841.89])
  const { width, height } = page.getSize()

  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const BLACK  = rgb(0.10, 0.10, 0.10)
  const RED    = rgb(0.75, 0.10, 0.10)
  const GREEN  = rgb(0.10, 0.45, 0.10)
  const GRAY   = rgb(0.50, 0.50, 0.50)
  const LGRAY  = rgb(0.93, 0.93, 0.97)
  const BLUE   = rgb(0.08, 0.08, 0.45)
  const ORANGE = rgb(0.80, 0.45, 0.00)
  const WHITE  = rgb(1, 1, 1)

  const fmt = (n: number) => `${n.toFixed(2)} EUR`
  const fmtShort = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + '.' : s

  let y = height - 55

  // ── Cabecera ──────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: height - 85, width, height: 85, color: BLUE })
  page.drawText('DIABOLUS CRM', { x: 50, y: height - 38, font: bold, size: 22, color: WHITE })
  page.drawText('RESUMEN MENSUAL PARA EL SOCIO', { x: 50, y: height - 58, font: bold, size: 12, color: rgb(0.8, 0.8, 1) })
  page.drawText(periodoLabel + '  |  ' + salonNombre, { x: 50, y: height - 75, font: regular, size: 9, color: rgb(0.7, 0.7, 0.9) })

  y = height - 105

  // ── Helpers ───────────────────────────────────────────────────────────────
  const section = (title: string) => {
    y -= 8
    page.drawRectangle({ x: 45, y: y - 5, width: width - 90, height: 22, color: LGRAY })
    page.drawText(title, { x: 52, y: y + 2, font: bold, size: 10, color: BLUE })
    y -= 26
  }

  const row2 = (label: string, value: string, valueColor = BLACK, isBold = false, indent = 62) => {
    page.drawText(label, { x: indent, y, font: regular, size: 9.5, color: GRAY })
    if (value) page.drawText(value, { x: 400, y, font: isBold ? bold : regular, size: 9.5, color: valueColor })
    y -= 17
  }

  const divider = () => {
    y -= 2
    page.drawLine({ start: { x: 62, y }, end: { x: width - 62, y }, thickness: 0.4, color: rgb(0.85, 0.85, 0.85) })
    y -= 6
  }

  // ── Resumen economico ─────────────────────────────────────────────────────
  section('RESUMEN ECONOMICO')
  row2('Ingresos del mes', fmt(totalIngresos), GREEN)
  row2('Gastos del mes',   fmt(totalGastos),   RED)
  divider()
  row2('RESULTADO NETO', fmt(neto), neto >= 0 ? GREEN : RED, true)

  y -= 8

  // ── Por categoria ─────────────────────────────────────────────────────────
  section('DESGLOSE POR CATEGORIA')

  // Cabecera de tabla
  page.drawText('Categoria', { x: 62, y, font: bold, size: 8.5, color: BLUE })
  page.drawText('Ingresos', { x: 290, y, font: bold, size: 8.5, color: BLUE })
  page.drawText('Gastos',   { x: 360, y, font: bold, size: 8.5, color: BLUE })
  page.drawText('Neto',     { x: 435, y, font: bold, size: 8.5, color: BLUE })
  y -= 4
  page.drawLine({ start: { x: 62, y }, end: { x: width - 62, y }, thickness: 0.5, color: GRAY })
  y -= 12

  const catRows = porCategoria.slice(0, 12)
  let rowBg = false
  for (const cat of catRows) {
    if (rowBg) page.drawRectangle({ x: 50, y: y - 4, width: width - 100, height: 15, color: rgb(0.97, 0.97, 0.99) })
    page.drawText(fmtShort(cat.categoria, 32), { x: 62, y, font: regular, size: 8.5, color: BLACK })
    if (cat.ingresos > 0) page.drawText(fmt(cat.ingresos), { x: 290, y, font: regular, size: 8.5, color: GREEN })
    if (cat.gastos > 0)   page.drawText(fmt(cat.gastos),   { x: 360, y, font: regular, size: 8.5, color: RED })
    const netoColor = cat.neto >= 0 ? GREEN : RED
    page.drawText(fmt(cat.neto), { x: 435, y, font: bold, size: 8.5, color: netoColor })
    y -= 14
    rowBg = !rowBg
  }

  if (porCategoria.length > 12) {
    page.drawText(`(+ ${porCategoria.length - 12} categorias mas)`, { x: 62, y, font: regular, size: 8, color: GRAY })
    y -= 14
  }

  y -= 6

  // ── Facturas ──────────────────────────────────────────────────────────────
  section('FACTURAS DEL MES')
  row2('Total emitidas',          String(facturasResumen.total))
  row2('Cobradas',                String(facturasResumen.cobradas) + '  (' + fmt(facturasResumen.importe_cobrado) + ')', GREEN)
  row2('Pendientes / Vencidas',   `${facturasResumen.pendientes} / ${facturasResumen.vencidas}  (${fmt(facturasResumen.importe_pendiente)})`, ORANGE)

  y -= 8

  // ── Ultimos movimientos ───────────────────────────────────────────────────
  if (y > 180) {
    section('MOVIMIENTOS DESTACADOS (ultimos 10)')

    page.drawText('Fecha',  { x: 62, y, font: bold, size: 8, color: BLUE })
    page.drawText('Descripcion', { x: 110, y, font: bold, size: 8, color: BLUE })
    page.drawText('Categoria',   { x: 310, y, font: bold, size: 8, color: BLUE })
    page.drawText('Importe',     { x: 450, y, font: bold, size: 8, color: BLUE })
    y -= 4
    page.drawLine({ start: { x: 62, y }, end: { x: width - 62, y }, thickness: 0.4, color: GRAY })
    y -= 11

    const recentTx = txs.slice(-10).reverse()
    let rowBg2 = false
    for (const tx of recentTx) {
      if (y < 60) break
      if (rowBg2) page.drawRectangle({ x: 50, y: y - 3, width: width - 100, height: 13, color: rgb(0.97, 0.97, 0.99) })
      const sign  = tx.type === 'income' ? '+' : '-'
      const color = tx.type === 'income' ? GREEN : RED
      const dateStr = tx.date ? new Date(tx.date).toLocaleDateString('es-ES') : ''
      page.drawText(dateStr, { x: 62, y, font: regular, size: 7.5, color: GRAY })
      page.drawText(fmtShort(tx.description || 'Sin descripcion', 38), { x: 110, y, font: regular, size: 7.5, color: BLACK })
      page.drawText(fmtShort(tx.category || '-', 20), { x: 310, y, font: regular, size: 7.5, color: GRAY })
      page.drawText(`${sign}${Number(tx.amount).toFixed(2)} EUR`, { x: 450, y, font: bold, size: 7.5, color })
      y -= 13
      rowBg2 = !rowBg2
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  page.drawLine({ start: { x: 45, y: 44 }, end: { x: width - 45, y: 44 }, thickness: 0.4, color: GRAY })
  page.drawText(
    `Generado por Diabolus CRM · ${now.toLocaleDateString('es-ES')} · Documento interno — no es factura oficial`,
    { x: 50, y: 28, font: regular, size: 7.5, color: GRAY }
  )
  page.drawText(periodoLabel, { x: width - 100, y: 28, font: bold, size: 7.5, color: BLUE })

  const pdfBytes = await pdfDoc.save()

  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="diabolus-resumen-${year}-${String(month).padStart(2,'0')}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
})

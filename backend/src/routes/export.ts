// @ts-nocheck
/**
 * export.ts — Bloque B4: Exportación en un clic (CSV / XLSX / PDF)
 *
 * exportPublicRoutes (montadas en /api/export):
 *   GET  /api/export/download?token=XXX  — descarga pública por token firmado (15 min)
 *
 * exportGestorRoutes (montadas en /gestor/export — requieren JWT gestor):
 *   POST /gestor/export/token            — genera token de descarga
 */

import { Hono } from 'hono'
import { jwtVerify, SignJWT } from 'jose'
import { getSupabaseAdmin } from '../integrations/supabase'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export const exportPublicRoutes = new Hono()
export const exportGestorRoutes = new Hono()

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? ''
)
const EXPORT_TOKEN_TYPE = 'diabolus_export_v1'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExportData {
  salon: { name: string; nif?: string }
  gestor: { name: string; email: string }
  period: string   // e.g. "Mayo 2026"
  yearMonth: string // e.g. "2026-05"
  ingresos: { total: number; breakdown: { category: string; amount: number }[] }
  gastos: { total: number; breakdown: { category: string; amount: number }[] }
  saldo: number
  facturas: {
    number: string
    client_name: string
    date: string
    base: number
    iva_rate: number
    iva_amount: number
    total: number
    status: string
  }[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-')
  const names = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
  return `${names[parseInt(m, 10) - 1]} ${y}`
}

async function fetchExportData(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  salonId: string,
  gestorId: string,
  yearMonth: string
): Promise<ExportData> {
  const [y, m] = yearMonth.split('-').map(Number)
  const startDate = `${yearMonth}-01`
  const endDate = new Date(y, m, 0).toISOString().slice(0, 10) // last day of month

  // Verify active link
  const { data: link } = await supabase
    .from('gestor_salon_links')
    .select('id')
    .eq('gestor_id', gestorId)
    .eq('salon_id', salonId)
    .eq('status', 'active')
    .single()
  if (!link) throw new Error('Link not active')

  // Salon info
  const { data: salon } = await supabase
    .from('salons')
    .select('name')
    .eq('id', salonId)
    .single()

  // Gestor info
  const { data: gestor } = await supabase
    .from('gestores')
    .select('name, email')
    .eq('id', gestorId)
    .single()

  // Transactions (confirmed only — no pending agent_actions)
  const { data: txns } = await supabase
    .from('transactions')
    .select('type, amount, category, description, date')
    .eq('salon_id', salonId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date')

  const ingresos = (txns || []).filter(t => t.type === 'income')
  const gastos = (txns || []).filter(t => t.type === 'expense')

  const groupBy = (arr: any[]) =>
    arr.reduce((acc, t) => {
      const cat = t.category || 'Sin categoría'
      acc[cat] = (acc[cat] || 0) + Number(t.amount)
      return acc
    }, {} as Record<string, number>)

  const ingresosBreakdown = Object.entries(groupBy(ingresos))
    .map(([category, amount]) => ({ category, amount: amount as number }))
  const gastosBreakdown = Object.entries(groupBy(gastos))
    .map(([category, amount]) => ({ category, amount: amount as number }))

  const totalIngresos = ingresos.reduce((s, t) => s + Number(t.amount), 0)
  const totalGastos = gastos.reduce((s, t) => s + Number(t.amount), 0)

  // Facturas emitidas (con IVA real — dato real de factura, NO estimación)
  const { data: invoicesRaw } = await supabase
    .from('invoices')
    .select('number, total, status, date, sent_at, invoice_items(description, quantity, unit_price, tax_rate)')
    .eq('salon_id', salonId)
    .gte('date', startDate)
    .lte('date', endDate)
    .not('status', 'eq', 'draft')  // solo confirmadas

  // For each invoice derive client name from number/description (no direct client join here)
  const { data: clientsMap } = await supabase
    .from('invoices')
    .select('id, number, client_id, clients(name)')
    .eq('salon_id', salonId)
    .gte('date', startDate)
    .lte('date', endDate)

  const clientByInvoiceId = (clientsMap || []).reduce((m, inv) => {
    m[inv.number] = inv.clients?.name ?? '—'
    return m
  }, {} as Record<string, string>)

  const facturas = (invoicesRaw || []).map(inv => {
    const items = inv.invoice_items || []
    const base = items.reduce((s, it) => s + Number(it.unit_price) * Number(it.quantity), 0)
    // Use dominant tax_rate from items (weighted or first non-zero)
    const ivaRate = items.find(it => Number(it.tax_rate) > 0)?.tax_rate ?? 0
    const ivaAmount = Number(inv.total) - base
    return {
      number: inv.number ?? '—',
      client_name: clientByInvoiceId[inv.number] ?? '—',
      date: inv.date ? inv.date.slice(0, 10) : '—',
      base: Math.round(base * 100) / 100,
      iva_rate: Number(ivaRate),
      iva_amount: Math.round(ivaAmount * 100) / 100,
      total: Number(inv.total),
      status: inv.status ?? '—',
    }
  })

  return {
    salon: { name: salon?.name ?? '—' },
    gestor: { name: gestor?.name ?? '—', email: gestor?.email ?? '—' },
    period: monthLabel(yearMonth),
    yearMonth,
    ingresos: { total: totalIngresos, breakdown: ingresosBreakdown },
    gastos: { total: totalGastos, breakdown: gastosBreakdown },
    saldo: totalIngresos - totalGastos,
    facturas,
  }
}

// ─── CSV Generator ────────────────────────────────────────────────────────────

function generateCSV(d: ExportData): string {
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines: string[] = []

  lines.push(`CIERRE MENSUAL — ${d.period}`)
  lines.push(`Cliente,${esc(d.salon.name)}`)
  lines.push(`Gestor,${esc(d.gestor.name)}`)
  lines.push(`Periodo,${d.period}`)
  lines.push('')

  lines.push('=== INGRESOS ===')
  lines.push('Categoría,Importe (€)')
  d.ingresos.breakdown.forEach(r => lines.push(`${esc(r.category)},${r.amount.toFixed(2)}`))
  lines.push(`TOTAL INGRESOS,${d.ingresos.total.toFixed(2)}`)
  lines.push('')

  lines.push('=== GASTOS ===')
  lines.push('Categoría,Importe (€)')
  d.gastos.breakdown.forEach(r => lines.push(`${esc(r.category)},${r.amount.toFixed(2)}`))
  lines.push(`TOTAL GASTOS,${d.gastos.total.toFixed(2)}`)
  lines.push('')

  lines.push(`SALDO DEL PERIODO,${d.saldo.toFixed(2)}`)
  lines.push('')

  lines.push('=== FACTURAS EMITIDAS ===')
  lines.push('Nº Factura,Cliente,Fecha,Base (€),Tipo IVA (%),Cuota IVA (€),Total (€),Estado')
  d.facturas.forEach(f => lines.push(
    [esc(f.number), esc(f.client_name), esc(f.date),
     f.base.toFixed(2), f.iva_rate, f.iva_amount.toFixed(2),
     f.total.toFixed(2), esc(f.status)].join(',')
  ))

  return lines.join('\r\n')
}

// ─── XLSX Generator (manual XML/ZIP — Edge-compatible) ────────────────────────

function escXml(v: any): string {
  return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

async function generateXLSX(d: ExportData): Promise<Uint8Array> {
  // Build rows for a single flat sheet
  const rows: (string | number)[][] = []
  rows.push([`CIERRE MENSUAL — ${d.period}`])
  rows.push([`Cliente: ${d.salon.name}`])
  rows.push([`Gestor: ${d.gestor.name}`])
  rows.push([])

  rows.push(['INGRESOS'])
  rows.push(['Categoría', 'Importe (€)'])
  d.ingresos.breakdown.forEach(r => rows.push([r.category, r.amount]))
  rows.push(['TOTAL INGRESOS', d.ingresos.total])
  rows.push([])

  rows.push(['GASTOS'])
  rows.push(['Categoría', 'Importe (€)'])
  d.gastos.breakdown.forEach(r => rows.push([r.category, r.amount]))
  rows.push(['TOTAL GASTOS', d.gastos.total])
  rows.push([])
  rows.push(['SALDO DEL PERIODO', d.saldo])
  rows.push([])

  rows.push(['FACTURAS EMITIDAS'])
  rows.push(['Nº Factura', 'Cliente', 'Fecha', 'Base (€)', 'IVA %', 'Cuota IVA (€)', 'Total (€)', 'Estado'])
  d.facturas.forEach(f => rows.push([f.number, f.client_name, f.date, f.base, f.iva_rate, f.iva_amount, f.total, f.status]))

  // Encode rows as XML worksheet
  let sharedStrings: string[] = []
  const siIndex = (s: string) => {
    const idx = sharedStrings.indexOf(s)
    if (idx !== -1) return idx
    sharedStrings.push(s)
    return sharedStrings.length - 1
  }
  const col = (n: number) => {
    let s = ''
    while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 }
    return s
  }

  let sheetData = '<sheetData>'
  rows.forEach((row, ri) => {
    sheetData += `<row r="${ri+1}">`
    row.forEach((cell, ci) => {
      const ref = `${col(ci)}${ri+1}`
      if (typeof cell === 'number') {
        sheetData += `<c r="${ref}"><v>${cell}</v></c>`
      } else {
        const si = siIndex(String(cell))
        sheetData += `<c r="${ref}" t="s"><v>${si}</v></c>`
      }
    })
    sheetData += '</row>'
  })
  sheetData += '</sheetData>'

  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${sheetData}
</worksheet>`

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map(s => `<si><t>${escXml(s)}</t></si>`).join('')}
</sst>`

  const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Cierre" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`

  const relsBase = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

  // ZIP manually using fflate (ESM, Edge-compatible)
  const { strToU8, zipSync } = await import('fflate')

  const zip = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relsBase),
    'xl/workbook.xml': strToU8(workbookXml),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    'xl/sharedStrings.xml': strToU8(sharedStringsXml),
  })

  return zip
}

// ─── PDF Generator ────────────────────────────────────────────────────────────

async function generatePDF(d: ExportData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)

  const addPage = () => {
    const p = doc.addPage([595, 842]) // A4
    return { p, y: [800] }  // mutable y ref
  }

  const darkGray = rgb(0.15, 0.15, 0.15)
  const accent = rgb(0.55, 0.1, 0.85) // diabolus violet
  const lightGray = rgb(0.5, 0.5, 0.5)

  let { p, y } = addPage()
  const curY = () => y[0]
  const moveY = (n: number) => { y[0] -= n }

  const text = (txt: string, x: number, size = 10, bold = false, color = darkGray) => {
    p.drawText(txt, { x, y: curY(), size, font: bold ? fontBold : font, color })
  }

  const line = (x1: number, x2: number, thickness = 0.5) => {
    p.drawLine({ start: { x: x1, y: curY() }, end: { x: x2, y: curY() }, thickness, color: lightGray })
  }

  const checkPage = () => {
    if (curY() < 60) {
      const next = addPage()
      p = next.p
      y = next.y
    }
  }

  // Header
  p.drawRectangle({ x: 0, y: 792, width: 595, height: 50, color: accent })
  p.drawText('DIABOLUS', { x: 40, y: 808, size: 18, font: fontBold, color: rgb(1,1,1) })
  p.drawText('Cierre Mensual', { x: 160, y: 808, size: 13, font, color: rgb(0.9,0.9,0.9) })
  moveY(-60)

  text(`${d.salon.name} — ${d.period}`, 40, 14, true)
  moveY(6)
  text(`Gestor: ${d.gestor.name}  ·  ${d.gestor.email}`, 40, 9, false, lightGray)
  moveY(20)
  line(40, 555)
  moveY(14)

  // Resumen
  text('RESUMEN', 40, 11, true, accent)
  moveY(14)
  text(`Total Ingresos:`, 40, 10, false)
  text(`${d.ingresos.total.toFixed(2)} €`, 350, 10, true)
  moveY(14)
  text(`Total Gastos:`, 40, 10, false)
  text(`${d.gastos.total.toFixed(2)} €`, 350, 10, true)
  moveY(14)
  text(`Saldo del Periodo:`, 40, 10, true)
  text(`${d.saldo.toFixed(2)} €`, 350, 10, true, d.saldo >= 0 ? rgb(0.1,0.55,0.1) : rgb(0.75,0.1,0.1))
  moveY(20)
  line(40, 555)
  moveY(14)

  // Ingresos breakdown
  if (d.ingresos.breakdown.length > 0) {
    text('INGRESOS POR CATEGORÍA', 40, 11, true, accent)
    moveY(14)
    d.ingresos.breakdown.forEach(r => {
      checkPage()
      text(r.category, 50, 9)
      text(`${r.amount.toFixed(2)} €`, 350, 9)
      moveY(12)
    })
    moveY(6)
  }

  // Gastos breakdown
  if (d.gastos.breakdown.length > 0) {
    checkPage()
    text('GASTOS POR CATEGORÍA', 40, 11, true, accent)
    moveY(14)
    d.gastos.breakdown.forEach(r => {
      checkPage()
      text(r.category, 50, 9)
      text(`${r.amount.toFixed(2)} €`, 350, 9)
      moveY(12)
    })
    moveY(6)
  }

  // Facturas
  if (d.facturas.length > 0) {
    checkPage()
    line(40, 555)
    moveY(14)
    text('FACTURAS EMITIDAS', 40, 11, true, accent)
    moveY(14)
    // Header row
    const cols = [40, 95, 215, 270, 320, 365, 420, 480]
    const headers = ['Nº','Cliente','Fecha','Base','IVA%','Cuota','Total','Estado']
    headers.forEach((h, i) => text(h, cols[i], 8, true, lightGray))
    moveY(4)
    line(40, 555)
    moveY(10)

    d.facturas.forEach(f => {
      checkPage()
      const vals = [f.number, f.client_name.slice(0,14), f.date, f.base.toFixed(2),
                    `${f.iva_rate}%`, f.iva_amount.toFixed(2), f.total.toFixed(2), f.status]
      vals.forEach((v, i) => text(String(v), cols[i], 8))
      moveY(12)
    })
  }

  // Footer on last page
  const pages = doc.getPages()
  pages.forEach((pg, i) => {
    pg.drawText(`Diabolus CRM — exportado el ${new Date().toLocaleDateString('es-ES')} — Pág. ${i+1}/${pages.length}`,
      { x: 40, y: 20, size: 7, font, color: lightGray })
  })

  return doc.save()
}

// ─── POST /gestor/export/token ────────────────────────────────────────────────

exportGestorRoutes.post('/token', async (c) => {
  const gestorId = c.get('gestorId') as string
  if (!gestorId) return c.json({ error: 'No autorizado' }, 401)

  const body = await c.req.json().catch(() => ({}))
  const { salonId, month, format } = body

  if (!salonId || !month || !format) return c.json({ error: 'Faltan parámetros' }, 400)
  if (!['csv', 'xlsx', 'pdf'].includes(format)) return c.json({ error: 'Formato inválido' }, 400)
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: 'Mes inválido (YYYY-MM)' }, 400)

  const supabase = getSupabaseAdmin()
  const { data: link } = await supabase
    .from('gestor_salon_links')
    .select('id')
    .eq('gestor_id', gestorId)
    .eq('salon_id', salonId)
    .eq('status', 'active')
    .single()

  if (!link) return c.json({ error: 'Cliente no vinculado o inactivo' }, 403)

  const token = await new SignJWT({ gestorId, salonId, month, format, type: EXPORT_TOKEN_TYPE })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('15m')
    .sign(JWT_SECRET)

  const baseUrl = 'https://diabolus-crm-api.vercel.app'
  return c.json({ downloadUrl: `${baseUrl}/api/export/download?token=${token}` })
})

// ─── GET /api/export/download?token=XXX (public) ─────────────────────────────

exportPublicRoutes.get('/download', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'Token requerido' }, 400)

  let payload: any
  try {
    const { payload: p } = await jwtVerify(token, JWT_SECRET)
    payload = p
  } catch {
    return c.json({ error: 'Token inválido o expirado' }, 401)
  }

  if (payload.type !== EXPORT_TOKEN_TYPE) return c.json({ error: 'Token inválido' }, 401)

  const { gestorId, salonId, month, format } = payload
  const supabase = getSupabaseAdmin()

  let data: ExportData
  try {
    data = await fetchExportData(supabase, salonId, gestorId, month)
  } catch (e: any) {
    return c.json({ error: e.message || 'Error al obtener datos' }, 400)
  }

  const filename = `cierre_${data.salon.name.replace(/\s+/g, '_')}_${month}`

  if (format === 'csv') {
    const csv = generateCSV(data)
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
      },
    })
  }

  if (format === 'xlsx') {
    try {
      const xlsx = await generateXLSX(data)
      return new Response(xlsx, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
        },
      })
    } catch (e) {
      // fflate fallback — return CSV with xlsx extension note
      const csv = generateCSV(data)
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}.csv"`,
        },
      })
    }
  }

  if (format === 'pdf') {
    const pdf = await generatePDF(data)
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}.pdf"`,
      },
    })
  }

  return c.json({ error: 'Formato no soportado' }, 400)
})


// ─── accrueCommissions — llamada por el trigger mensual ───────────────────────
/**
 * Devenga comisiones para todos los gestores con tarifa activa.
 * Periodo = mes anterior al momento de llamada.
 * Idempotente: upsert con UNIQUE (gestor_id, salon_id, year, month).
 */
export async function accrueCommissions(supabase: any): Promise<{ accrued: number; skipped: number }> {
  const now   = new Date()
  const year  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
  const month = now.getMonth() === 0 ? 12 : now.getMonth()   // mes anterior (1-indexed)

  const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`
  const dateTo   = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`

  // Todos los links activos con alguna tarifa configurada
  const { data: links, error: linksErr } = await supabase
    .from('gestor_salon_links')
    .select('gestor_id, salon_id, commission_rate, precio_mantenimiento')
    .eq('status', 'active')

  if (linksErr || !links?.length) return { accrued: 0, skipped: 0 }

  let accrued = 0
  let skipped = 0

  for (const link of links) {
    const hasTarifa = link.commission_rate != null || link.precio_mantenimiento != null
    if (!hasTarifa) { skipped++; continue }

    // Ingresos confirmados del salón en el periodo
    const { data: txs } = await supabase
      .from('transactions')
      .select('amount')
      .eq('salon_id', link.salon_id)
      .eq('type', 'income')
      .gte('date', dateFrom)
      .lte('date', dateTo + 'T23:59:59')

    const totalIncome = (txs || []).reduce((s: number, t: any) => s + (parseFloat(t.amount) || 0), 0)

    const commissionFromRate = link.commission_rate != null
      ? (totalIncome * link.commission_rate) / 100
      : 0
    const maintenance = parseFloat(link.precio_mantenimiento ?? '0') || 0
    const amount = Math.round((commissionFromRate + maintenance) * 100) / 100

    // Upsert idempotente
    const { error: upsertErr } = await supabase
      .from('commission_ledger')
      .upsert({
        gestor_id:    link.gestor_id,
        salon_id:     link.salon_id,
        year,
        month,
        amount,
        status:       'pending',
        accrued_at:   new Date().toISOString(),
      }, { onConflict: 'gestor_id,salon_id,year,month', ignoreDuplicates: false })

    if (!upsertErr) accrued++
    else { console.error('[accrueCommissions] upsert error:', upsertErr); skipped++ }
  }

  return { accrued, skipped }
}

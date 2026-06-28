/**
 * import.ts — Importador Masivo de Productos y Clientes (CSV)
 *
 * POST   /api/import/products          — importar productos desde CSV
 * POST   /api/import/clients           — importar clientes desde CSV
 * GET    /api/import/template/products  — descargar plantilla CSV productos
 * GET    /api/import/template/clients   — descargar plantilla CSV clientes
 */

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }
export const importRoutes = new Hono<{ Variables: Variables }>()

// ─── CSV Parser (Edge-compatible, no Node deps) ─────────────────────────────
function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let current = ''
  let inQuotes = false
  let row: string[] = []

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        current += '"'
        i++ // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',' || ch === ';') {
        row.push(current.trim())
        current = ''
      } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        row.push(current.trim())
        if (row.some(cell => cell !== '')) rows.push(row)
        row = []
        current = ''
        if (ch === '\r') i++ // skip \n after \r
      } else {
        current += ch
      }
    }
  }
  // Last row
  row.push(current.trim())
  if (row.some(cell => cell !== '')) rows.push(row)

  return rows
}

// ─── Header mapping helpers ─────────────────────────────────────────────────
const PRODUCT_HEADERS: Record<string, string> = {
  'nombre': 'name', 'name': 'name', 'producto': 'name', 'servicio': 'name',
  'descripcion': 'description', 'description': 'description', 'desc': 'description',
  'precio': 'price', 'price': 'price', 'pvp': 'price', 'importe': 'price',
  'iva': 'iva_rate', 'iva_rate': 'iva_rate', 'iva%': 'iva_rate', 'tipo_iva': 'iva_rate',
  'unidad': 'unit', 'unit': 'unit', 'medida': 'unit',
  'categoria': 'category', 'category': 'category', 'cat': 'category', 'grupo': 'category',
  'referencia': 'sku', 'sku': 'sku', 'ref': 'sku', 'codigo': 'sku', 'code': 'sku',
}

const CLIENT_HEADERS: Record<string, string> = {
  'nombre': 'name', 'name': 'name', 'cliente': 'name', 'razon_social': 'name', 'empresa': 'name',
  'telefono': 'phone', 'phone': 'phone', 'tel': 'phone', 'movil': 'phone', 'mobile': 'phone',
  'email': 'email', 'correo': 'email', 'mail': 'email', 'e-mail': 'email',
  'nif': 'nif', 'cif': 'nif', 'dni': 'nif', 'nif/cif': 'nif', 'documento': 'nif',
  'direccion': 'address', 'address': 'address', 'domicilio': 'address', 'dir': 'address',
  'notas': 'notes', 'notes': 'notes', 'observaciones': 'notes', 'comentarios': 'notes',
}

function normalizeHeader(h: string): string {
  return h.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

function mapHeaders(headers: string[], mapping: Record<string, string>): Record<number, string> {
  const result: Record<number, string> = {}
  headers.forEach((h, i) => {
    const norm = normalizeHeader(h)
    if (mapping[norm]) result[i] = mapping[norm]
  })
  return result
}

// ─── Plan limits ────────────────────────────────────────────────────────────
const PLAN_LIMITS: Record<string, number> = {
  'purgatorio': 200,
  'pacto': 1000,
  'infierno': 999999, // unlimited
}

async function getSalonPlan(salonId: string): Promise<{ plan: string; limit: number }> {
  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('salons')
    .select('plan')
    .eq('id', salonId)
    .single()
  const plan = (data?.plan || 'pacto').toLowerCase()
  return { plan, limit: PLAN_LIMITS[plan] || 1000 }
}

// ─── GET /api/import/template/products ──────────────────────────────────────
importRoutes.get('/template/products', (c) => {
  const csv = 'nombre,precio,referencia,categoria,iva,unidad,descripcion\n' +
    'Corte caballero,15.00,SRV-001,Servicios,21,servicio,Corte clásico\n' +
    'Tinte raíz,35.00,SRV-002,Servicios,21,servicio,Aplicación de tinte\n' +
    'Champú profesional 500ml,12.50,PRD-001,Productos,21,ud,Champú reparador\n'

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="plantilla_productos_diabolus.csv"',
    }
  })
})

// ─── GET /api/import/template/clients ───────────────────────────────────────
importRoutes.get('/template/clients', (c) => {
  const csv = 'nombre,telefono,email,nif,direccion,notas\n' +
    'María García López,+34612345678,maria@ejemplo.com,12345678A,Calle Mayor 1 Madrid,Cliente habitual\n' +
    'Bar El Rincón SL,+34698765432,bar@elrincon.es,B12345678,Av. Constitución 15 Valencia,Pedidos mensuales\n'

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="plantilla_clientes_diabolus.csv"',
    }
  })
})

// ─── POST /api/import/products ──────────────────────────────────────────────
importRoutes.post('/products', async (c) => {
  const salonId = c.get('salonId')
  const userId = c.get('userId')
  const supabase = getSupabaseAdmin()

  // Check plan limit
  const { plan, limit } = await getSalonPlan(salonId)
  const { count: existingCount } = await supabase
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('salon_id', salonId)
    .eq('is_active', true)
  const currentCount = existingCount || 0

  // Parse body — expect { csv: string, dry_run?: boolean }
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'JSON inválido' }, 400) }

  const csvText = body.csv
  const dryRun = body.dry_run === true

  if (!csvText || typeof csvText !== 'string') {
    return c.json({ error: 'Falta el campo "csv" con el contenido del archivo' }, 400)
  }

  const rows = parseCSV(csvText)
  if (rows.length < 2) {
    return c.json({ error: 'El archivo debe tener al menos una cabecera y una fila de datos' }, 400)
  }

  const headerRow = rows[0]
  const colMap = mapHeaders(headerRow, PRODUCT_HEADERS)

  if (!Object.values(colMap).includes('name')) {
    return c.json({
      error: 'No se encontró columna de nombre. Usa: nombre, name, producto o servicio',
      detected_headers: headerRow,
    }, 400)
  }

  // Get existing SKUs for dedup
  const { data: existingProducts } = await supabase
    .from('products')
    .select('sku')
    .eq('salon_id', salonId)
    .not('sku', 'is', null)
  const existingSkus = new Set((existingProducts || []).map(p => (p.sku || '').toLowerCase()).filter(Boolean))

  const validRows: any[] = []
  const errors: { row: number; field: string; message: string }[] = []
  const skipped: { row: number; reason: string }[] = []
  const seenSkus = new Set<string>()

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const record: Record<string, any> = {}

    // Map columns
    for (const [colIdx, field] of Object.entries(colMap)) {
      record[field] = row[parseInt(colIdx)] || ''
    }

    const rowNum = i + 1 // human-readable row number

    // Validate name (required)
    if (!record.name || record.name.trim().length === 0) {
      errors.push({ row: rowNum, field: 'nombre', message: 'Nombre vacío — obligatorio' })
      continue
    }
    if (record.name.trim().length > 200) {
      errors.push({ row: rowNum, field: 'nombre', message: 'Nombre demasiado largo (máx 200 chars)' })
      continue
    }

    // Validate price
    let price = 0
    if (record.price) {
      const parsed = parseFloat(String(record.price).replace(',', '.').replace(/[^\d.-]/g, ''))
      if (isNaN(parsed) || parsed < 0) {
        errors.push({ row: rowNum, field: 'precio', message: `Precio inválido: "${record.price}"` })
        continue
      }
      price = parsed
    }

    // Validate IVA
    let ivaRate = 21
    if (record.iva_rate) {
      const parsed = parseInt(String(record.iva_rate).replace('%', '').trim())
      if (![0, 4, 10, 21].includes(parsed)) {
        errors.push({ row: rowNum, field: 'iva', message: `IVA debe ser 0, 4, 10 o 21. Recibido: "${record.iva_rate}"` })
        continue
      }
      ivaRate = parsed
    }

    // Validate unit
    const validUnits = ['ud', 'kg', 'litro', 'hora', 'servicio', 'sesion', 'mes', 'caja']
    let unit = 'ud'
    if (record.unit) {
      const u = record.unit.toLowerCase().trim()
      if (validUnits.includes(u)) {
        unit = u
      } else {
        // Try common mappings
        const unitMap: Record<string, string> = {
          'unidad': 'ud', 'unidades': 'ud', 'u': 'ud',
          'kilogramo': 'kg', 'kilogramos': 'kg', 'kilo': 'kg', 'kilos': 'kg',
          'litros': 'litro', 'l': 'litro', 'lt': 'litro',
          'horas': 'hora', 'h': 'hora', 'hr': 'hora',
          'servicios': 'servicio', 'srv': 'servicio',
          'sesiones': 'sesion',
          'meses': 'mes',
          'cajas': 'caja',
        }
        unit = unitMap[u] || 'ud'
      }
    }

    // Dedup by SKU
    const sku = (record.sku || '').trim()
    if (sku) {
      const skuLower = sku.toLowerCase()
      if (existingSkus.has(skuLower)) {
        skipped.push({ row: rowNum, reason: `SKU "${sku}" ya existe en tu catálogo` })
        continue
      }
      if (seenSkus.has(skuLower)) {
        skipped.push({ row: rowNum, reason: `SKU "${sku}" duplicado en el archivo` })
        continue
      }
      seenSkus.add(skuLower)
    }

    validRows.push({
      salon_id: salonId,
      name: record.name.trim(),
      description: (record.description || '').trim() || null,
      price,
      iva_rate: ivaRate,
      unit,
      category: (record.category || '').trim() || null,
      sku: sku || null,
    })
  }

  // Check plan limit
  if (currentCount + validRows.length > limit) {
    return c.json({
      error: `Tu plan ${plan} permite ${limit} productos. Tienes ${currentCount} y quieres importar ${validRows.length}. Necesitas ${currentCount + validRows.length - limit} menos o un plan superior.`,
      valid: validRows.length,
      current: currentCount,
      limit,
    }, 400)
  }

  // Dry run: return preview without inserting
  if (dryRun) {
    return c.json({
      dry_run: true,
      total_rows: rows.length - 1,
      valid: validRows.length,
      errors,
      skipped,
      preview: validRows.slice(0, 10),
    })
  }

  // Insert in batches of 100
  let inserted = 0
  const batchSize = 100
  for (let i = 0; i < validRows.length; i += batchSize) {
    const batch = validRows.slice(i, i + batchSize)
    const { error: insertErr, data: insertData } = await supabase
      .from('products')
      .insert(batch)
      .select('id')

    if (insertErr) {
      return c.json({
        error: `Error insertando lote ${Math.floor(i / batchSize) + 1}: ${insertErr.message}`,
        inserted_before_error: inserted,
      }, 500)
    }
    inserted += (insertData || []).length
  }

  // Audit log
  try {
    await supabase.from('audit_log').insert({
      user_id: userId,
      salon_id: salonId,
      action: 'import_products',
      changes: { imported: inserted, errors: errors.length, skipped: skipped.length },
      created_at: new Date().toISOString(),
    })
  } catch {}

  return c.json({
    ok: true,
    imported: inserted,
    total_rows: rows.length - 1,
    errors,
    skipped,
  })
})

// ─── POST /api/import/clients ───────────────────────────────────────────────
importRoutes.post('/clients', async (c) => {
  const salonId = c.get('salonId')
  const userId = c.get('userId')
  const supabase = getSupabaseAdmin()

  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'JSON inválido' }, 400) }

  const csvText = body.csv
  const dryRun = body.dry_run === true

  if (!csvText || typeof csvText !== 'string') {
    return c.json({ error: 'Falta el campo "csv" con el contenido del archivo' }, 400)
  }

  const rows = parseCSV(csvText)
  if (rows.length < 2) {
    return c.json({ error: 'El archivo debe tener al menos una cabecera y una fila de datos' }, 400)
  }

  const headerRow = rows[0]
  const colMap = mapHeaders(headerRow, CLIENT_HEADERS)

  if (!Object.values(colMap).includes('name')) {
    return c.json({
      error: 'No se encontró columna de nombre. Usa: nombre, name, cliente, razon_social o empresa',
      detected_headers: headerRow,
    }, 400)
  }

  // Get existing clients for dedup
  const { data: existingClients } = await supabase
    .from('clients')
    .select('email, phone, nif')
    .eq('salon_id', salonId)
  const existingEmails = new Set((existingClients || []).map(c => (c.email || '').toLowerCase()).filter(Boolean))
  const existingPhones = new Set((existingClients || []).map(c => (c.phone || '').replace(/\s+/g, '')).filter(Boolean))
  const existingNifs = new Set((existingClients || []).map(c => (c.nif || '').toUpperCase().replace(/[\s-]/g, '')).filter(Boolean))

  const validRows: any[] = []
  const errors: { row: number; field: string; message: string }[] = []
  const skipped: { row: number; reason: string }[] = []
  const seenEmails = new Set<string>()
  const seenPhones = new Set<string>()
  const seenNifs = new Set<string>()

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const record: Record<string, any> = {}

    for (const [colIdx, field] of Object.entries(colMap)) {
      record[field] = row[parseInt(colIdx)] || ''
    }

    const rowNum = i + 1

    // Validate name (required)
    if (!record.name || record.name.trim().length === 0) {
      errors.push({ row: rowNum, field: 'nombre', message: 'Nombre vacío — obligatorio' })
      continue
    }

    const email = (record.email || '').trim().toLowerCase()
    const phone = (record.phone || '').trim().replace(/\s+/g, '')
    const nif = (record.nif || '').trim().toUpperCase().replace(/[\s-]/g, '')

    // Dedup by email
    if (email) {
      if (existingEmails.has(email)) {
        skipped.push({ row: rowNum, reason: `Email "${email}" ya existe` })
        continue
      }
      if (seenEmails.has(email)) {
        skipped.push({ row: rowNum, reason: `Email "${email}" duplicado en el archivo` })
        continue
      }
      seenEmails.add(email)
    }

    // Dedup by phone
    if (phone) {
      if (existingPhones.has(phone)) {
        skipped.push({ row: rowNum, reason: `Teléfono "${phone}" ya existe` })
        continue
      }
      if (seenPhones.has(phone)) {
        skipped.push({ row: rowNum, reason: `Teléfono "${phone}" duplicado en el archivo` })
        continue
      }
      seenPhones.add(phone)
    }

    // Dedup by NIF
    if (nif) {
      if (existingNifs.has(nif)) {
        skipped.push({ row: rowNum, reason: `NIF "${nif}" ya existe` })
        continue
      }
      if (seenNifs.has(nif)) {
        skipped.push({ row: rowNum, reason: `NIF "${nif}" duplicado en el archivo` })
        continue
      }
      seenNifs.add(nif)
    }

    // Basic email format validation
    if (email && !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      errors.push({ row: rowNum, field: 'email', message: `Email inválido: "${email}"` })
      continue
    }

    validRows.push({
      salon_id: salonId,
      name: record.name.trim(),
      phone: phone || null,
      email: email || null,
      nif: nif || null,
      address: (record.address || '').trim() || null,
      notes: (record.notes || '').trim() || null,
    })
  }

  // Dry run
  if (dryRun) {
    return c.json({
      dry_run: true,
      total_rows: rows.length - 1,
      valid: validRows.length,
      errors,
      skipped,
      preview: validRows.slice(0, 10),
    })
  }

  // Insert in batches
  let inserted = 0
  const batchSize = 100
  for (let i = 0; i < validRows.length; i += batchSize) {
    const batch = validRows.slice(i, i + batchSize)
    const { error: insertErr, data: insertData } = await supabase
      .from('clients')
      .insert(batch)
      .select('id')

    if (insertErr) {
      return c.json({
        error: `Error insertando lote ${Math.floor(i / batchSize) + 1}: ${insertErr.message}`,
        inserted_before_error: inserted,
      }, 500)
    }
    inserted += (insertData || []).length
  }

  // Audit log
  try {
    await supabase.from('audit_log').insert({
      user_id: userId,
      salon_id: salonId,
      action: 'import_clients',
      changes: { imported: inserted, errors: errors.length, skipped: skipped.length },
      created_at: new Date().toISOString(),
    })
  } catch {}

  return c.json({
    ok: true,
    imported: inserted,
    total_rows: rows.length - 1,
    errors,
    skipped,
  })
})

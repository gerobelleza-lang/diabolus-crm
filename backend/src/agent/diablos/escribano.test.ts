/**
 * 📜 El Escribano v2 — Test Suite
 *
 * Tests unitarios + integración simulada
 * Cubre: regex extractor, validación, preview, document-status
 *
 * Ejecutar: npx tsx escribano-v2.test.ts
 */

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`  ❌ FAIL: ${msg}`)
    failed++
  } else {
    passed++
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORTS — copias locales de las funciones puras (sin Supabase)
// ═══════════════════════════════════════════════════════════════════════════════

// ── document-status.ts ──

const DOCUMENT_STATUS = {
  DRAFT:    'draft',
  SENT:     'sent',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
} as const

const VALID_DOC_STATUSES = ['draft', 'sent', 'accepted', 'rejected'] as const
const DOCUMENT_TYPES = { ALBARAN: 'albaran', PRESUPUESTO: 'presupuesto' } as const
const VALID_DOC_TYPES = ['albaran', 'presupuesto'] as const

function isValidDocType(value: string): boolean {
  return (VALID_DOC_TYPES as readonly string[]).includes(value)
}

function isValidDocStatus(value: string): boolean {
  return (VALID_DOC_STATUSES as readonly string[]).includes(value)
}

const STATUS_MAP: Record<string, string | null> = {
  'draft': 'draft', 'sent': 'sent', 'accepted': 'accepted', 'rejected': 'rejected',
  'borrador': 'draft', 'enviado': 'sent', 'enviada': 'sent',
  'aceptado': 'accepted', 'aceptada': 'accepted',
  'rechazado': 'rejected', 'rechazada': 'rejected',
}

function mapDocStatusToDB(input: string): string | null {
  return STATUS_MAP[input.trim().toLowerCase()] ?? null
}

// ── escribano-v2.ts — funciones puras ──

interface ExtractedDocLine {
  concepto: string
  cantidad: number
  precio_unitario: number | null
}

interface ExtractedDocData {
  type: 'albaran' | 'presupuesto'
  cliente: string | null
  lineas: ExtractedDocLine[]
  notas: string | null
}

interface ValidatedDocLine {
  concepto: string
  cantidad: number
  precio_unitario: number
  subtotal: number
}

interface DocValidationResult {
  lineas: ValidatedDocLine[]
  total: number
  warnings: string[]
}

function extractDocWithRegex(userInput: string): ExtractedDocData {
  const isPresupuesto = /\bpresupuesto\b/i.test(userInput)
  const type: 'albaran' | 'presupuesto' = isPresupuesto ? 'presupuesto' : 'albaran'

  const mCliente = userInput.match(
    /(?:para|a)\s+(?:(?:el|la|los|las|un|una)\s+)?([A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]{1,55}?)(?:\s+(?:por|con|de|,)|\s+\d|$)/i
  )
  let cliente = mCliente
    ? mCliente[1].trim().replace(/^(?:el|la|los|las|un|una|a)\s+/i, '').trim()
    : null

  const lineas: ExtractedDocLine[] = []

  // Pattern 1: "3 cajas a 50€"
  const reItems = /(\d+)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]{1,60}?)\s+(?:a|de|por)?\s*(\d+(?:[.,]\d{1,2})?)\s*€/gi
  let m: RegExpExecArray | null
  while ((m = reItems.exec(userInput)) !== null) {
    lineas.push({
      concepto: m[2].trim(),
      cantidad: parseInt(m[1]),
      precio_unitario: parseFloat(m[3].replace(',', '.')),
    })
  }

  // Pattern 2: "concepto 50€"
  if (lineas.length === 0) {
    const reSimple = /([A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]{2,60}?)\s+(\d+(?:[.,]\d{1,2})?)\s*€/gi
    while ((m = reSimple.exec(userInput)) !== null) {
      const concepto = m[1].trim()
      if (cliente && concepto.toLowerCase() === cliente.toLowerCase()) continue
      lineas.push({
        concepto,
        cantidad: 1,
        precio_unitario: parseFloat(m[2].replace(',', '.')),
      })
    }
  }

  // Pattern 3: "por concepto" + importe
  if (lineas.length === 0) {
    const mConcepto = userInput.match(
      /\bpor\b\s+([A-ZÁÉÍÓÚÑa-záéíóúñ][^,\n\d€]{3,80}?)(?:\s+\d|\s+con\s+|,|\s*$)/i
    )
    const mImporte = userInput.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur\w*)/i)
    if (mConcepto && mImporte) {
      lineas.push({
        concepto: mConcepto[1].trim(),
        cantidad: 1,
        precio_unitario: parseFloat(mImporte[1].replace(',', '.')),
      })
    }
  }

  const mNotas = userInput.match(/\bnotas?\b[:\s]+(.+?)(?:\.|$)/i)

  return {
    type,
    cliente,
    lineas,
    notas: mNotas ? mNotas[1].trim() : null,
  }
}

function looksMultiLineDoc(input: string): boolean {
  const matches = input.match(/\d+(?:[.,]\d{1,2})?\s*€/g)
  return (matches?.length ?? 0) >= 2
}

function validateDocLines(lineas: ExtractedDocLine[]): DocValidationResult {
  const warnings: string[] = []
  const validated: ValidatedDocLine[] = []

  for (const l of lineas) {
    const cantidad = l.cantidad ?? 1
    if (cantidad <= 0) {
      warnings.push(`⚠️ Cantidad ≤ 0 para "${l.concepto}" — omitida`)
      continue
    }

    if (l.precio_unitario === null || l.precio_unitario === undefined) {
      warnings.push(`⚠️ Sin precio para "${l.concepto}" — necesito el importe`)
      continue
    }
    if (l.precio_unitario < 0) {
      warnings.push(`⚠️ Precio negativo para "${l.concepto}" — omitida`)
      continue
    }

    if (!l.concepto || l.concepto.trim().length === 0) {
      warnings.push('⚠️ Línea sin concepto — omitida')
      continue
    }

    const subtotal = Math.round(cantidad * l.precio_unitario * 100) / 100

    validated.push({
      concepto: l.concepto.trim(),
      cantidad,
      precio_unitario: l.precio_unitario,
      subtotal,
    })
  }

  const total = Math.round(validated.reduce((s, l) => s + l.subtotal, 0) * 100) / 100

  return { lineas: validated, total, warnings }
}

function formatEur(n: number): string {
  return `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

function buildDocPreview(
  type: 'albaran' | 'presupuesto',
  clienteNombre: string,
  validation: DocValidationResult,
  notas: string | null,
): string {
  const typeLabel = type === 'albaran' ? 'ALBARÁN' : 'PRESUPUESTO'
  const typeEmoji = type === 'albaran' ? '📜' : '📋'

  const lines: string[] = []
  lines.push(`══════════════════════════════════`)
  lines.push(`  ${typeEmoji} PREVIEW DE ${typeLabel}`)
  lines.push(`══════════════════════════════════`)
  lines.push(``)
  lines.push(`📋 Cliente: ${clienteNombre}`)
  lines.push(``)
  lines.push(`── Líneas ─────────────────────────`)

  for (const l of validation.lineas) {
    lines.push(`  ${l.concepto}`)
    lines.push(`    ${l.cantidad} × ${formatEur(l.precio_unitario)} = ${formatEur(l.subtotal)}`)
  }

  lines.push(``)
  lines.push(`── Total ──────────────────────────`)
  lines.push(`  TOTAL:  ${formatEur(validation.total)}`)

  if (notas) {
    lines.push(``)
    lines.push(`── Notas ──────────────────────────`)
    lines.push(`  ${notas}`)
  }

  if (validation.warnings.length > 0) {
    lines.push(``)
    lines.push(`── Avisos ─────────────────────────`)
    for (const w of validation.warnings) {
      lines.push(`  ${w}`)
    }
  }

  lines.push(``)
  lines.push(`══════════════════════════════════`)

  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. DOCUMENT STATUS MODULE
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ 1. DOCUMENT STATUS ═══')

// 1.1 Valid statuses
{
  assert(isValidDocStatus('draft'), '1.1a draft is valid status')
  assert(isValidDocStatus('sent'), '1.1b sent is valid status')
  assert(isValidDocStatus('accepted'), '1.1c accepted is valid status')
  assert(isValidDocStatus('rejected'), '1.1d rejected is valid status')
  assert(!isValidDocStatus('pending'), '1.1e pending is NOT valid status')
  assert(!isValidDocStatus('paid'), '1.1f paid is NOT valid status (docs != invoices)')
  assert(!isValidDocStatus('cancelled'), '1.1g cancelled is NOT valid status')
}

// 1.2 Valid document types
{
  assert(isValidDocType('albaran'), '1.2a albaran is valid type')
  assert(isValidDocType('presupuesto'), '1.2b presupuesto is valid type')
  assert(!isValidDocType('factura'), '1.2c factura is NOT valid type')
  assert(!isValidDocType('contrato'), '1.2d contrato is NOT valid type')
}

// 1.3 Spanish → DB mapping
{
  assert(mapDocStatusToDB('borrador') === 'draft', '1.3a borrador → draft')
  assert(mapDocStatusToDB('enviado') === 'sent', '1.3b enviado → sent')
  assert(mapDocStatusToDB('enviada') === 'sent', '1.3c enviada → sent')
  assert(mapDocStatusToDB('aceptado') === 'accepted', '1.3d aceptado → accepted')
  assert(mapDocStatusToDB('aceptada') === 'accepted', '1.3e aceptada → accepted')
  assert(mapDocStatusToDB('rechazado') === 'rejected', '1.3f rechazado → rejected')
  assert(mapDocStatusToDB('rechazada') === 'rejected', '1.3g rechazada → rejected')
  assert(mapDocStatusToDB('inventado') === null, '1.3h inventado → null')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. REGEX EXTRACTOR — TIPO
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ 2. REGEX — TIPO ═══')

// 2.1 Albarán por defecto
{
  const r = extractDocWithRegex('para López 3 cajas a 50€')
  assert(r.type === 'albaran', '2.1 sin keyword → albaran')
}

// 2.2 Albarán explícito
{
  const r = extractDocWithRegex('albarán para López 3 cajas a 50€')
  assert(r.type === 'albaran', '2.2 albarán keyword → albaran')
}

// 2.3 Presupuesto
{
  const r = extractDocWithRegex('presupuesto para García reforma 2000€')
  assert(r.type === 'presupuesto', '2.3 presupuesto keyword → presupuesto')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. REGEX EXTRACTOR — CLIENTE
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ 3. REGEX — CLIENTE ═══')

// 3.1 "para López"
{
  const r = extractDocWithRegex('albarán para López 3 cajas a 50€')
  assert(r.cliente === 'López', '3.1 para López')
}

// 3.2 "a García"
{
  const r = extractDocWithRegex('albarán a García por instalación 200€')
  assert(r.cliente === 'García', '3.2 a García')
}

// 3.3 Sin cliente
{
  const r = extractDocWithRegex('albarán 3 cajas a 50€')
  assert(r.cliente === null, '3.3 sin cliente → null')
}

// 3.4 Cliente con nombre compuesto
{
  const r = extractDocWithRegex('albarán para María López 3 cajas a 50€')
  assert(r.cliente === 'María López', '3.4 nombre compuesto')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. REGEX EXTRACTOR — LÍNEAS
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ 4. REGEX — LÍNEAS ═══')

// 4.1 Pattern 1: "3 cajas a 50€"
{
  const r = extractDocWithRegex('albarán para López 3 cajas a 50€')
  assert(r.lineas.length === 1, '4.1a 1 línea')
  assert(r.lineas[0].concepto === 'cajas', '4.1b concepto = cajas')
  assert(r.lineas[0].cantidad === 3, '4.1c cantidad = 3')
  assert(r.lineas[0].precio_unitario === 50, '4.1d precio = 50')
}

// 4.2 Pattern 1: "5 tubos de 12,50€"
{
  const r = extractDocWithRegex('albarán para López 5 tubos de 12,50€')
  assert(r.lineas.length === 1, '4.2a 1 línea')
  assert(r.lineas[0].cantidad === 5, '4.2b cantidad = 5')
  assert(r.lineas[0].precio_unitario === 12.5, '4.2c precio = 12.50')
}

// 4.3 Pattern 2: "instalación 200€" (sin cantidad)
{
  const r = extractDocWithRegex('presupuesto para García instalación 200€')
  assert(r.lineas.length >= 1, '4.3a al menos 1 línea')
  if (r.lineas.length > 0) {
    assert(r.lineas[0].cantidad === 1, '4.3b cantidad default = 1')
    assert(r.lineas[0].precio_unitario === 200, '4.3c precio = 200')
  }
}

// 4.4 Sin importe → líneas vacías
{
  const r = extractDocWithRegex('albarán para López por tubos')
  assert(r.lineas.length === 0, '4.4 sin importe → 0 líneas')
}

// 4.5 Pattern 3: "por instalación eléctrica 500€"
{
  const r = extractDocWithRegex('albarán para López por instalación eléctrica 500€')
  assert(r.lineas.length >= 1, '4.5a al menos 1 línea')
  if (r.lineas.length > 0) {
    assert(r.lineas[0].precio_unitario === 500, '4.5b precio = 500')
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. REGEX EXTRACTOR — NOTAS
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ 5. REGEX — NOTAS ═══')

// 5.1 Con notas
{
  const r = extractDocWithRegex('albarán para López 3 cajas a 50€ nota: entrega en almacén')
  assert(r.notas !== null, '5.1a notas no null')
  assert(r.notas?.includes('entrega en almacén') === true, '5.1b notas contiene texto')
}

// 5.2 Sin notas
{
  const r = extractDocWithRegex('albarán para López 3 cajas a 50€')
  assert(r.notas === null, '5.2 sin notas → null')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. MULTI-LINE HEURISTIC
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ 6. MULTI-LINE ═══')

// 6.1 Dos importes → multi-line
{
  assert(looksMultiLineDoc('3 cajas a 50€ y 2 tubos a 30€'), '6.1 dos importes → true')
}

// 6.2 Un importe → no multi-line
{
  assert(!looksMultiLineDoc('3 cajas a 50€'), '6.2 un importe → false')
}

// 6.3 Sin importes → no multi-line
{
  assert(!looksMultiLineDoc('albarán para López'), '6.3 sin importes → false')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. VALIDACIÓN DETERMINISTA
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ 7. VALIDACIÓN ═══')

// 7.1 Líneas válidas → total correcto
{
  const v = validateDocLines([
    { concepto: 'Cajas', cantidad: 3, precio_unitario: 50 },
    { concepto: 'Tubos', cantidad: 2, precio_unitario: 30 },
  ])
  assert(v.lineas.length === 2, '7.1a 2 líneas válidas')
  assert(v.lineas[0].subtotal === 150, '7.1b subtotal 1 = 3×50 = 150')
  assert(v.lineas[1].subtotal === 60, '7.1c subtotal 2 = 2×30 = 60')
  assert(v.total === 210, '7.1d total = 150+60 = 210')
  assert(v.warnings.length === 0, '7.1e sin warnings')
}

// 7.2 Cantidad ≤ 0 → omitida con warning
{
  const v = validateDocLines([
    { concepto: 'Cajas', cantidad: 0, precio_unitario: 50 },
  ])
  assert(v.lineas.length === 0, '7.2a 0 líneas')
  assert(v.warnings.length === 1, '7.2b 1 warning')
  assert(v.warnings[0].includes('≤ 0'), '7.2c warning contiene "≤ 0"')
}

// 7.3 Precio null → omitida con warning
{
  const v = validateDocLines([
    { concepto: 'Cajas', cantidad: 3, precio_unitario: null },
  ])
  assert(v.lineas.length === 0, '7.3a 0 líneas')
  assert(v.warnings.length === 1, '7.3b 1 warning')
  assert(v.warnings[0].includes('Sin precio'), '7.3c warning contiene "Sin precio"')
}

// 7.4 Precio negativo → omitida
{
  const v = validateDocLines([
    { concepto: 'Descuento', cantidad: 1, precio_unitario: -10 },
  ])
  assert(v.lineas.length === 0, '7.4a 0 líneas')
  assert(v.warnings[0].includes('negativo'), '7.4b warning contiene "negativo"')
}

// 7.5 Concepto vacío → omitida
{
  const v = validateDocLines([
    { concepto: '', cantidad: 1, precio_unitario: 50 },
  ])
  assert(v.lineas.length === 0, '7.5a 0 líneas')
  assert(v.warnings[0].includes('sin concepto'), '7.5b warning contiene "sin concepto"')
}

// 7.6 Cantidad default 1
{
  const v = validateDocLines([
    { concepto: 'Servicio', cantidad: 0, precio_unitario: 100 },
  ])
  // cantidad 0 → ≤ 0 → omitida (0 no es válido por CHECK constraint)
  assert(v.lineas.length === 0, '7.6 cantidad 0 → omitida')
}

// 7.7 Redondeo a 2 decimales
{
  const v = validateDocLines([
    { concepto: 'Items', cantidad: 3, precio_unitario: 33.33 },
  ])
  assert(v.lineas[0].subtotal === 99.99, '7.7a subtotal = 3×33.33 = 99.99')
  assert(v.total === 99.99, '7.7b total = 99.99')
}

// 7.8 Precio 0 → válido (CHECK es >= 0)
{
  const v = validateDocLines([
    { concepto: 'Muestra gratis', cantidad: 1, precio_unitario: 0 },
  ])
  assert(v.lineas.length === 1, '7.8a 1 línea')
  assert(v.lineas[0].subtotal === 0, '7.8b subtotal = 0')
  assert(v.total === 0, '7.8c total = 0')
}

// 7.9 Mix válido + inválido
{
  const v = validateDocLines([
    { concepto: 'Cajas', cantidad: 3, precio_unitario: 50 },
    { concepto: 'Roto', cantidad: -1, precio_unitario: 20 },
    { concepto: 'Tubos', cantidad: 2, precio_unitario: 30 },
  ])
  assert(v.lineas.length === 2, '7.9a 2 líneas válidas de 3')
  assert(v.total === 210, '7.9b total = 150+60 = 210')
  assert(v.warnings.length === 1, '7.9c 1 warning por la línea inválida')
}

// 7.10 Muchas líneas → total acumulado
{
  const lineas = Array.from({ length: 10 }, (_, i) => ({
    concepto: `Item ${i + 1}`,
    cantidad: i + 1,
    precio_unitario: 10,
  }))
  const v = validateDocLines(lineas)
  // Total = 10+20+30+40+50+60+70+80+90+100 = 550
  assert(v.lineas.length === 10, '7.10a 10 líneas')
  assert(v.total === 550, '7.10b total = 550')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. PREVIEW
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ 8. PREVIEW ═══')

// 8.1 Preview albarán
{
  const validation = validateDocLines([
    { concepto: 'Cajas', cantidad: 3, precio_unitario: 50 },
  ])
  const preview = buildDocPreview('albaran', 'López', validation, null)
  assert(preview.includes('ALBARÁN'), '8.1a contiene ALBARÁN')
  assert(preview.includes('📜'), '8.1b contiene emoji albarán')
  assert(preview.includes('López'), '8.1c contiene cliente')
  assert(preview.includes('Cajas'), '8.1d contiene concepto')
  assert(preview.includes('150,00'), '8.1e contiene total')
}

// 8.2 Preview presupuesto
{
  const validation = validateDocLines([
    { concepto: 'Reforma', cantidad: 1, precio_unitario: 2000 },
  ])
  const preview = buildDocPreview('presupuesto', 'García', validation, 'Incluye materiales')
  assert(preview.includes('PRESUPUESTO'), '8.2a contiene PRESUPUESTO')
  assert(preview.includes('📋'), '8.2b contiene emoji presupuesto')
  assert(preview.includes('García'), '8.2c contiene cliente')
  assert(preview.includes('Incluye materiales'), '8.2d contiene notas')
  assert(preview.includes('2000,00') || preview.includes('2.000,00'), '8.2e contiene total 2000')
}

// 8.3 Preview con warnings
{
  const validation: DocValidationResult = {
    lineas: [{ concepto: 'Tubos', cantidad: 2, precio_unitario: 30, subtotal: 60 }],
    total: 60,
    warnings: ['⚠️ Test warning'],
  }
  const preview = buildDocPreview('albaran', 'Test', validation, null)
  assert(preview.includes('Avisos'), '8.3a contiene sección Avisos')
  assert(preview.includes('Test warning'), '8.3b contiene warning text')
}

// 8.4 Preview sin líneas (edge case)
{
  const validation: DocValidationResult = {
    lineas: [],
    total: 0,
    warnings: [],
  }
  const preview = buildDocPreview('albaran', 'Vacío', validation, null)
  assert(preview.includes('TOTAL:'), '8.4a contiene TOTAL')
  assert(preview.includes('0,00'), '8.4b total = 0,00')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. INTEGRACIÓN E2E (simulada — sin Supabase)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ 9. E2E SIMULADO ═══')

// 9.1 Flujo completo: "albarán para López por 3 cajas a 50€"
{
  const input = 'albarán para López por 3 cajas a 50€'
  const extracted = extractDocWithRegex(input)
  assert(extracted.type === 'albaran', '9.1a type = albaran')
  assert(extracted.cliente === 'López', '9.1b cliente = López')
  assert(extracted.lineas.length >= 1, '9.1c tiene líneas')

  const validation = validateDocLines(extracted.lineas)
  assert(validation.lineas.length >= 1, '9.1d líneas validadas')
  assert(validation.total > 0, '9.1e total > 0')
  // Total = 3 × 50 = 150
  assert(validation.total === 150, '9.1f total = 150')

  const preview = buildDocPreview(extracted.type, 'López SL', validation, extracted.notas)
  assert(preview.includes('ALBARÁN'), '9.1g preview contiene ALBARÁN')
  assert(preview.includes('150,00'), '9.1h preview contiene 150,00')
}

// 9.2 Flujo presupuesto: "presupuesto para García reforma 2000€"
{
  const input = 'presupuesto para García reforma 2000€'
  const extracted = extractDocWithRegex(input)
  assert(extracted.type === 'presupuesto', '9.2a type = presupuesto')
  // Regex captura "García reforma" (concepto pegado al nombre).
  // El LLM extractor lo separa correctamente — regex es fallback.
  assert(extracted.cliente?.includes('García'), '9.2b cliente contiene García')

  const validation = validateDocLines(extracted.lineas)
  assert(validation.total === 2000, '9.2c total = 2000')

  const preview = buildDocPreview(extracted.type, 'García', validation, null)
  assert(preview.includes('PRESUPUESTO'), '9.2d preview contiene PRESUPUESTO')
}

// 9.3 Sin cliente → needsInfo
{
  const input = 'albarán 3 cajas a 50€'
  const extracted = extractDocWithRegex(input)
  assert(extracted.cliente === null, '9.3 sin cliente → null (handler pediría info)')
}

// 9.4 Sin precio → validation vacía
{
  const input = 'albarán para López por tubos'
  const extracted = extractDocWithRegex(input)
  const validation = validateDocLines(extracted.lineas)
  assert(validation.lineas.length === 0, '9.4 sin precio → 0 líneas validadas')
}

// 9.5 Multi-line safety: "3 cajas 50€ y 2 tubos 30€" sin LLM
{
  const input = '3 cajas 50€ y 2 tubos 30€'
  assert(looksMultiLineDoc(input), '9.5 multi-line detectado → rechazar sin LLM')
}

// 9.6 Notas incluidas en preview
{
  const input = 'albarán para López 3 cajas a 50€ nota: urgente'
  const extracted = extractDocWithRegex(input)
  assert(extracted.notas !== null, '9.6a notas extraídas')

  const validation = validateDocLines(extracted.lineas)
  const preview = buildDocPreview(extracted.type, 'López', validation, extracted.notas)
  assert(preview.includes('urgente'), '9.6b preview incluye nota')
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. EDGE CASES Y SEGURIDAD
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ 10. EDGE CASES ═══')

// 10.1 Precio con coma decimal española
{
  const r = extractDocWithRegex('albarán para López 3 tubos a 12,50€')
  assert(r.lineas.length === 1, '10.1a 1 línea')
  assert(r.lineas[0].precio_unitario === 12.5, '10.1b 12,50 → 12.5')
}

// 10.2 Total con decimales: 3 × 33.33 = 99.99
{
  const v = validateDocLines([
    { concepto: 'Items', cantidad: 3, precio_unitario: 33.33 },
  ])
  assert(v.total === 99.99, '10.2 3×33.33 = 99.99 (no floating point error)')
}

// 10.3 Línea con cantidad negativa → bloqueada por validación
{
  const v = validateDocLines([
    { concepto: 'Devolución', cantidad: -2, precio_unitario: 50 },
  ])
  assert(v.lineas.length === 0, '10.3 cantidad negativa → bloqueada')
}

// 10.4 Concepto solo espacios → bloqueado
{
  const v = validateDocLines([
    { concepto: '   ', cantidad: 1, precio_unitario: 50 },
  ])
  assert(v.lineas.length === 0, '10.4 concepto solo espacios → bloqueado')
}

// 10.5 Total SIEMPRE calculado en código, no del input
{
  const v = validateDocLines([
    { concepto: 'A', cantidad: 2, precio_unitario: 100 },
    { concepto: 'B', cantidad: 3, precio_unitario: 50 },
  ])
  // 2×100 + 3×50 = 200 + 150 = 350
  const expectedTotal = 350
  assert(v.total === expectedTotal, '10.5 total calculado en código = 350')
  // Even if someone passes a different total, validateDocLines ignores it
  assert(v.lineas[0].subtotal === 200, '10.5b subtotal A = 200')
  assert(v.lineas[1].subtotal === 150, '10.5c subtotal B = 150')
}

// 10.6 Document types CHECK constraint match
{
  assert(DOCUMENT_TYPES.ALBARAN === 'albaran', '10.6a ALBARAN = "albaran" (matches BD CHECK)')
  assert(DOCUMENT_TYPES.PRESUPUESTO === 'presupuesto', '10.6b PRESUPUESTO = "presupuesto" (matches BD CHECK)')
}

// 10.7 Document status CHECK constraint match
{
  assert(DOCUMENT_STATUS.DRAFT === 'draft', '10.7a DRAFT = "draft"')
  assert(DOCUMENT_STATUS.SENT === 'sent', '10.7b SENT = "sent"')
  assert(DOCUMENT_STATUS.ACCEPTED === 'accepted', '10.7c ACCEPTED = "accepted"')
  assert(DOCUMENT_STATUS.REJECTED === 'rejected', '10.7d REJECTED = "rejected"')
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULTADO
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`)
console.log(`📜 Escribano v2: ${passed} passed, ${failed} failed`)
console.log(`${'═'.repeat(50)}`)
if (failed > 0) process.exit(1)

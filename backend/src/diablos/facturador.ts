/**
 * 🧾 El Facturador v2 — Arquitectura híbrida LLM + determinista
 *
 * Capa 1: Extractor LLM (OpenRouter Hermes 3 70B, temp 0)
 * Capa 2: Validación determinista (CIF/NIF, IVA, cálculos)
 * Capa 3: Preview rico + Confirmation Gate (INTOCABLE)
 *
 * PRINCIPIO INNEGOCIABLE: crear_factura, enviar_factura y cambiar_estado
 * NUNCA ejecutan un write sin confirmación explícita. Enforced por CÓDIGO.
 */

import { createPendingAction } from '../confirmation'
import { getSupabase } from './index'
import { DIABLO_METAS } from './metas'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './metas'
import type { AgentInput } from '../core'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ExtractedLine {
  concepto: string
  cantidad: number
  precio_unitario: number | null
  tipo_iva: number | null
}

interface ExtractedData {
  cliente: string | null
  cif_nif: string | null
  email: string | null
  lineas: ExtractedLine[]
  accion: 'crear' | 'enviar' | 'cambiar_estado'
  estado_deseado: string | null
  referencia_factura: string | null
}

interface ValidatedLine {
  concepto: string
  cantidad: number
  precio_unitario: number
  tipo_iva: number
  iva_asumido: boolean      // true si se usó 21% por defecto
  base_imponible: number
  cuota_iva: number
  total_linea: number
  producto_catalogo: string | null
}

interface ValidationResult {
  lineas: ValidatedLine[]
  subtotal: number
  desglose_iva: Array<{ tipo: number; base: number; cuota: number }>
  total: number
  cif_nif: string | null
  cif_nif_valido: boolean | null  // null = no proporcionado
  warnings: string[]
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 1 — EXTRACTOR LLM
// ═══════════════════════════════════════════════════════════════════════════════

const EXTRACTION_PROMPT = `Eres un extractor de datos de facturas. Tu ÚNICO trabajo es extraer datos estructurados del mensaje del usuario.

REGLAS ABSOLUTAS:
- Responde SOLO con JSON válido, SIN markdown, SIN explicaciones
- Si un campo no está en el texto → null
- PROHIBIDO inventar datos. Solo extrae lo que el usuario dice explícitamente
- Los precios son SIEMPRE con IVA incluido (total), salvo que el usuario diga "más IVA" o "sin IVA" o "base"
- Si el usuario dice "más IVA" o "sin IVA" o "+ IVA", el precio es base (sin IVA)
- cantidad por defecto = 1
- tipo_iva: solo si el usuario lo menciona explícitamente (21, 10, 4, 0). Si no → null

Schema de respuesta:
{
  "cliente": string | null,
  "cif_nif": string | null,
  "email": string | null,
  "lineas": [
    {
      "concepto": string,
      "cantidad": number,
      "precio_unitario": number | null,
      "tipo_iva": number | null
    }
  ],
  "accion": "crear" | "enviar" | "cambiar_estado",
  "estado_deseado": "pagada" | "pendiente" | "anulada" | null,
  "referencia_factura": string | null
}`

async function extractWithLLM(userInput: string): Promise<ExtractedData | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://diabolus.es',
        'X-Title': 'Diabolus CRM',
      },
      body: JSON.stringify({
        model: 'nousresearch/hermes-3-llama-3.1-70b',
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: userInput },
        ],
      }),
    })

    if (!resp.ok) return null

    const data = await resp.json()
    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) return null

    // Limpiar posible markdown wrapper
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()

    const parsed = JSON.parse(cleaned) as ExtractedData

    // Validación mínima del schema
    if (!parsed || typeof parsed !== 'object') return null
    if (!Array.isArray(parsed.lineas)) parsed.lineas = []
    if (!['crear', 'enviar', 'cambiar_estado'].includes(parsed.accion)) {
      parsed.accion = 'crear'
    }

    return parsed
  } catch {
    return null  // Fallback a regex
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 1b — FALLBACK REGEX (los regex originales, intactos)
// ═══════════════════════════════════════════════════════════════════════════════

function extractWithRegex(userInput: string, intent: string): ExtractedData {
  const noEnviar = /no env[íi]|sin enviar|solo crea|solo borrador/i.test(userInput)
  const wantsSend = !noEnviar && /env[íi]a|manda(?:l[ao])?|por\s+email|al\s+correo/i.test(userInput)

  // Acción
  let accion: 'crear' | 'enviar' | 'cambiar_estado' = wantsSend ? 'enviar' : 'crear'
  if (intent === 'cambiar_estado') accion = 'cambiar_estado'

  // Cliente
  const mCliente = userInput.match(
    /(?:para|a)\s+(?:(?:el|la|los|las|un|una)\s+)?([a-záéíóúñA-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,55}?)(?:\s+(?:con|por|de|,)|\s+\d|$)/i
  )
  let cliente = mCliente ? mCliente[1].trim().replace(/^(?:el|la|los|las|un|una|a)\s+/i, '').trim() : null

  // Importe
  let precio: number | null = null
  const mImporte = userInput.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur\w*)/i)
  if (mImporte) precio = parseFloat(mImporte[1].replace(',', '.'))

  // Concepto
  let concepto: string | null = null
  const mConcepto = userInput.match(
    /(?:concepto\s+(?:de\s+)?)([^,\n]+?)(?:\s+con\s+(?:el\s+)?(?:cif|nif)|,|\s*$)/i
  ) || userInput.match(
    /\bpor\b\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][^,\n\d€]{3,80}?)(?:\s+\d|\s+con\s+|\s+cif\b|\s+nif\b|,|\s*$)/i
  )
  if (mConcepto) {
    concepto = mConcepto[1].trim().replace(/^de\s+/i, '').trim()
    concepto = concepto.charAt(0).toUpperCase() + concepto.slice(1)
  }

  if (!concepto && precio) {
    const afterAmt = userInput.match(
      /\d+(?:[.,]\d{1,2})?\s*(?:€|eur\w*)?\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][^\d,\n]{2,60}?)(?:\s+con\s+(?:el\s+)?(?:cif|nif)|,|\s*$)/i
    )
    if (afterAmt) {
      const raw = afterAmt[1].trim().replace(/^(?:el|la|los|las|un|una|de|del|para|por)\s+/i, '').trim()
      if (raw.length > 2) concepto = raw.charAt(0).toUpperCase() + raw.slice(1)
    }
  }

  // CIF/NIF
  const mCif = userInput.match(/(?:cif|nif)\D{0,35}([A-Z]\s*\d{6,8}[A-Z0-9]?)/i)
  const cifNif = mCif ? mCif[1].replace(/\s/g, '').toUpperCase() : null

  // Email
  const mEmail = userInput.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
  const email = mEmail ? mEmail[1] : null

  // Estado deseado (para cambiar_estado)
  let estadoDeseado: string | null = null
  if (accion === 'cambiar_estado') {
    if (/vencid/i.test(userInput)) estadoDeseado = 'vencida'
    else if (/anuld|cancel/i.test(userInput)) estadoDeseado = 'anulada'
    else if (/pendiente/i.test(userInput)) estadoDeseado = 'pendiente'
    else estadoDeseado = 'pagada'
  }

  // Referencia factura
  const mRef = userInput.match(/(?:#|factura\s+)?(\d{4}-\d{3,4})/i)

  return {
    cliente,
    cif_nif: cifNif,
    email,
    lineas: concepto ? [{
      concepto,
      cantidad: 1,
      precio_unitario: precio,
      tipo_iva: null,
    }] : [],
    accion,
    estado_deseado: estadoDeseado,
    referencia_factura: mRef ? mRef[1] : null,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 2 — VALIDACIÓN Y CÁLCULO DETERMINISTA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validador CIF/NIF/NIE con algoritmo oficial español (dígito de control)
 */
function validateCifNif(value: string): boolean {
  if (!value) return false
  const v = value.toUpperCase().replace(/[\s-]/g, '')

  // NIF: 8 dígitos + letra
  const nifMatch = v.match(/^(\d{8})([A-Z])$/)
  if (nifMatch) {
    const letters = 'TRWAGMYFPDXBNJZSQVHLCKE'
    return letters[parseInt(nifMatch[1]) % 23] === nifMatch[2]
  }

  // NIE: X/Y/Z + 7 dígitos + letra
  const nieMatch = v.match(/^([XYZ])(\d{7})([A-Z])$/)
  if (nieMatch) {
    const prefix = { X: '0', Y: '1', Z: '2' }[nieMatch[1]]!
    const num = parseInt(prefix + nieMatch[2])
    const letters = 'TRWAGMYFPDXBNJZSQVHLCKE'
    return letters[num % 23] === nieMatch[3]
  }

  // CIF: letra + 7 dígitos + dígito/letra de control
  const cifMatch = v.match(/^([ABCDEFGHJKLMNPQRSUVW])(\d{7})([A-J0-9])$/)
  if (cifMatch) {
    const digits = cifMatch[2]
    let sumA = 0
    let sumB = 0
    for (let i = 0; i < 7; i++) {
      const d = parseInt(digits[i])
      if (i % 2 === 0) {
        // Posiciones impares (1,3,5,7) → multiplicar por 2
        const doubled = d * 2
        sumB += Math.floor(doubled / 10) + (doubled % 10)
      } else {
        // Posiciones pares (2,4,6) → sumar directamente
        sumA += d
      }
    }
    const total = sumA + sumB
    const control = (10 - (total % 10)) % 10
    const controlLetter = 'JABCDEFGHI'[control]

    // Algunos tipos solo aceptan letra, otros dígito, otros ambos
    const letterOnly = 'KLMNPQRSW'
    const digitOnly = 'ABEH'
    if (letterOnly.includes(cifMatch[1])) {
      return cifMatch[3] === controlLetter
    } else if (digitOnly.includes(cifMatch[1])) {
      return cifMatch[3] === String(control)
    } else {
      return cifMatch[3] === String(control) || cifMatch[3] === controlLetter
    }
  }

  return false
}

/**
 * Capa 2: Validación determinista + cálculos
 * - Match en catálogo
 * - IVA por tipo
 * - Redondeo 2 decimales por línea
 * - CIF/NIF validación
 */
async function validateAndCalculate(
  extracted: ExtractedData,
  tenantId: string
): Promise<ValidationResult> {
  const supabase = getSupabase()
  const warnings: string[] = []

  // CIF/NIF validation
  let cifNifValido: boolean | null = null
  if (extracted.cif_nif) {
    cifNifValido = validateCifNif(extracted.cif_nif)
    if (!cifNifValido) {
      warnings.push(`⚠️ CIF/NIF "${extracted.cif_nif}" no pasa la validación del dígito de control`)
    }
  }

  // Validar y calcular cada línea
  const validatedLines: ValidatedLine[] = []

  for (const linea of extracted.lineas) {
    let precioUnit = linea.precio_unitario
    let tipoIva = linea.tipo_iva
    let ivaAsumido = false
    let productoCatalogo: string | null = null

    // Buscar en catálogo
    if (linea.concepto) {
      const { data: productos } = await supabase
        .from('products')
        .select('name, price, iva_rate')
        .eq('salon_id', tenantId)
        .eq('is_active', true)
        .ilike('name', `%${linea.concepto}%`)
        .limit(1)

      if (productos?.length) {
        productoCatalogo = productos[0].name
        // Si no hay precio → usar catálogo
        if (!precioUnit) {
          precioUnit = productos[0].price
          // price del catálogo es base (sin IVA)
        }
        // Si no hay IVA → usar catálogo
        if (tipoIva === null && productos[0].iva_rate !== null) {
          tipoIva = productos[0].iva_rate
        }
      }
    }

    // Si sigue sin IVA → 21% por defecto, marcado como asumido
    if (tipoIva === null) {
      tipoIva = 21
      ivaAsumido = true
    }

    // Si sigue sin precio → no podemos calcular
    if (!precioUnit || precioUnit <= 0) {
      continue  // Se pedirá al usuario
    }

    // Determinar si el precio incluye IVA o es base
    // Por defecto: el usuario da precio con IVA incluido
    // Si viene del catálogo: es precio base
    let baseUnit: number
    if (productoCatalogo && !linea.precio_unitario) {
      // Precio del catálogo = base
      baseUnit = precioUnit
    } else {
      // Precio del usuario = con IVA → extraer base
      baseUnit = precioUnit / (1 + tipoIva / 100)
    }

    const cantidad = linea.cantidad || 1
    const baseImponible = Math.round(baseUnit * cantidad * 100) / 100
    const cuotaIva = Math.round(baseImponible * (tipoIva / 100) * 100) / 100
    const totalLinea = Math.round((baseImponible + cuotaIva) * 100) / 100

    if (ivaAsumido) {
      warnings.push(`⚠️ IVA 21% asumido para "${linea.concepto}" (no especificado)`)
    }

    validatedLines.push({
      concepto: productoCatalogo || linea.concepto,
      cantidad,
      precio_unitario: Math.round(baseUnit * 100) / 100,
      tipo_iva: tipoIva,
      iva_asumido: ivaAsumido,
      base_imponible: baseImponible,
      cuota_iva: cuotaIva,
      total_linea: totalLinea,
      producto_catalogo: productoCatalogo,
    })
  }

  // Desglose IVA agrupado por tipo
  const ivaMap = new Map<number, { base: number; cuota: number }>()
  for (const l of validatedLines) {
    const existing = ivaMap.get(l.tipo_iva) || { base: 0, cuota: 0 }
    existing.base += l.base_imponible
    existing.cuota += l.cuota_iva
    ivaMap.set(l.tipo_iva, existing)
  }
  const desgloseIva = Array.from(ivaMap.entries()).map(([tipo, v]) => ({
    tipo,
    base: Math.round(v.base * 100) / 100,
    cuota: Math.round(v.cuota * 100) / 100,
  }))

  const subtotal = Math.round(validatedLines.reduce((s, l) => s + l.base_imponible, 0) * 100) / 100
  const total = Math.round(validatedLines.reduce((s, l) => s + l.total_linea, 0) * 100) / 100

  return {
    lineas: validatedLines,
    subtotal,
    desglose_iva: desgloseIva,
    total,
    cif_nif: extracted.cif_nif,
    cif_nif_valido: cifNifValido,
    warnings,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 3 — PREVIEW + CONFIRMATION GATE
// ═══════════════════════════════════════════════════════════════════════════════

function formatEur(n: number): string {
  return `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

function buildPreview(
  validation: ValidationResult,
  clienteNombre: string,
  clienteEmail: string | null,
  accion: 'crear' | 'enviar',
): string {
  const lines: string[] = []

  lines.push(`══════════════════════════════════`)
  lines.push(`  🧾 PREVIEW DE FACTURA`)
  lines.push(`══════════════════════════════════`)
  lines.push(``)
  lines.push(`📋 Cliente: ${clienteNombre}`)

  if (validation.cif_nif) {
    const badge = validation.cif_nif_valido === false ? ' ⚠️ INVÁLIDO' : ' ✅'
    lines.push(`🪪 CIF/NIF: ${validation.cif_nif}${badge}`)
  } else {
    lines.push(`🪪 CIF/NIF: — (no proporcionado)`)
  }

  if (clienteEmail) {
    lines.push(`📧 Email: ${clienteEmail}`)
  }

  lines.push(``)
  lines.push(`── Líneas ─────────────────────────`)

  for (const l of validation.lineas) {
    const catTag = l.producto_catalogo ? ' 📦' : ''
    const ivaTag = l.iva_asumido ? ' ⚠️asumido' : ''
    lines.push(`  ${l.concepto}${catTag}`)
    lines.push(`    ${l.cantidad} × ${formatEur(l.precio_unitario)} = Base: ${formatEur(l.base_imponible)}`)
    lines.push(`    IVA ${l.tipo_iva}%${ivaTag}: ${formatEur(l.cuota_iva)}`)
    lines.push(`    Subtotal línea: ${formatEur(l.total_linea)}`)
  }

  lines.push(``)
  lines.push(`── Desglose IVA ───────────────────`)
  for (const d of validation.desglose_iva) {
    lines.push(`  IVA ${d.tipo}%: Base ${formatEur(d.base)} → Cuota ${formatEur(d.cuota)}`)
  }

  lines.push(``)
  lines.push(`── Totales ────────────────────────`)
  lines.push(`  Base imponible: ${formatEur(validation.subtotal)}`)
  lines.push(`  IVA total:      ${formatEur(validation.total - validation.subtotal)}`)
  lines.push(`  TOTAL:          ${formatEur(validation.total)}`)
  lines.push(``)

  const accionText = accion === 'enviar'
    ? '📧 Crear factura (BORRADOR/PROFORMA) + enviar por email'
    : '🧾 Crear factura (BORRADOR/PROFORMA)'
  lines.push(`🎯 Acción: ${accionText}`)

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
// HEURÍSTICA: ¿parece multi-línea?
// Si hay 2+ importes en € en el input, regex no puede extraer correctamente
// ═══════════════════════════════════════════════════════════════════════════════

function looksMultiLine(input: string): boolean {
  const matches = input.match(/\d+(?:[.,]\d{1,2})?\s*€/g)
  return (matches?.length ?? 0) >= 2
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId } = input
  const userInput = (input.text || '').trim()
  const supabase = getSupabase()

  // ── Facturas vencidas (READ ONLY — sin gate) ─────────────────────────────
  if (classification.intent === 'facturas_vencidas') {
    return { replyText: await fetchOverdue(tenantId) }
  }

  // ── CAPA 1: Extracción ────────────────────────────────────────────────────
  let extracted = await extractWithLLM(userInput)
  let usedFallback = false

  // Fallback a regex si LLM falló
  if (!extracted) {
    // SEGURIDAD: si el input parece multi-línea (varios importes en €),
    // el regex NO puede extraer correctamente → rechazar, no crear parcial
    if (looksMultiLine(userInput)) {
      return {
        replyText: '⚠️ No pude procesar la factura completa. Parece que tiene varias líneas y necesito que me las confirmes una a una.\n\n' +
          'Por favor, repítelo así:\n' +
          '• "Factura a [cliente] por [concepto] [importe]€"\n\n' +
          'O simplifica: "Factura a García, consultoría 500€, formación 300€" → y lo proceso con el extractor inteligente.',
      }
    }
    extracted = extractWithRegex(userInput, classification.intent)
    usedFallback = true
  }

  // Forzar acción según intent del router si es cambiar_estado
  if (classification.intent === 'cambiar_estado') {
    extracted.accion = 'cambiar_estado'
  }

  // ── CAMBIAR ESTADO ────────────────────────────────────────────────────────
  if (extracted.accion === 'cambiar_estado') {
    return handleCambiarEstado(extracted, userInput, tenantId, userId)
  }

  // ── CREAR / ENVIAR FACTURA ────────────────────────────────────────────────

  // ¿Hay cliente?
  if (!extracted.cliente) {
    return { needsInfo: '¿Para qué cliente es la factura? Ej: "factura a García 800€ instalación"' }
  }

  // ¿Hay al menos una línea con concepto?
  if (!extracted.lineas.length || !extracted.lineas[0].concepto) {
    return { needsInfo: `¿Cuál es el concepto para ${extracted.cliente}? Ej: "instalación eléctrica", "consultoría"` }
  }

  // ── CAPA 2: Validación y cálculo ──────────────────────────────────────────
  const validation = await validateAndCalculate(extracted, tenantId)

  // ¿Hay líneas sin precio?
  if (validation.lineas.length === 0) {
    const conceptos = extracted.lineas.map(l => l.concepto).join(', ')
    return { needsInfo: `¿Por qué importe es la factura (${conceptos})? Ej: "150€"` }
  }

  // Buscar cliente en BD
  const { data: clientes } = await supabase
    .from('clients')
    .select('id, name, email, nif')
    .eq('salon_id', tenantId)
    .ilike('name', `%${extracted.cliente}%`)
    .limit(3)

  if (!clientes?.length) {
    return { needsInfo: `No encontré al cliente "${extracted.cliente}". ¿Lo creamos? Di "nuevo cliente ${extracted.cliente}".` }
  }

  const cliente = clientes[0]
  const clienteEmail = extracted.email || cliente.email || null

  // ¿Quiere enviar pero no hay email?
  const noEnviar = /no env[íi]|sin enviar|solo crea|solo borrador/i.test(userInput)
  const wantsSend = extracted.accion === 'enviar' && !noEnviar
  if (wantsSend && !clienteEmail) {
    return { needsInfo: `Para enviar la factura a ${cliente.name} necesito su email. ¿Cuál es?` }
  }

  const doSend = wantsSend && !!clienteEmail
  const actionType = doSend ? 'enviar_factura' : 'crear_factura'

  // ── CAPA 3: Preview + Gate ────────────────────────────────────────────────
  const preview = buildPreview(
    validation,
    cliente.name,
    doSend ? clienteEmail : null,
    doSend ? 'enviar' : 'crear',
  )

  // Preparar parámetros para el gate (los mismos que usa confirmation.ts)
  const params: Record<string, any> = {
    cliente_id: cliente.id,
    cliente_nombre: cliente.name,
    lineas: validation.lineas.map(l => ({
      concepto: l.concepto,
      cantidad: l.cantidad,
      precio_unitario: l.precio_unitario,
      iva: l.tipo_iva,
    })),
    total: validation.total,
    subtotal: validation.subtotal,
    desglose_iva: validation.desglose_iva,
    fecha: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
    verifactu_hash: null,  // Preparado para VeriFactu futuro
  }
  if (doSend) params.cliente_email = clienteEmail
  if (validation.cif_nif) {
    params.cif_nif = validation.cif_nif
    params.cif_nif_valido = validation.cif_nif_valido
  }
  if (validation.warnings.length) params.warnings = validation.warnings

  // CONFIRMATION GATE — enforced por código, no por prompt
  const card = await createPendingAction(actionType, params, tenantId, userId)

  return {
    replyText: preview,
    card,
    camposDudosos: validation.warnings.length > 0
      ? validation.warnings.map(w => w.replace(/^⚠️\s*/, ''))
      : undefined,
    confianza: validation.warnings.length === 0 ? 'alta' : 'media',
  }
}

// ── CAMBIAR ESTADO (subflujo) ───────────────────────────────────────────────

async function handleCambiarEstado(
  extracted: ExtractedData,
  userInput: string,
  tenantId: string,
  userId?: string
): Promise<DiabloResponse> {
  const supabase = getSupabase()

  let nuevoEstado = extracted.estado_deseado || 'pagada'

  // Buscar factura por referencia o por nombre de cliente
  let invoice: any = null

  if (extracted.referencia_factura) {
    const { data } = await supabase
      .from('invoices')
      .select('id, number, total, status, clients(name)')
      .eq('salon_id', tenantId)
      .eq('number', extracted.referencia_factura)
      .single()
    invoice = data
  }

  if (!invoice && extracted.cliente) {
    const { data: clientes } = await supabase
      .from('clients').select('id').eq('salon_id', tenantId)
      .ilike('name', `%${extracted.cliente}%`).limit(1)
    if (clientes?.length) {
      const { data: facturas } = await supabase
        .from('invoices')
        .select('id, number, total, status, clients(name)')
        .eq('salon_id', tenantId).eq('client_id', clientes[0].id)
        .in('status', ['pending', 'sent'])
        .order('created_at', { ascending: false }).limit(1)
      if (facturas?.length) invoice = facturas[0]
    }
  }

  // Último intento: regex directo sobre el input
  if (!invoice) {
    const mNum = userInput.match(/(?:#|factura\s+)?(\d{4}-\d{3,4})/i)
    if (mNum) {
      const { data } = await supabase
        .from('invoices')
        .select('id, number, total, status, clients(name)')
        .eq('salon_id', tenantId)
        .eq('number', mNum[1])
        .single()
      invoice = data
    }
  }

  if (!invoice) {
    return { needsInfo: 'No encontré la factura. Dime el número (ej: "2026-001") o el nombre del cliente.' }
  }

  // CONFIRMATION GATE — enforced por código
  const card = await createPendingAction('cambiar_estado_factura', {
    factura_id: invoice.id,
    factura_numero: invoice.number,
    cliente_nombre: (invoice.clients as any)?.name || '',
    importe: invoice.total,
    estado_actual: invoice.status,
    nuevo_estado: nuevoEstado,
  }, tenantId, userId)

  return { card }
}

// ── READ: facturas vencidas ─────────────────────────────────────────────────

async function fetchOverdue(salonId: string): Promise<string> {
  try {
    const now = new Date().toISOString()
    const { data: invoices } = await getSupabase()
      .from('invoices').select('total, number, due_date, clients(name)')
      .eq('salon_id', salonId)
      .in('status', ['sent', 'pending'])
      .lt('due_date', now)
    if (!invoices?.length) return 'No hay facturas vencidas. 🎉'
    const total = invoices.reduce((s: number, i: any) => s + (i.total || 0), 0)
    const list = invoices.slice(0, 10).map((i: any) => {
      const name = (i.clients as any)?.name || '—'
      return `  • ${i.number} — ${name} — ${formatEur(i.total || 0)}`
    }).join('\n')
    return `📊 Facturas vencidas: ${invoices.length} | Total: ${formatEur(total)}\n\n${list}`
  } catch { return 'No se pudo consultar las facturas vencidas.' }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const FacturadorDiablo: DiabloHandler = {
  meta: DIABLO_METAS.facturador,
  handle,
}

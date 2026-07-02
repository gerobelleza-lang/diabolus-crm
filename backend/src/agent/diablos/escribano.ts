/**
 * 📜 El Escribano v2 — Albaranes y Presupuestos
 *
 * Capa 0: Retrieval (busca cliente en BD)
 * Capa 1: LLM extractor (extrae tipo, cliente, líneas del mensaje natural)
 * Capa 2: Validación determinista (cliente existe, cantidades > 0, total en código)
 * Capa 3: Preview rico + Confirmation Gate (INTOCABLE)
 *
 * PRINCIPIO INNEGOCIABLE: crear_albaran y crear_presupuesto
 * NUNCA ejecutan un write sin confirmación explícita. Enforced por CÓDIGO.
 *
 * Numeración: next_doc_number() en BD (pg_advisory_xact_lock) — sin huecos.
 * Total: calculado en código (cantidad × precio_unitario), NUNCA por LLM.
 */

import { createPendingAction } from '../confirmation'
import { getSupabase } from './index'
import { DIABLO_METAS } from './metas'
import { DOCUMENT_STATUS, DOCUMENT_TYPES, isValidDocType } from './document-status'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './metas'
import type { AgentInput } from '../core'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

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
  subtotal: number  // cantidad × precio_unitario — calculado en código
}

interface DocValidationResult {
  lineas: ValidatedDocLine[]
  total: number  // sum of all subtotals — calculado en código
  warnings: string[]
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 1 — EXTRACTOR LLM
// ═══════════════════════════════════════════════════════════════════════════════

const EXTRACTION_PROMPT = `Eres un extractor de datos de documentos comerciales (albaranes y presupuestos). Tu ÚNICO trabajo es extraer datos estructurados del mensaje del usuario.

REGLAS ABSOLUTAS:
- Responde SOLO con JSON válido, SIN markdown, SIN explicaciones
- Si un campo no está en el texto → null
- PROHIBIDO inventar datos. Solo extrae lo que el usuario dice explícitamente
- cantidad por defecto = 1
- Si el usuario dice "albarán" → type = "albaran"
- Si el usuario dice "presupuesto" → type = "presupuesto"
- Si no especifica → type = "albaran" (por defecto)

Schema de respuesta:
{
  "type": "albaran" | "presupuesto",
  "cliente": string | null,
  "lineas": [
    {
      "concepto": string,
      "cantidad": number,
      "precio_unitario": number | null
    }
  ],
  "notas": string | null
}`

export async function extractDocWithLLM(userInput: string): Promise<ExtractedDocData | null> {
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

    const cleaned = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()

    const parsed = JSON.parse(cleaned) as ExtractedDocData

    if (!parsed || typeof parsed !== 'object') return null
    if (!Array.isArray(parsed.lineas)) parsed.lineas = []
    if (!isValidDocType(parsed.type)) parsed.type = 'albaran'

    return parsed
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 1b — FALLBACK REGEX
// ═══════════════════════════════════════════════════════════════════════════════

export function extractDocWithRegex(userInput: string): ExtractedDocData {
  // Tipo
  const isPresupuesto = /\bpresupuesto\b/i.test(userInput)
  const type: 'albaran' | 'presupuesto' = isPresupuesto ? 'presupuesto' : 'albaran'

  // Cliente: "para|a <nombre>" pattern
  const mCliente = userInput.match(
    /(?:para|a)\s+(?:(?:el|la|los|las|un|una)\s+)?([A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]{1,55}?)(?:\s+(?:por|con|de|,)|\s+\d|$)/i
  )
  let cliente = mCliente
    ? mCliente[1].trim().replace(/^(?:el|la|los|las|un|una|a)\s+/i, '').trim()
    : null

  // Líneas: "N concepto a X€" or "concepto X€" patterns
  const lineas: ExtractedDocLine[] = []

  // Pattern 1: "3 cajas a 50€" / "3 cajas de 50€" / "3 cajas 50€"
  const reItems = /(\d+)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]{1,60}?)\s+(?:a|de|por)?\s*(\d+(?:[.,]\d{1,2})?)\s*€/gi
  let m: RegExpExecArray | null
  while ((m = reItems.exec(userInput)) !== null) {
    lineas.push({
      concepto: m[2].trim(),
      cantidad: parseInt(m[1]),
      precio_unitario: parseFloat(m[3].replace(',', '.')),
    })
  }

  // Pattern 2: "concepto 50€" (sin cantidad → 1)
  if (lineas.length === 0) {
    const reSimple = /([A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]{2,60}?)\s+(\d+(?:[.,]\d{1,2})?)\s*€/gi
    while ((m = reSimple.exec(userInput)) !== null) {
      // Evitar capturar el nombre del cliente como concepto
      const concepto = m[1].trim()
      if (cliente && concepto.toLowerCase() === cliente.toLowerCase()) continue
      lineas.push({
        concepto,
        cantidad: 1,
        precio_unitario: parseFloat(m[2].replace(',', '.')),
      })
    }
  }

  // Pattern 3: "por concepto" + "importe€" separados
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

  // Notas
  const mNotas = userInput.match(/\bnotas?\b[:\s]+(.+?)(?:\.|$)/i)

  return {
    type,
    cliente,
    lineas,
    notas: mNotas ? mNotas[1].trim() : null,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-LINE HEURISTIC
// ═══════════════════════════════════════════════════════════════════════════════

export function looksMultiLineDoc(input: string): boolean {
  const matches = input.match(/\d+(?:[.,]\d{1,2})?\s*€/g)
  return (matches?.length ?? 0) >= 2
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 2 — VALIDACIÓN DETERMINISTA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Valida líneas extraídas y calcula totales DETERMINÍSTICAMENTE.
 * Total = Σ (cantidad × precio_unitario) por línea — NUNCA LLM.
 */
export function validateDocLines(lineas: ExtractedDocLine[]): DocValidationResult {
  const warnings: string[] = []
  const validated: ValidatedDocLine[] = []

  for (const l of lineas) {
    // cantidad > 0 (CHECK constraint en BD)
    const cantidad = l.cantidad ?? 1
    if (cantidad <= 0) {
      warnings.push(`⚠️ Cantidad ≤ 0 para "${l.concepto}" — omitida`)
      continue
    }

    // precio_unitario >= 0 (CHECK constraint en BD)
    if (l.precio_unitario === null || l.precio_unitario === undefined) {
      warnings.push(`⚠️ Sin precio para "${l.concepto}" — necesito el importe`)
      continue
    }
    if (l.precio_unitario < 0) {
      warnings.push(`⚠️ Precio negativo para "${l.concepto}" — omitida`)
      continue
    }

    // concepto no vacío
    if (!l.concepto || l.concepto.trim().length === 0) {
      warnings.push('⚠️ Línea sin concepto — omitida')
      continue
    }

    // Subtotal calculado en código — NUNCA LLM
    const subtotal = Math.round(cantidad * l.precio_unitario * 100) / 100

    validated.push({
      concepto: l.concepto.trim(),
      cantidad,
      precio_unitario: l.precio_unitario,
      subtotal,
    })
  }

  // Total calculado en código
  const total = Math.round(validated.reduce((s, l) => s + l.subtotal, 0) * 100) / 100

  return { lineas: validated, total, warnings }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 3 — PREVIEW
// ═══════════════════════════════════════════════════════════════════════════════

function formatEur(n: number): string {
  return `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

export function buildDocPreview(
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
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId } = input
  const userInput = (input.text || '').trim()
  const supabase = getSupabase()

  // ── CAPA 1: Extracción ────────────────────────────────────────────────────
  let extracted = await extractDocWithLLM(userInput)

  if (!extracted) {
    // Multi-línea sin LLM → rechazar (misma regla que Facturador)
    if (looksMultiLineDoc(userInput)) {
      return {
        replyText: '⚠️ No pude procesar el documento completo. Parece que tiene varias líneas.\n\n' +
          'Repítelo así: "albarán para López, 3 cajas a 50€, instalación 200€"\n' +
          'O simplifica y lo proceso con el extractor inteligente.',
      }
    }
    extracted = extractDocWithRegex(userInput)
  }

  // ¿Hay cliente?
  if (!extracted.cliente) {
    const label = extracted.type === 'presupuesto' ? 'presupuesto' : 'albarán'
    return { needsInfo: `¿Para qué cliente es el ${label}? Ej: "albarán para García 3 cajas a 50€"` }
  }

  // ¿Hay al menos una línea con concepto?
  if (!extracted.lineas.length || !extracted.lineas[0].concepto) {
    return { needsInfo: `¿Qué incluye el ${extracted.type === 'presupuesto' ? 'presupuesto' : 'albarán'}? Ej: "3 cajas a 50€"` }
  }

  // ── CAPA 2: Validación determinista ───────────────────────────────────────
  const validation = validateDocLines(extracted.lineas)

  // ¿Hay líneas sin precio?
  if (validation.lineas.length === 0) {
    const conceptos = extracted.lineas.map(l => l.concepto).join(', ')
    return { needsInfo: `¿Por qué importe? (${conceptos}) Ej: "50€ por unidad"` }
  }

  // ── CAPA 0: Buscar cliente en BD (vía módulo compartido) ──────────────────
  const { data: clientes } = await supabase
    .from('clients')
    .select('id, name, email, phone')
    .eq('salon_id', tenantId)
    .ilike('name', `%${extracted.cliente}%`)
    .limit(3)

  if (!clientes?.length) {
    return {
      needsInfo: `No encontré al cliente "${extracted.cliente}". ¿Lo creamos? Di "nuevo cliente ${extracted.cliente}".`,
    }
  }

  const cliente = clientes[0]

  // ── CAPA 3: Preview + Gate ────────────────────────────────────────────────
  const preview = buildDocPreview(
    extracted.type,
    cliente.name,
    validation,
    extracted.notas,
  )

  const actionType = extracted.type === 'presupuesto'
    ? 'crear_presupuesto'
    : 'crear_albaran'

  const params: Record<string, any> = {
    doc_type:       extracted.type,
    cliente_id:     cliente.id,
    cliente_nombre: cliente.name,
    lineas: validation.lineas.map(l => ({
      concepto:        l.concepto,
      cantidad:        l.cantidad,
      precio_unitario: l.precio_unitario,
      subtotal:        l.subtotal,
    })),
    total: validation.total,
    notas: extracted.notas,
    fecha: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
  }

  // CONFIRMATION GATE — enforced por código, no por prompt
  const card = await createPendingAction(actionType, params, tenantId, userId)

  return {
    replyText: preview,
    card,
    confianza: validation.warnings.length === 0 ? 'alta' : 'media',
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTOR — llamado desde confirmation.ts tras OK del usuario
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ejecuta la creación del documento en BD via RPC atómica.
 *
 * `create_document_atomic()` ejecuta TODO en una sola transacción PL/pgSQL:
 *  1. Verificar propiedad del salón (auth.uid())
 *  2. Generar número secuencial (next_doc_number + advisory lock)
 *  3. INSERT documents (cabecera)
 *  4. INSERT document_items (líneas)
 *
 * Si CUALQUIER paso falla → rollback automático. Cero documentos huérfanos,
 * cero huecos de numeración.
 */
export async function executeCrearDocumento(
  p: Record<string, any>,
  salonId: string,
  userId?: string
): Promise<{ ok: boolean; message: string }> {
  const supabase = getSupabase()
  const docType = p.doc_type as 'albaran' | 'presupuesto'
  const lineas = p.lineas || []

  // Total calculado en código (doble-check antes de enviar a BD)
  const total = Math.round(
    lineas.reduce((s: number, l: any) => s + (l.subtotal || l.cantidad * l.precio_unitario), 0) * 100
  ) / 100

  // Preparar líneas como JSONB para la RPC
  const linesJsonb = lineas.map((l: any) => ({
    concepto:        l.concepto,
    cantidad:        l.cantidad,
    precio_unitario: l.precio_unitario,
  }))

  // ── RPC atómica: una sola transacción ──────────────────────────────────────
  const { data, error } = await supabase.rpc('create_document_atomic', {
    p_salon_id:  salonId,
    p_type:      docType,
    p_client_id: p.cliente_id,
    p_notes:     p.notas || null,
    p_lines:     linesJsonb,
    p_user_id:   userId || null,
  })

  if (error) {
    // Errores específicos de la RPC
    if (error.message?.includes('UNAUTHORIZED')) {
      return { ok: false, message: '❌ No tienes permiso para crear documentos en este salón.' }
    }
    if (error.message?.includes('NO_LINES')) {
      return { ok: false, message: '❌ Se necesita al menos una línea en el documento.' }
    }
    return { ok: false, message: `Error al crear documento: ${error.message}` }
  }

  if (!data) {
    return { ok: false, message: 'Error: la BD no devolvió datos del documento creado.' }
  }

  const result = data as { id: string; doc_number: string; total: number; lines_count: number }
  const typeLabel = docType === 'presupuesto' ? 'Presupuesto' : 'Albarán'
  const typeEmoji = docType === 'presupuesto' ? '📋' : '📜'

  // Verificar que el total de BD coincide con el calculado en código
  const bdTotal = Number(result.total)
  if (Math.abs(bdTotal - total) > 0.01) {
    // Discrepancia: reportar pero no bloquear (el doc ya se creó)
    return {
      ok: true,
      message: `${typeEmoji} ${typeLabel} creado\n• Número: ${result.doc_number}\n• Cliente: ${p.cliente_nombre || '—'}\n• Líneas: ${result.lines_count}\n• Total: ${formatEur(bdTotal)}\n• Estado: borrador\n⚠️ Discrepancia de total: código=${formatEur(total)}, BD=${formatEur(bdTotal)}`,
    }
  }

  return {
    ok: true,
    message: `${typeEmoji} ${typeLabel} creado\n• Número: ${result.doc_number}\n• Cliente: ${p.cliente_nombre || '—'}\n• Líneas: ${result.lines_count}\n• Total: ${formatEur(total)}\n• Estado: borrador`,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const EscribanoDiablo: DiabloHandler = {
  meta: DIABLO_METAS.escribano,
  handle,
}

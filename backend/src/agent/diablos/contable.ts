/**
 * 📊 El Contable v2 — Los números son su religión.
 *
 * Arquitectura híbrida LLM + determinista (patrón Facturador v2):
 *   Capa 1: Extractor LLM (OpenRouter Hermes 3 70B, temp 0)
 *   Capa 1b: Fallback regex (gastos recurrentes, préstamos, nóminas)
 *   Capa 2: Validación determinista (importe, concepto, categoría, fecha)
 *   Capa 3: Preview + Confirmation Gate (INTOCABLE)
 *
 * Módulos importados:
 *   - TRANSACTION_TYPE  → income | expense (DB constraint exacto)
 *   - TRANSACTION_CATEGORIES → fuente única de verdad para categorías
 *   - parseSpanishAmount → "1.250,50€" → 1250.50
 *   - resolveDateRange  → "enero" → {start, end, label} (100% determinista)
 */

import { createPendingAction } from '../confirmation'
import { extractFromImage } from '../vision'
import { getSupabase } from './index'
import { DIABLO_METAS } from './metas'
import {
  TRANSACTION_TYPE,
  mapTypeToDB,
  suggestCategoryV2,
  normalizeCategory,
  isValidCategory,
  parseSpanishAmount,
  resolveDateRange,
  validateAmount,
  validateConcept,
  type TransactionType,
  type DateRange,
} from './transaction-categories'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './metas'
import type { AgentInput } from '../core'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ExtractedTransaction {
  type: 'income' | 'expense' | null
  amount: string | null      // String para preservar formato español
  concept: string | null
  category: string | null
  client_or_provider: string | null
  date_text: string | null   // "enero", "ayer", etc. — resuelto en Capa 2
}

// ── Gastos recurrentes map (intacto — ya robusto con \b) ────────────────────

const GASTO_MAP: Array<{re: RegExp; concepto: string; categoria: string; ejemploImporte: string}> = [
  { re: /alquiler\s+(?:del?\s+)?local|pago\s+(?:del?\s+)?local|renta\s+(?:del?\s+)?local/i, concepto: 'Alquiler local',    categoria: 'alquiler',      ejemploImporte: '800€'  },
  { re: /\bluz\b|electricidad|factura\s+(?:de\s+)?(?:la\s+)?luz|recibo\s+(?:de\s+)?(?:la\s+)?luz/i, concepto: 'Electricidad', categoria: 'suministros', ejemploImporte: '90€'   },
  { re: /\bagua\b|factura\s+(?:del?\s+)?agua|recibo\s+(?:del?\s+)?agua/i, concepto: 'Agua',              categoria: 'suministros',   ejemploImporte: '30€'   },
  { re: /\bgas\b|factura\s+(?:del?\s+)?gas|recibo\s+(?:del?\s+)?gas/i,   concepto: 'Gas',               categoria: 'suministros',   ejemploImporte: '60€'   },
  { re: /internet|wifi|fibra|banda\s+ancha|l[ií]nea\s+(?:de\s+)?internet/i, concepto: 'Internet',        categoria: 'suministros',   ejemploImporte: '45€'   },
  { re: /tel[eé]fono\s+(?:m[oó]vil|fijo|empresa)|m[oó]vil\s+(?:empresa|trabajo)/i, concepto: 'Teléfono empresa', categoria: 'comunicaciones', ejemploImporte: '30€' },
  { re: /\bdieta\b|dietas\b|comida\s+(?:de\s+)?(?:trabajo|empresa|negocio)|almuerzo\s+(?:de\s+)?(?:trabajo|negocio)|restaurante\s+(?:de\s+)?(?:trabajo|negocio)/i, concepto: 'Dieta', categoria: 'dietas', ejemploImporte: '25€' },
  { re: /material\s+(?:de\s+)?(?:oficina|trabajo|peluquer[ií]a|est[eé]tica)|papeler[ií]a|consumibles/i, concepto: 'Material', categoria: 'material', ejemploImporte: '50€' },
  { re: /limpieza|productos\s+(?:de\s+)?limpieza/i,                       concepto: 'Limpieza',          categoria: 'gastos_generales', ejemploImporte: '40€' },
  { re: /\bseguro\b(?!\s+(?:social|de\s+vida))|p[oó]liza/i,              concepto: 'Seguro',            categoria: 'seguros',       ejemploImporte: '120€'  },
  { re: /gestor[ií]a|asesor[ií]a|contabilidad|gestor\s+(?:de\s+)?(?:empresa|fiscal)/i, concepto: 'Gestoría', categoria: 'servicios_profesionales', ejemploImporte: '80€' },
  { re: /gasoil|gasolina|carburante|repostaje|combustible/i,              concepto: 'Combustible',       categoria: 'transporte',    ejemploImporte: '70€'   },
  { re: /peaje|aparcamiento|parking|estacionamiento/i,                    concepto: 'Aparcamiento/Peaje',categoria: 'transporte',    ejemploImporte: '15€'   },
  { re: /publicidad|marketing|redes\s+sociales\s+(?:de\s+)?(?:pago|empresa)|anuncio/i, concepto: 'Publicidad', categoria: 'marketing', ejemploImporte: '100€' },
  { re: /proveedor|compra\s+(?:de\s+)?producto|stock|mercanc[ií]a|género/i,           concepto: 'Compra proveedor',  categoria: 'proveedores',         ejemploImporte: '200€' },
  { re: /herramienta\s+digital|suscripci[oó]n\s+(?:de\s+)?(?:software|app|servicio)|software|saas|licencia/i, concepto: 'Herramienta digital', categoria: 'herramientas_digitales', ejemploImporte: '30€' },
  { re: /comisi[oó]n\s+banco|comisi[oó]n\s+bancaria|gasto\s+banco|mantenimiento\s+cuenta|cuota\s+(?:tarjeta|cuenta)|tpv|datafono/i, concepto: 'Comisión bancaria', categoria: 'bancos_comisiones', ejemploImporte: '15€' },
  { re: /impuesto|tasa\s+(?:municipal|local|ayuntamiento)|ibi\b|ibi\s+|basuras|licencia\s+(?:de\s+)?apertura/i, concepto: 'Impuesto/Tasa', categoria: 'impuestos_tasas', ejemploImporte: '150€' },
  { re: /reparaci[oó]n|averia|mantenimiento\s+(?:local|m[aá]quina|equipo)|fontanero|electricista|pintor|albañil/i, concepto: 'Reparación/Mantenimiento', categoria: 'mantenimiento', ejemploImporte: '120€' },
  { re: /formaci[oó]n|curso|taller|capacitaci[oó]n|master|training/i,                  concepto: 'Formación',         categoria: 'formacion',           ejemploImporte: '150€' },
]

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId } = input

  // ── Image (ticket photo) ──────────────────────────────────────────────────
  if (input.type === 'image') {
    return handleImageTicket(input)
  }

  const userInput = (input.text || '').trim()
  const intent = classification.intent

  // ── Income / Expense → LLM Capa 1 + Validación Capa 2 ───────────────────
  if (intent === 'create_income' || intent === 'create_expense') {
    return handleIncomeExpense(userInput, tenantId, userId, intent === 'create_income')
  }

  // ── Préstamos / adelantos ────────────────────────────────────────────────
  if (intent === 'prestamo') {
    return handlePrestamo(userInput, tenantId, userId)
  }

  // ── Nóminas / cuota autónomo ─────────────────────────────────────────────
  if (intent === 'nomina_cuota') {
    return handleNominaCuota(userInput, tenantId, userId)
  }

  // ── Gastos recurrentes ──────────────────────────────────────────────────
  if (intent === 'gasto_recurrente') {
    return handleGastoRecurrente(userInput, tenantId, userId)
  }

  // ── READ queries (con soporte de rango de fechas) ───────────────────────
  if (intent === 'query_balance' || intent === 'query_income' || intent === 'query_expense') {
    return handleQuery(userInput, tenantId, intent)
  }

  // Fallback
  return { replyText: 'Dime el importe y concepto. Ej: "gasté 80€ en material" o "cobré 300€ de García".' }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 1 — EXTRACTOR LLM
// ═══════════════════════════════════════════════════════════════════════════════

const EXTRACTION_PROMPT = `Eres un extractor de datos de transacciones financieras. Tu ÚNICO trabajo es extraer datos estructurados del mensaje del usuario.

REGLAS ABSOLUTAS:
- Responde SOLO con JSON válido, SIN markdown, SIN explicaciones
- Si un campo no está en el texto → null
- PROHIBIDO inventar datos. Solo extrae lo que el usuario dice explícitamente
- type DEBE ser exactamente "income" o "expense" (inglés, nunca español)
- amount: extrae el texto LITERAL del importe tal como lo escribe el usuario (ej: "1.250,50€", "80€")
- date_text: si el usuario menciona una fecha o periodo, extrae el texto literal (ej: "enero", "ayer", "semana pasada")
- category: infiere la categoría más probable del gasto/ingreso

Schema de respuesta:
{
  "type": "income" | "expense",
  "amount": string | null,
  "concept": string | null,
  "category": string | null,
  "client_or_provider": string | null,
  "date_text": string | null
}`

async function extractWithLLM(userInput: string): Promise<ExtractedTransaction | null> {
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
        max_tokens: 300,
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

    const parsed = JSON.parse(cleaned) as ExtractedTransaction

    if (!parsed || typeof parsed !== 'object') return null

    // Forzar type a DB values via mapTypeToDB
    if (parsed.type) {
      const mapped = mapTypeToDB(parsed.type)
      parsed.type = mapped as any
    }

    return parsed
  } catch {
    return null  // Fallback a regex
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 1b — FALLBACK REGEX (para income/expense)
// ═══════════════════════════════════════════════════════════════════════════════

function extractWithRegex(userInput: string, isIncome: boolean): ExtractedTransaction {
  // Amount — soporta formato español
  const mAmt = userInput.match(/(\d+(?:[.,]\d{1,3})?)\s*(?:€|eur\w*)/i)
    || userInput.match(/(?:de\s+|por\s+)(\d+(?:[.,]\d{1,3})?)\b/i)
  const amountText = mAmt ? mAmt[1] + '€' : null

  // Concept
  let concept: string | null = null
  const mConcepto = userInput.match(
    /(?:en|por|de)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][^,\n\d€]{2,60}?)(?:\s+\d|\s+de\s+|,|\s*$)/i
  )
  if (mConcepto) {
    concept = mConcepto[1].trim().replace(/^(?:el|la|los|las|un|una)\s+/i, '').trim()
  }

  // Client/Provider
  let person: string | null = null
  const mPerson = userInput.match(
    /(?:a|de|para|con)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,50}?)(?:\s+(?:por|de|,)|\s+\d|$)/i
  )
  if (mPerson) person = mPerson[1].trim()

  return {
    type: isIncome ? TRANSACTION_TYPE.INCOME : TRANSACTION_TYPE.EXPENSE,
    amount: amountText,
    concept,
    category: concept ? suggestCategoryV2(concept) : null,
    client_or_provider: person,
    date_text: null,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 2 — VALIDACIÓN DETERMINISTA
// ═══════════════════════════════════════════════════════════════════════════════

interface ValidatedTransaction {
  type: TransactionType
  amount: number
  concept: string
  category: string
  client_or_provider: string | null
  date: string | null        // ISO date string
  warnings: string[]
}

function validateTransaction(ext: ExtractedTransaction, isIncome: boolean): ValidatedTransaction | DiabloResponse {
  const warnings: string[] = []

  // 1. Type — DB constraint income|expense
  const type = mapTypeToDB(ext.type || '') || (isIncome ? TRANSACTION_TYPE.INCOME : TRANSACTION_TYPE.EXPENSE)

  // 2. Amount — Spanish number parsing
  const parsedAmount = ext.amount ? parseSpanishAmount(ext.amount) : null
  const amountCheck = validateAmount(parsedAmount)
  if (!amountCheck.valid) {
    return {
      needsInfo: amountCheck.error || (isIncome
        ? '¿Cuánto cobraste? Dime el importe. Ej: "cobré 150€ de Juan"'
        : '¿Cuánto gastaste? Dime el importe. Ej: "gasté 80€ en materiales"')
    }
  }
  if (amountCheck.warning) warnings.push(amountCheck.warning)

  // 3. Concept
  const conceptCheck = validateConcept(ext.concept)
  if (!conceptCheck.valid) {
    return {
      needsInfo: isIncome
        ? `¿De qué servicio son los ${amountCheck.amount.toFixed(2)}€? Ej: "corte", "color", "manicura"`
        : `¿En qué gastaste los ${amountCheck.amount.toFixed(2)}€? Ej: "tinte Wella", "alquiler", "electricidad"`
    }
  }

  // 4. Category — validate against TRANSACTION_CATEGORIES
  let category = ext.category ? normalizeCategory(ext.category) : suggestCategoryV2(ext.concept || '')
  if (!isValidCategory(category)) {
    category = suggestCategoryV2(ext.concept || '')
  }

  // 5. Date — deterministic resolution
  let dateStr: string | null = null
  if (ext.date_text) {
    const range = resolveDateRange(ext.date_text)
    if (range) dateStr = range.start
  }

  return {
    type,
    amount: amountCheck.amount,
    concept: ext.concept!.trim(),
    category,
    client_or_provider: ext.client_or_provider || null,
    date: dateStr,
    warnings,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INCOME / EXPENSE HANDLER (Capa 1 → 2 → 3)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleIncomeExpense(
  userInput: string, tenantId: string, userId: string | undefined, isIncome: boolean
): Promise<DiabloResponse> {

  // Capa 1: LLM extraction (fallback regex)
  let extracted = await extractWithLLM(userInput)
  if (!extracted || (!extracted.amount && !extracted.concept)) {
    extracted = extractWithRegex(userInput, isIncome)
  }

  // Capa 2: Validación determinista
  const validatedResult = validateTransaction(extracted, isIncome)
  if ('needsInfo' in validatedResult || 'replyText' in validatedResult) {
    return validatedResult as DiabloResponse
  }
  const validated = validatedResult as ValidatedTransaction

  // Capa 3: Confirmation Gate
  const actionType = validated.type === TRANSACTION_TYPE.INCOME ? 'registrar_ingreso' : 'registrar_gasto'
  const parameters = validated.type === TRANSACTION_TYPE.INCOME
    ? {
        importe:      validated.amount,
        concepto:     validated.concept,
        cliente:      validated.client_or_provider || undefined,
        categoria:    validated.category,
        iva_incluido: true,
        ...(validated.date ? { fecha: validated.date } : {}),
      }
    : {
        importe:          validated.amount,
        concepto:         validated.concept,
        proveedor:        validated.client_or_provider || undefined,
        es_gasto_empresa: true,
        categoria:        validated.category,
        ...(validated.date ? { fecha: validated.date } : {}),
      }

  // Warning de importe alto → incluir en preview
  let warningText = ''
  if (validated.warnings.length > 0) {
    warningText = validated.warnings.join('\n')
  }

  const card = await createPendingAction(actionType, parameters, tenantId, userId)
  if (warningText) {
    return { card, replyText: warningText }
  }
  return { card }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRÉSTAMO HANDLER (Capa 1b regex — ya robusto)
// ═══════════════════════════════════════════════════════════════════════════════

async function handlePrestamo(userInput: string, tenantId: string, userId: string | undefined): Promise<DiabloResponse> {
  const esDevolucion = /devuelve|me\s+devuelve|me\s+paga(?!\s+a)|cobr[eé]\s+el\s+pr[eé]stamo|reintegra|descont[oó]|descuent|ya\s+me\s+pag[oó]/i.test(userInput)
  const esGasto      = !esDevolucion
  const isAdelanto   = /adelanto|anticipo\s+(?:de\s+)?(?:n[oó]mina|sueldo)|anticipo\s+a\s/i.test(userInput)
  const isPrestamoBanco = /banco|hipoteca|cr[eé]dito|prestamista/i.test(userInput)

  // Amount — Spanish format aware
  const mImporte = userInput.match(/(\d+(?:[.,]\d{1,3})?)\s*(?:€|eur\w*)/i)
    || userInput.match(/(?:de\s+|por\s+)(\d+(?:[.,]\d{1,3})?)\b/i)
  const importe = mImporte ? parseSpanishAmount(mImporte[0]) || 0 : 0

  const mPersona = userInput.match(
    /(?:a|de|para|con)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,50}?)(?:\s+(?:de|por|un|una|el|la|con|,)|$)/i
  )
  const persona = mPersona ? mPersona[1].trim() : ''

  let conceptoBase: string
  if (isAdelanto) {
    conceptoBase = esDevolucion
      ? `Devolución adelanto nómina${persona ? ` - ${persona}` : ''}`
      : `Adelanto nómina${persona ? ` - ${persona}` : ''}`
  } else if (isPrestamoBanco) {
    conceptoBase = esDevolucion
      ? `Devolución préstamo${persona ? ` - ${persona}` : ''}`
      : `Cuota préstamo${persona ? ` - ${persona}` : ''}`
  } else {
    conceptoBase = esDevolucion
      ? `Devolución préstamo${persona ? ` - ${persona}` : ''}`
      : `Préstamo${persona ? ` - ${persona}` : ''}`
  }

  // Capa 2: Validación
  const amountCheck = validateAmount(importe)
  if (!amountCheck.valid) {
    const tipo = isAdelanto ? 'adelanto de nómina' : 'préstamo'
    return { needsInfo: amountCheck.error || `¿De qué importe es el ${tipo}${persona ? ` a ${persona}` : ''}? Ej: "500€"` }
  }

  const actionType = esGasto ? 'registrar_gasto' : 'registrar_ingreso'
  const params = esGasto
    ? { importe: amountCheck.amount, concepto: conceptoBase, es_gasto_empresa: true, categoria: 'personal' }
    : { importe: amountCheck.amount, concepto: conceptoBase, categoria: 'otros', iva_incluido: false }

  const card = await createPendingAction(actionType, params, tenantId, userId)
  return { card }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NÓMINA / CUOTA HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleNominaCuota(userInput: string, tenantId: string, userId: string | undefined): Promise<DiabloResponse> {
  // Amount — Spanish format
  const mImporte = userInput.match(/(\d+(?:[.,]\d{1,3})?)\s*(?:€|eur\w*)/i)
  const importe  = mImporte ? parseSpanishAmount(mImporte[0]) || 0 : 0

  const isNomina   = /n[oó]mina\s+de|pago\s+n[oó]mina/i.test(userInput)
  const isCuotaSS  = /cuota\s+aut[oó]nomo|cuota\s+reta|seguridad\s+social|cuota\s+ss\b/i.test(userInput)

  const mMes = userInput.match(/(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i)
  const mes  = mMes ? mMes[1] : ''

  const mPersona = userInput.match(
    /n[oó]mina\s+de\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s+(?:de|por|,)|$)/i
  )
  const persona = mPersona ? mPersona[1].trim() : ''

  let concepto: string
  if (isNomina) {
    concepto = `Nómina${persona ? ` - ${persona}` : ''}${mes ? ` (${mes})` : ''}`
  } else {
    concepto = `Cuota autónomo${mes ? ` ${mes}` : ''}`
  }

  // Capa 2: Validación
  const amountCheck = validateAmount(importe)
  if (!amountCheck.valid) {
    return { needsInfo: amountCheck.error || `¿De qué importe es ${isNomina ? 'la nómina' : 'la cuota'}? Ej: "${isNomina ? '1.200€' : '320€'}"` }
  }

  const card = await createPendingAction('registrar_gasto', {
    importe: amountCheck.amount,
    concepto,
    es_gasto_empresa: true,
    categoria: isCuotaSS ? 'impuestos' : 'nominas',
  }, tenantId, userId)
  return { card }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GASTO RECURRENTE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGastoRecurrente(userInput: string, tenantId: string, userId: string | undefined): Promise<DiabloResponse> {
  let matchedGasto: typeof GASTO_MAP[0] | null = null
  for (const g of GASTO_MAP) {
    if (g.re.test(userInput)) { matchedGasto = g; break }
  }

  if (!matchedGasto) {
    return { needsInfo: 'Dime el gasto y el importe. Ej: "alquiler 800€" o "luz 90€".' }
  }

  // Amount — Spanish format
  const mImp = userInput.match(/(\d+(?:[.,]\d{1,3})?)\s*(?:€|eur\w*)/i)
    || userInput.match(/(?:de\s+|por\s+|son\s+|ha\s+sido\s+)(\d+(?:[.,]\d{1,3})?)\b/i)
  const importe = mImp ? parseSpanishAmount(mImp[0]) || 0 : 0

  const mMes = userInput.match(/(?:de\s+|del?\s+mes\s+de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i)
  const mes = mMes ? mMes[1] : ''

  let concepto = matchedGasto.concepto
  if (mes) concepto += ` ${mes}`

  // Provider detection (mejorado — stop-words para evitar falsos positivos)
  const proveedorPatterns = [
    /(?:de\s+|con\s+|a\s+|proveedor\s+)([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ\s&.,]{2,25})(?:\s+(?:son|es|de|por|a)|\s*$)/,
    /([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ]{2,}\s*(?:S\.?L\.?|S\.?A\.?|S\.?L\.?U\.?)?)/,
  ]
  const stopWordsProveedor = new Set([
    'alquiler','electricidad','internet','limpieza','seguro','material','gasolina','gestoría',
    'formación','reparación','comisión','publicidad','dieta','agua','gas','enero','febrero',
    'marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre',
    'este','pasado','anterior','próximo','total','importe','recibo','factura','pago',
  ])
  for (const pr of proveedorPatterns) {
    const mProv = userInput.match(pr)
    if (mProv && !concepto.includes(mProv[1].trim())) {
      const nombre = mProv[1].trim()
      if (!stopWordsProveedor.has(nombre.toLowerCase())) {
        concepto += ` - ${nombre}`
      }
      break
    }
  }

  if (matchedGasto.categoria === 'dietas') {
    const mDesc = userInput.match(/(?:en\s+|de\s+)([A-Za-záéíóúñÁÉÍÓÚÑ\s]{3,30})$/i)
    if (mDesc) concepto += ` - ${mDesc[1].trim()}`
  }

  // Capa 2: Validación
  const amountCheck = validateAmount(importe)
  if (!amountCheck.valid) {
    return { needsInfo: amountCheck.error || `¿De qué importe es ${matchedGasto.concepto.toLowerCase()}? Ej: "${matchedGasto.ejemploImporte}"` }
  }

  // Categoría validada contra TRANSACTION_CATEGORIES
  const categoria = normalizeCategory(matchedGasto.categoria)

  const card = await createPendingAction('registrar_gasto', {
    importe: amountCheck.amount,
    concepto,
    es_gasto_empresa: true,
    categoria,
  }, tenantId, userId)
  return { card }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE TICKET HANDLER (Capa 2: cross-check + campos_dudosos → confirmación)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleImageTicket(input: AgentInput): Promise<DiabloResponse> {
  const { tenantId, userId } = input
  const base64 = input.imageBase64 || ''
  const mime   = input.imageMime   || 'image/jpeg'

  if (!base64) return { needsInfo: 'No recibí imagen. Inténtalo de nuevo.' }
  if (base64.length > 7_000_000) {
    return { needsInfo: 'La imagen es demasiado grande. Hazla más pequeña e inténtalo de nuevo.' }
  }

  const extracted = await extractFromImage(base64, mime)

  if (extracted.campos_dudosos.includes('multiple_tickets')) {
    return { needsInfo: 'Veo varios tickets en la foto. Manda uno por foto para registrarlos correctamente.' }
  }
  if (extracted.campos_dudosos.includes('moneda_extranjera')) {
    return { needsInfo: 'El ticket parece estar en otra moneda. ¿Me confirmas el importe en euros y el concepto?' }
  }

  // Capa 2: Cross-check — si hay campos dudosos, pedir confirmación manual
  if (extracted.confianza === 'baja' || extracted.importe === null) {
    let msg = 'No consigo leer bien el ticket.'
    if (extracted.importe  === null) msg += ' ¿Cuánto es el importe total?'
    if (extracted.concepto === null) msg += ' ¿Y de qué es el gasto?'
    msg += '\n\nO dímelo directamente: "gasté 45€ en material"'
    return { needsInfo: msg.trim() }
  }

  // Capa 2: Validación de importe OCR
  const amountCheck = validateAmount(extracted.importe)
  if (!amountCheck.valid) {
    return { needsInfo: amountCheck.error || 'No pude leer el importe del ticket. ¿Cuánto es?' }
  }

  // Si hay campos dudosos pero confianza media → incluir aviso
  const hasDubious = extracted.campos_dudosos.length > 0
  const dubiousWarning = hasDubious
    ? `⚠️ He leído el ticket pero tengo dudas en: ${extracted.campos_dudosos.join(', ')}. Revisa los datos antes de confirmar.`
    : ''

  // Type mapping — usar TRANSACTION_TYPE
  const txType = extracted.tipo === 'ingreso' ? TRANSACTION_TYPE.INCOME : TRANSACTION_TYPE.EXPENSE
  const actionType  = txType === TRANSACTION_TYPE.INCOME ? 'registrar_ingreso' : 'registrar_gasto'
  const todayStr    = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' })

  // Categoría validada
  const categoria = normalizeCategory(
    extracted.categoria || suggestCategoryV2(extracted.concepto || '')
  )

  const parameters = txType === TRANSACTION_TYPE.INCOME
    ? {
        importe:        amountCheck.amount,
        concepto:       extracted.concepto  || 'Ingreso de ticket',
        cliente:        extracted.proveedor || undefined,
        categoria,
        fecha:          extracted.fecha     || todayStr,
        source:         'photo',
        campos_dudosos: extracted.campos_dudosos,
      }
    : {
        importe:          amountCheck.amount,
        concepto:         extracted.concepto  || 'Gasto de ticket',
        proveedor:        extracted.proveedor || undefined,
        es_gasto_empresa: true,
        categoria,
        fecha:            extracted.fecha     || todayStr,
        source:           'photo',
        campos_dudosos:   extracted.campos_dudosos,
      }

  const card = await createPendingAction(actionType, parameters, tenantId, userId)
  const response: DiabloResponse = { card, source: 'photo', camposDudosos: extracted.campos_dudosos, confianza: extracted.confianza }
  if (dubiousWarning) response.replyText = dubiousWarning
  return response
}

// ═══════════════════════════════════════════════════════════════════════════════
// READ QUERIES — DRY + rango de fechas
// ═══════════════════════════════════════════════════════════════════════════════

interface TransactionQuery {
  salonId: string
  type?: TransactionType
  dateRange: DateRange
}

function extractDateRangeFromInput(userInput: string): DateRange {
  // Try to find date text in user input
  const datePatterns = [
    /(?:de|en|del?)\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(?:de\s+)?(\d{4}))?/i,
    /(este\s+mes|mes\s+pasado|mes\s+anterior|este\s+trimestre|[uú]ltimo\s+trimestre|trimestre\s+pasado|trimestre\s+anterior|este\s+a[ñn]o|a[ñn]o\s+pasado|a[ñn]o\s+anterior)/i,
  ]

  for (const pat of datePatterns) {
    const match = userInput.match(pat)
    if (match) {
      const text = match[2] ? `${match[1]} ${match[2]}` : match[1]
      const range = resolveDateRange(text)
      if (range) return range
    }
  }

  // Default: este mes
  return resolveDateRange('este mes')!
}

async function fetchTransactions(
  salonId: string, type: TransactionType | null, dateRange: DateRange
): Promise<{ data: any[] | null; error: any }> {
  let query = getSupabase()
    .from('transactions')
    .select('amount, type, description, created_at')
    .eq('salon_id', salonId)
    .gte('created_at', `${dateRange.start}T00:00:00`)
    .lte('created_at', `${dateRange.end}T23:59:59`)

  if (type) query = query.eq('type', type)

  return query
}

async function handleQuery(
  userInput: string, tenantId: string, intent: string
): Promise<DiabloResponse> {
  const dateRange = extractDateRangeFromInput(userInput)

  try {
    if (intent === 'query_balance') {
      const { data: txns } = await fetchTransactions(tenantId, null, dateRange)
      if (!txns?.length) return { replyText: `No hay transacciones en ${dateRange.label}.` }
      let income = 0, expenses = 0
      for (const t of txns) {
        if (t.type === TRANSACTION_TYPE.INCOME) income += t.amount || 0
        else expenses += t.amount || 0
      }
      return {
        replyText: `📊 Balance ${dateRange.label}:\n` +
          `Ingresos: ${income.toFixed(2)}€\n` +
          `Gastos: ${expenses.toFixed(2)}€\n` +
          `Neto: ${(income - expenses).toFixed(2)}€`
      }
    }

    if (intent === 'query_income') {
      const { data: txns } = await fetchTransactions(tenantId, TRANSACTION_TYPE.INCOME, dateRange)
      if (!txns?.length) return { replyText: `No hay ingresos en ${dateRange.label}.` }
      const total = txns.reduce((s: number, t: any) => s + (t.amount || 0), 0)
      return { replyText: `💰 Ingresos ${dateRange.label}: ${total.toFixed(2)}€ (${txns.length} registros)` }
    }

    if (intent === 'query_expense') {
      const { data: txns } = await fetchTransactions(tenantId, TRANSACTION_TYPE.EXPENSE, dateRange)
      if (!txns?.length) return { replyText: `No hay gastos en ${dateRange.label}.` }
      const total = txns.reduce((s: number, t: any) => s + (t.amount || 0), 0)
      return { replyText: `💸 Gastos ${dateRange.label}: ${total.toFixed(2)}€ (${txns.length} registros)` }
    }
  } catch {
    return { replyText: 'No se pudo consultar las transacciones.' }
  }

  return { replyText: 'No se pudo consultar las transacciones.' }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const ContableDiablo: DiabloHandler = {
  meta: DIABLO_METAS.contable,
  handle,
}

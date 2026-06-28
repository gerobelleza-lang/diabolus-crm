/**
 * 📊 El Contable — Los números son su religión.
 *
 * Maneja: ingresos, gastos, gastos recurrentes, préstamos,
 * nóminas, cuota autónomo, balance, fotos de tickets.
 */

import { createPendingAction } from '../confirmation'
import { suggestCategory } from '../tools'
import { extractFromImage } from '../vision'
import { getSupabase, DIABLO_METAS } from './index'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'

// ── Gastos recurrentes map ──────────────────────────────────────────────────

const GASTO_MAP: Array<{re: RegExp; concepto: string; categoria: string; ejemploImporte: string}> = [
  { re: /alquiler\s+(?:del?\s+)?local|pago\s+(?:del?\s+)?local|renta\s+(?:del?\s+)?local/i, concepto: 'Alquiler local',    categoria: 'alquiler',      ejemploImporte: '800€'  },
  { re: /\bluz\b|electricidad|factura\s+(?:de\s+)?(?:la\s+)?luz|recibo\s+(?:de\s+)?(?:la\s+)?luz/i, concepto: 'Electricidad', categoria: 'suministros', ejemploImporte: '90€'   },
  { re: /\bagua\b|factura\s+(?:del?\s+)?agua|recibo\s+(?:del?\s+)?agua/i, concepto: 'Agua',              categoria: 'suministros',   ejemploImporte: '30€'   },
  { re: /\bgas\b|factura\s+(?:del?\s+)?gas|recibo\s+(?:del?\s+)?gas/i,   concepto: 'Gas',               categoria: 'suministros',   ejemploImporte: '60€'   },
  { re: /internet|wifi|fibra|banda\s+ancha|l[ií]nea\s+(?:de\s+)?internet/i, concepto: 'Internet',        categoria: 'suministros',   ejemploImporte: '45€'   },
  { re: /tel[eé]fono\s+(?:m[oó]vil|fijo|empresa)|m[oó]vil\s+(?:empresa|trabajo)/i, concepto: 'Teléfono empresa', categoria: 'suministros', ejemploImporte: '30€' },
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

// ── Handler ─────────────────────────────────────────────────────────────────

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId } = input

  // ── Image (ticket photo) ──────────────────────────────────────────────────
  if (input.type === 'image') {
    return handleImageTicket(input)
  }

  const userInput = (input.text || '').trim()
  const intent = classification.intent

  // ── Income / Expense (from parser) ────────────────────────────────────────
  if (intent === 'create_income' || intent === 'create_expense') {
    return handleIncomeExpense(userInput, tenantId, userId, intent === 'create_income')
  }

  // ── Préstamos / adelantos ─────────────────────────────────────────────────
  if (intent === 'prestamo') {
    return handlePrestamo(userInput, tenantId, userId)
  }

  // ── Nóminas / cuota autónomo ──────────────────────────────────────────────
  if (intent === 'nomina_cuota') {
    return handleNominaCuota(userInput, tenantId, userId)
  }

  // ── Gastos recurrentes ────────────────────────────────────────────────────
  if (intent === 'gasto_recurrente') {
    return handleGastoRecurrente(userInput, tenantId, userId)
  }

  // ── READ: balance, income, expenses ───────────────────────────────────────
  if (intent === 'query_balance') return { replyText: await fetchBalance(tenantId) }
  if (intent === 'query_income')  return { replyText: await fetchIncome(tenantId) }
  if (intent === 'query_expense') return { replyText: await fetchExpenses(tenantId) }

  // Fallback
  return { replyText: 'Dime el importe y concepto. Ej: "gasté 80€ en material" o "cobré 300€ de García".' }
}

// ── Income/Expense handler ──────────────────────────────────────────────────

async function handleIncomeExpense(
  userInput: string, tenantId: string, userId: string | undefined, isIncome: boolean
): Promise<DiabloResponse> {
  const { parseUserInput } = await import('../parser')
  const parsed = parseUserInput(userInput)

  if (!parsed.data.amount || parsed.data.amount <= 0) {
    return { needsInfo: isIncome
      ? '¿Cuánto cobraste? Dime el importe. Ej: "cobré 150€ de Juan"'
      : '¿Cuánto gastaste? Dime el importe. Ej: "gasté 80€ en materiales"'
    }
  }

  if (!parsed.data.concept) {
    return { needsInfo: isIncome
      ? `¿De qué servicio son los ${parsed.data.amount}€? Ej: "corte", "color", "manicura". ¿El importe lleva IVA incluido?`
      : `¿En qué gastaste los ${parsed.data.amount}€? Ej: "tinte Wella", "alquiler", "electricidad"`
    }
  }

  const actionType  = isIncome ? 'registrar_ingreso' : 'registrar_gasto'
  const parameters  = isIncome
    ? {
        importe:      parsed.data.amount,
        concepto:     parsed.data.concept,
        cliente:      parsed.data.clientName !== 'Cliente' ? parsed.data.clientName : undefined,
        categoria:    'servicios',
        iva_incluido: true,
      }
    : {
        importe:          parsed.data.amount,
        concepto:         parsed.data.concept,
        es_gasto_empresa: true,
        categoria:        suggestCategory(parsed.data.concept || ''),
      }

  const card = await createPendingAction(actionType, parameters, tenantId, userId)
  return { card }
}

// ── Préstamo handler ────────────────────────────────────────────────────────

async function handlePrestamo(userInput: string, tenantId: string, userId: string | undefined): Promise<DiabloResponse> {
  const esDevolucion = /devuelve|me\s+devuelve|me\s+paga(?!\s+a)|cobr[eé]\s+el\s+pr[eé]stamo|reintegra|descont[oó]|descuent|ya\s+me\s+pag[oó]/i.test(userInput)
  const esGasto      = !esDevolucion
  const isAdelanto   = /adelanto|anticipo\s+(?:de\s+)?(?:n[oó]mina|sueldo)|anticipo\s+a\s/i.test(userInput)
  const isPrestamoBanco = /banco|hipoteca|cr[eé]dito|prestamista/i.test(userInput)

  const mImporte = userInput.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur\w*)/i)
    || userInput.match(/(?:de\s+|por\s+)(\d+(?:[.,]\d{1,2})?)\b/i)
  const importe = mImporte ? parseFloat(mImporte[1].replace(',', '.')) : 0

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

  if (!importe || importe <= 0) {
    const tipo = isAdelanto ? 'adelanto de nómina' : 'préstamo'
    return { needsInfo: `¿De qué importe es el ${tipo}${persona ? ` a ${persona}` : ''}? Ej: "500€"` }
  }

  const actionType = esGasto ? 'registrar_gasto' : 'registrar_ingreso'
  const params = esGasto
    ? { importe, concepto: conceptoBase, es_gasto_empresa: true, categoria: 'personal' }
    : { importe, concepto: conceptoBase, categoria: 'otros', iva_incluido: false }

  const card = await createPendingAction(actionType, params, tenantId, userId)
  return { card }
}

// ── Nómina / Cuota autónomo handler ─────────────────────────────────────────

async function handleNominaCuota(userInput: string, tenantId: string, userId: string | undefined): Promise<DiabloResponse> {
  const mImporte = userInput.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur\w*)/i)
  const importe  = mImporte ? parseFloat(mImporte[1].replace(',', '.')) : 0

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

  if (!importe || importe <= 0) {
    return { needsInfo: `¿De qué importe es ${isNomina ? 'la nómina' : 'la cuota'}? Ej: "${isNomina ? '1.200€' : '320€'}"` }
  }

  const card = await createPendingAction('registrar_gasto', {
    importe,
    concepto,
    es_gasto_empresa: true,
    categoria: isCuotaSS ? 'impuestos' : 'nominas',
  }, tenantId, userId)
  return { card }
}

// ── Gasto recurrente handler ────────────────────────────────────────────────

async function handleGastoRecurrente(userInput: string, tenantId: string, userId: string | undefined): Promise<DiabloResponse> {
  let matchedGasto: typeof GASTO_MAP[0] | null = null
  for (const g of GASTO_MAP) {
    if (g.re.test(userInput)) { matchedGasto = g; break }
  }

  if (!matchedGasto) {
    return { needsInfo: 'Dime el gasto y el importe. Ej: "alquiler 800€" o "luz 90€".' }
  }

  const mImp = userInput.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur\w*)/i)
    || userInput.match(/(?:de\s+|por\s+|son\s+|ha\s+sido\s+)(\d+(?:[.,]\d{1,2})?)\b/i)
  const importe = mImp ? parseFloat(mImp[1].replace(',', '.')) : 0

  const mMes = userInput.match(/(?:de\s+|del?\s+mes\s+de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i)
  const mes = mMes ? mMes[1] : ''

  let concepto = matchedGasto.concepto
  if (mes) concepto += ` ${mes}`

  const proveedorPatterns = [
    /(?:de\s+|con\s+|a\s+|proveedor\s+)([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ\s&.,]{2,25})(?:\s+(?:son|es|de|por|a)|\s*$)/,
    /([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ]{2,}\s*(?:S\.?L\.?|S\.?A\.?|S\.?L\.?U\.?)?)/,
  ]
  for (const pr of proveedorPatterns) {
    const mProv = userInput.match(pr)
    if (mProv && !concepto.includes(mProv[1].trim())) {
      const nombre = mProv[1].trim()
      const stopWords = ['Alquiler','Electricidad','Internet','Limpieza','Seguro','Material','Gasolina','Gestoría','Formación','Reparación','Comisión','Publicidad','Dieta','Agua','Gas']
      if (!stopWords.some(sw => nombre.toLowerCase().startsWith(sw.toLowerCase()))) {
        concepto += ` - ${nombre}`
      }
      break
    }
  }

  if (matchedGasto.categoria === 'dietas') {
    const mDesc = userInput.match(/(?:en\s+|de\s+)([A-Za-záéíóúñÁÉÍÓÚÑ\s]{3,30})$/i)
    if (mDesc) concepto += ` - ${mDesc[1].trim()}`
  }

  if (!importe || importe <= 0) {
    return { needsInfo: `¿De qué importe es ${matchedGasto.concepto.toLowerCase()}? Ej: "${matchedGasto.ejemploImporte}"` }
  }

  const card = await createPendingAction('registrar_gasto', {
    importe,
    concepto,
    es_gasto_empresa: true,
    categoria: matchedGasto.categoria,
  }, tenantId, userId)
  return { card }
}

// ── Image ticket handler ────────────────────────────────────────────────────

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
  if (extracted.confianza === 'baja' || extracted.importe === null) {
    let msg = 'No consigo leer bien el ticket.'
    if (extracted.importe  === null) msg += ' ¿Cuánto es el importe total?'
    if (extracted.concepto === null) msg += ' ¿Y de qué es el gasto?'
    msg += '\n\nO dímelo directamente: "gasté 45€ en material"'
    return { needsInfo: msg.trim() }
  }

  const actionType  = extracted.tipo === 'ingreso' ? 'registrar_ingreso' : 'registrar_gasto'
  const todayStr    = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' })
  const parameters  = extracted.tipo === 'ingreso'
    ? {
        importe:        extracted.importe,
        concepto:       extracted.concepto  || 'Ingreso de ticket',
        cliente:        extracted.proveedor || undefined,
        categoria:      extracted.categoria || 'servicios',
        fecha:          extracted.fecha     || todayStr,
        source:         'photo',
        campos_dudosos: extracted.campos_dudosos,
      }
    : {
        importe:          extracted.importe,
        concepto:         extracted.concepto  || 'Gasto de ticket',
        proveedor:        extracted.proveedor || undefined,
        es_gasto_empresa: true,
        categoria:        extracted.categoria || suggestCategory(extracted.concepto || ''),
        fecha:            extracted.fecha     || todayStr,
        source:           'photo',
        campos_dudosos:   extracted.campos_dudosos,
      }

  const card = await createPendingAction(actionType, parameters, tenantId, userId)
  return { card, source: 'photo', camposDudosos: extracted.campos_dudosos, confianza: extracted.confianza }
}

// ── READ fetchers ───────────────────────────────────────────────────────────

async function fetchBalance(salonId: string): Promise<string> {
  try {
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await getSupabase()
      .from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', startOfMonth)
    if (!txns?.length) return 'No hay transacciones registradas este mes.'
    let income = 0, expenses = 0
    for (const t of txns) { if (t.type === 'income') income += t.amount || 0; else expenses += t.amount || 0 }
    return `Balance este mes: Ingresos EUR ${income.toFixed(2)} | Gastos EUR ${expenses.toFixed(2)} | Neto EUR ${(income - expenses).toFixed(2)}`
  } catch { return 'No se pudo consultar el balance.' }
}

async function fetchIncome(salonId: string): Promise<string> {
  try {
    const now          = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await getSupabase()
      .from('transactions').select('amount').eq('salon_id', salonId).eq('type', 'income').gte('created_at', startOfMonth)
    if (!txns?.length) return 'No hay ingresos registrados este mes.'
    const total = txns.reduce((s: number, t: any) => s + (t.amount || 0), 0)
    return `Ingresos este mes: EUR ${total.toFixed(2)} (${txns.length} registros)`
  } catch { return 'No se pudo consultar los ingresos.' }
}

async function fetchExpenses(salonId: string): Promise<string> {
  try {
    const now          = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await getSupabase()
      .from('transactions').select('amount').eq('salon_id', salonId).eq('type', 'expense').gte('created_at', startOfMonth)
    if (!txns?.length) return 'No hay gastos registrados este mes.'
    const total = txns.reduce((s: number, t: any) => s + (t.amount || 0), 0)
    return `Gastos este mes: EUR ${total.toFixed(2)} (${txns.length} registros)`
  } catch { return 'No se pudo consultar los gastos.' }
}

// ── Export ───────────────────────────────────────────────────────────────────

export const ContableDiablo: DiabloHandler = {
  meta: DIABLO_METAS.contable,
  handle,
}

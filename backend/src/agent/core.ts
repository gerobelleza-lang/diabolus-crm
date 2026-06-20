// @ts-nocheck
/**
 * core.ts — Núcleo agéntico channel-agnostic (Bloque A, Rebanada 4)
 *
 * Recibe AgentInput normalizado → devuelve AgentOutput normalizado.
 * No sabe de qué canal viene (web / telegram / whatsapp).
 *
 * Flujo:
 *  action_response → executePendingAction | cancelPendingAction
 *  image           → vision.ts → gate → card
 *  text            → parser → intent routing → gate (writes) | DB read (queries)
 *
 * PRINCIPIO: nunca escribe ni envía sin confirmación explícita.
 */

import { parseUserInput }                                          from './parser'
import { routeToLLM, callOpenRouter, DIABOLUS_SYSTEM_PROMPT }     from './llm-router'
import { createClient }                                            from '@supabase/supabase-js'
import { createPendingAction, executePendingAction, cancelPendingAction } from './confirmation'
import type { ConfirmationCard }                                   from './confirmation'
import { suggestCategory }                                         from './tools'
import { extractFromImage }                                        from './vision'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentInput {
  tenantId:     string
  channel:      'web' | 'telegram' | 'whatsapp'
  type:         'text' | 'image' | 'action_response'
  text?:        string
  imageBase64?: string
  imageMime?:   string
  actionResponse?: {
    pendingActionId: string
    decision:        'confirm' | 'cancel'
  }
  userId?: string
}

export interface AgentOutput {
  replyText?:     string
  card?:          ConfirmationCard
  needsInfo?:     string
  source?:        'photo' | 'text'
  camposDudosos?: string[]
  confianza?:     'alta' | 'media' | 'baja'
  routing?:       { level: string; model: string; estimatedCost: string }
}

// ─── Supabase ────────────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!
  )
}

// ─── Channel link helpers (seguridad: externo → tenant) ──────────────────────

/**
 * Resuelve el salon_id a partir de (channel, external_id).
 * Devuelve null si no hay enlace verificado → el adaptador rechaza la petición.
 */
export async function resolveTenant(
  channel: 'telegram' | 'whatsapp',
  externalId: string
): Promise<string | null> {
  const supabase = getSupabase()
  const { data } = await supabase
    .from('channel_links')
    .select('salon_id')
    .eq('channel', channel)
    .eq('external_id', externalId)
    .single()
  return data?.salon_id ?? null
}

/**
 * Guarda el último pending_action_id para capturar SÍ/NO de WhatsApp.
 */
export async function storeLastPending(
  channel: string,
  externalId: string,
  pendingActionId: string
): Promise<void> {
  const supabase = getSupabase()
  await supabase
    .from('channel_links')
    .update({ last_pending_action_id: pendingActionId })
    .eq('channel', channel)
    .eq('external_id', externalId)
}

/**
 * Recupera el último pending_action_id para un canal/usuario.
 */
export async function getLastPending(
  channel: string,
  externalId: string
): Promise<string | null> {
  const supabase = getSupabase()
  const { data } = await supabase
    .from('channel_links')
    .select('last_pending_action_id')
    .eq('channel', channel)
    .eq('external_id', externalId)
    .single()
  return data?.last_pending_action_id ?? null
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function processAgentInput(input: AgentInput): Promise<AgentOutput> {
  const { tenantId, type, userId } = input

  // ── 1. Confirm / Cancel ────────────────────────────────────────────────────
  if (type === 'action_response') {
    const { pendingActionId, decision } = input.actionResponse!
    if (decision === 'confirm') {
      const result = await executePendingAction(pendingActionId)
      return { replyText: result.message }
    } else {
      await cancelPendingAction(pendingActionId)
      return { replyText: '❌ Acción cancelada. No se ha guardado nada.' }
    }
  }

  // ── 2. Imagen (foto de ticket) ─────────────────────────────────────────────
  if (type === 'image') {
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

  // ── 3. Texto ───────────────────────────────────────────────────────────────
  const userInput = (input.text || '').trim()
  if (!userInput) return { needsInfo: '¿Qué necesitas? Escribe /ayuda para ver los comandos.' }

  // ── Saludos y ayuda ──────────────────────────────────────────────────────
  if (/^(hola|hey|buenas|buenos días|buenas tardes|buenas noches|ey|hi|hello|qué hay|qué tal|holi|ola|buenas!|hola!|hey!)\s*[!?]?$/i.test(userInput)) {
    return { replyText: '¡Hola! 👋 Soy tu asistente de Diabolus. Puedo ayudarte a:\n\n• Registrar cobros y gastos\n• Crear facturas y clientes\n• Consultar tu balance\n• Ver quién te debe dinero\n\nDime qué necesitas o escribe /ayuda para más opciones.' }
  }
  if (/^(ayuda|help|comandos|opciones|qué puedes hacer|para qué sirves|cómo funciona)\s*[?]?$/i.test(userInput)) {
    return {
      replyText: [
        '📋 Comandos disponibles:',
        '',
        '💰 *Finanzas*',
        '• "cobré 150€ de Ana" → registra ingreso',
        '• "gasté 80€ en material" → registra gasto',
        '',
        '📄 *Facturas*',
        '• "crea factura para Ana por 150€"',
        '• "la factura de Ana está pagada"',
        '• "manda recordatorio a Ana"',
        '',
        '👥 *Clientes*',
        '• "nuevo cliente Ana García tel 612345678"',
        '',
        '📊 *Consultas*',
        '• "¿cuánto tengo?" → balance del mes',
        '• "¿quién me debe?" → cobros pendientes',
        '• "facturas vencidas"',
        '',
        '📷 También puedes *enviar una foto* de ticket o factura.',
      ].join('\n')
    }
  }

  const supabase = getSupabase()
  const parsed   = parseUserInput(userInput)

  // ── registrar_gasto / registrar_ingreso ─────────────────────────────────
  if (parsed.intent === 'create_income' || parsed.intent === 'create_expense') {
    const isIncome = parsed.intent === 'create_income'

    if (!parsed.data.amount || parsed.data.amount <= 0) {
      return { needsInfo: isIncome
        ? '¿Cuánto cobraste? Dime el importe. Ej: "cobré 150€ de Juan"'
        : '¿Cuánto gastaste? Dime el importe. Ej: "gasté 80€ en materiales"'
      }
    }

    const actionType  = isIncome ? 'registrar_ingreso' : 'registrar_gasto'
    const parameters  = isIncome
      ? {
          importe:   parsed.data.amount,
          concepto:  parsed.data.concept || 'Servicio',
          cliente:   parsed.data.clientName !== 'Cliente' ? parsed.data.clientName : undefined,
          categoria: 'servicios',
        }
      : {
          importe:          parsed.data.amount,
          concepto:         parsed.data.concept || 'Gasto',
          es_gasto_empresa: true,
          categoria:        suggestCategory(parsed.data.concept || ''),
        }

    const card = await createPendingAction(actionType, parameters, tenantId, userId)
    return { card }
  }

  // ── crear_cliente ────────────────────────────────────────────────────────
  if (/nuevo cliente|crear cliente|añadir cliente|agrega.{0,10}cliente|da de alta|registra.{0,15}cliente|alta.{0,10}cliente/i.test(userInput)) {
    const mNombre = userInput.match(
      /(?:cliente|nuevo|añade|crea|registra|alta)\s+(?:llamad[oa]?\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s+(?:con|teléfono|telefono|email|,|$)|\s*$)/i
    )
    const nombre = mNombre ? mNombre[1].trim() : ''
    if (!nombre) {
      return { needsInfo: '¿Cómo se llama el cliente? Ej: "nuevo cliente Ana García"' }
    }
    const mPhone  = userInput.match(/(?:teléfono|telefono|telf?|móvil|movil|tlf)[\s:]+([+0-9\s]{7,15})/i)
    const mEmail  = userInput.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
    const mNif    = userInput.match(/(?:nif|cif|dni)[\s:]+([A-Z0-9]{7,9})/i)
    const card = await createPendingAction('crear_cliente', {
      nombre,
      telefono: mPhone ? mPhone[1].trim().replace(/\s/g, '') : undefined,
      email:    mEmail ? mEmail[1]                            : undefined,
      nif:      mNif   ? mNif[1].toUpperCase()                : undefined,
    }, tenantId, userId)
    return { card }
  }

  // ── crear_factura ────────────────────────────────────────────────────────
  if (/crea.{0,10}factura|nueva factura|factura para|hazme.{0,10}factura|factura a\s|apunta.{0,10}factura|registra.{0,10}factura|hacer.{0,10}factura|pon.{0,10}factura|mete.{0,10}factura|generar?.{0,10}factura/i.test(userInput)) {
    const mCliente  = userInput.match(/(?:para|a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s+(?:por|de|con|,|$)|\s*$)/i)
    const mImporte  = userInput.match(/(\d+(?:[.,]\d{1,2})?)\s*€?(?:\s*euros?)?/i)
    const mConcepto = userInput.match(/(?:por|concepto|servicio)[:\s]+([^,\n.]{3,60})/i)

    const clienteNombre = mCliente ? mCliente[1].trim() : ''
    const importeNum    = mImporte ? parseFloat(mImporte[1].replace(',', '.')) : 0
    const concepto      = mConcepto ? mConcepto[1].trim() : 'Servicios'

    if (!clienteNombre) return { needsInfo: '¿Para qué cliente es la factura? Ej: "crea factura para Ana por 150€"' }
    if (!importeNum)    return { needsInfo: '¿Por qué importe? Ej: "crea factura para Ana por 150€"' }

    const { data: clientes } = await supabase
      .from('clients')
      .select('id, name')
      .eq('salon_id', tenantId)
      .ilike('name', `%${clienteNombre}%`)
      .limit(3)

    if (!clientes || clientes.length === 0) {
      return { needsInfo: `No encontré al cliente "${clienteNombre}". ¿Quieres crearlo primero? Di "nuevo cliente ${clienteNombre}".` }
    }

    const cliente = clientes[0]
    const lineas  = [{ concepto, cantidad: 1, precio_unitario: importeNum / 1.21, iva: 21 }]
    const card    = await createPendingAction('crear_factura', {
      cliente_id:     cliente.id,
      cliente_nombre: cliente.name,
      lineas,
      total:          importeNum,
      fecha:          new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
    }, tenantId, userId)
    return { card }
  }

  // ── cambiar_estado_factura ───────────────────────────────────────────────
  if (/paga[dr]a|cobrad[ao]|marca.{0,20}como|cambi.{0,10}estado|factura.{0,20}(pagad|cobrad|vencid|anuld)/i.test(userInput)) {
    let nuevoEstado = 'pagada'
    if (/vencid/i.test(userInput))       nuevoEstado = 'vencida'
    if (/anuld|cancel/i.test(userInput)) nuevoEstado = 'anulada'
    if (/pendiente/i.test(userInput))    nuevoEstado = 'pendiente'

    const mNum = userInput.match(/(?:#|factura\s+)?(\d{4}-\d{3,4})/i)
    let invoice = null

    if (mNum) {
      const { data } = await supabase
        .from('invoices')
        .select('id, number, total, status, clients(name)')
        .eq('salon_id', tenantId)
        .eq('number', mNum[1])
        .single()
      invoice = data
    } else {
      const mCliente = userInput.match(/(?:de|a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s|$)/i)
      if (mCliente) {
        const nombre = mCliente[1].trim()
        const { data: clientes } = await supabase
          .from('clients').select('id').eq('salon_id', tenantId).ilike('name', `%${nombre}%`).limit(1)
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
    }

    if (!invoice) return { needsInfo: 'No encontré la factura. Dime el número (ej: "2026-001") o el nombre del cliente.' }

    const card = await createPendingAction('cambiar_estado_factura', {
      factura_id:     invoice.id,
      factura_numero: invoice.number,
      cliente_nombre: (invoice.clients as any)?.name || '',
      importe:        invoice.total,
      estado_actual:  invoice.status,
      nuevo_estado:   nuevoEstado,
    }, tenantId, userId)
    return { card }
  }

  // ── enviar_recordatorio ──────────────────────────────────────────────────
  if (/recordatorio|avisa.{0,10}[aá]|manda.{0,15}recorda|recuérdal|recuerdal|enviou?n?.{0,10}recorda/i.test(userInput)) {
    const canal = /email|correo|mail/i.test(userInput) ? 'email' : 'whatsapp'

    const mCliente      = userInput.match(/(?:a|para)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s|,|$)/i)
    const clienteNombre = mCliente ? mCliente[1].trim() : ''

    if (!clienteNombre) return { needsInfo: '¿A qué cliente quieres mandarle el recordatorio? Ej: "manda recordatorio a Ana"' }

    const { data: clientes } = await supabase
      .from('clients').select('id, name, phone, email')
      .eq('salon_id', tenantId).ilike('name', `%${clienteNombre}%`).limit(1)

    if (!clientes?.length) return { needsInfo: `No encontré al cliente "${clienteNombre}". Revisa el nombre.` }

    const cliente = clientes[0]
    if (canal === 'whatsapp' && !cliente.phone) {
      return { needsInfo: `${cliente.name} no tiene WhatsApp registrado. ¿Lo enviamos por email?` }
    }
    if (canal === 'email' && !cliente.email) {
      return { needsInfo: `${cliente.name} no tiene email registrado. ¿Lo enviamos por WhatsApp?` }
    }

    const { data: facturas } = await supabase
      .from('invoices').select('id, number, total, due_date')
      .eq('salon_id', tenantId).eq('client_id', cliente.id)
      .in('status', ['pending', 'sent'])
      .order('created_at', { ascending: false }).limit(1)

    if (!facturas?.length) return { needsInfo: `${cliente.name} no tiene facturas pendientes.` }

    const factura     = facturas[0]
    const vencimiento = factura.due_date
      ? new Date(factura.due_date).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : 'próximos días'
    const totalFmt    = Number(factura.total).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    const mensaje = `Hola ${cliente.name}, te recordamos que tienes pendiente de pago la factura ${factura.number} por importe de ${totalFmt} €. Fecha límite: ${vencimiento}. ¡Gracias!`

    const card = await createPendingAction('enviar_recordatorio', {
      factura_id:     factura.id,
      factura_numero: factura.number,
      cliente_nombre: cliente.name,
      cliente_phone:  cliente.phone || null,
      cliente_email:  cliente.email || null,
      importe:        factura.total,
      canal,
      mensaje,
    }, tenantId, userId)
    return { card }
  }

  // ── READ intents → ejecutar directamente ─────────────────────────────────
  const routing = routeToLLM(parsed.confidence, userInput, false)

  let finalResponse: string
  if (routing.level === 'L0') {
    finalResponse = await generateL0ReadResponse(parsed, tenantId)
  } else {
    try {
      const ctx         = await getDashboardContext(tenantId)
      const systemWithCtx = DIABOLUS_SYSTEM_PROMPT + '\n\nDatos actuales del negocio:\n' + ctx
      finalResponse     = await callOpenRouter(routing.model, userInput, systemWithCtx)
    } catch (err) {
      console.warn('[Core] LLM error, fallback to L0:', err)
      finalResponse = await generateL0ReadResponse(parsed, tenantId)
    }
  }

  return {
    replyText: finalResponse,
    routing: { level: routing.level, model: routing.model, estimatedCost: `€${routing.estimatedCost}` },
  }
}

// ─── Dashboard context ────────────────────────────────────────────────────────

async function getDashboardContext(salonId: string): Promise<string> {
  try {
    const supabase      = getSupabase()
    const now           = new Date()
    const startOfMonth  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const [{ data: invoices }, { data: txns }] = await Promise.all([
      supabase.from('invoices').select('total, status, due_date').eq('salon_id', salonId),
      supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', startOfMonth),
    ])
    let pendingAmount = 0, pendingCount = 0, overdueAmount = 0, overdueCount = 0
    for (const inv of invoices || []) {
      if (['sent', 'pending'].includes(inv.status)) {
        pendingAmount += inv.total || 0; pendingCount++
        if (inv.due_date && new Date(inv.due_date) < now) { overdueAmount += inv.total || 0; overdueCount++ }
      }
    }
    let income = 0, expenses = 0
    for (const t of txns || []) {
      if (t.type === 'income') income += t.amount || 0
      else if (t.type === 'expense') expenses += t.amount || 0
    }
    return [
      `- Ingresos mes actual: €${income.toFixed(2)}`,
      `- Gastos mes actual: €${expenses.toFixed(2)}`,
      `- Balance: €${(income - expenses).toFixed(2)}`,
      `- Pendiente de cobro: €${pendingAmount.toFixed(2)} (${pendingCount} facturas)`,
      `- Vencido sin cobrar: €${overdueAmount.toFixed(2)} (${overdueCount} facturas)`,
    ].join('\n')
  } catch { return 'Datos no disponibles en este momento' }
}

// ─── L0 read responses ────────────────────────────────────────────────────────

async function generateL0ReadResponse(
  parsed: ReturnType<typeof parseUserInput>,
  salonId: string
): Promise<string> {
  switch (parsed.intent) {
    case 'query_balance':  return fetchBalance(salonId)
    case 'query_debtors':  return fetchPending(salonId)
    case 'query_overdue':  return fetchOverdue(salonId)
    case 'query_who_owes': return fetchWhoOwes(salonId)
    case 'query_income':   return fetchIncome(salonId)
    case 'query_expense':  return fetchExpenses(salonId)
    default:
      return [
        'Puedo ayudarte con:',
        '• *"gasté 45€ en material hoy"* → registra el gasto',
        '• *"cobré 300€ de Ana por corte"* → registra el ingreso',
        '• 📷 Adjunta una foto de ticket o factura',
        '• *"nuevo cliente Ana García tel 612345678"* → crea cliente',
        '• *"crea factura para Ana por 150€"* → prepara factura borrador',
        '• *"la factura de Ana está pagada"* → actualiza estado',
        '• *"manda recordatorio a Ana"* → envía aviso de cobro',
        '• *"¿cuánto tengo?"* → balance del mes',
        '• *"¿quién me debe?"* → cobros pendientes',
      ].join('\n')
  }
}

async function fetchBalance(salonId: string): Promise<string> {
  try {
    const supabase     = getSupabase()
    const now          = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await supabase
      .from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', startOfMonth)
    if (!txns?.length) return 'No hay transacciones registradas este mes.'
    let income = 0, expenses = 0
    for (const t of txns) { if (t.type === 'income') income += t.amount || 0; else expenses += t.amount || 0 }
    return `💰 Este mes:\n• Ingresos: €${income.toFixed(2)}\n• Gastos: €${expenses.toFixed(2)}\n• Balance: €${(income - expenses).toFixed(2)}`
  } catch { return 'No se pudo consultar el balance.' }
}

async function fetchPending(salonId: string): Promise<string> {
  try {
    const { data: invoices } = await getSupabase()
      .from('invoices').select('total, status').eq('salon_id', salonId).in('status', ['sent', 'pending'])
    if (!invoices?.length) return 'No hay cobros pendientes.'
    const total = invoices.reduce((s, i) => s + (i.total || 0), 0)
    return `⏳ Pendiente de cobro:\n• Total: €${total.toFixed(2)}\n• Facturas: ${invoices.length}`
  } catch { return 'No se pudo consultar los cobros pendientes.' }
}

async function fetchOverdue(salonId: string): Promise<string> {
  try {
    const now  = new Date().toISOString()
    const { data: invoices } = await getSupabase()
      .from('invoices').select('total, number, due_date')
      .eq('salon_id', salonId).in('status', ['sent', 'pending']).lt('due_date', now)
      .order('due_date', { ascending: true })
    if (!invoices?.length) return '✅ No hay facturas vencidas.'
    const total = invoices.reduce((s, i) => s + (i.total || 0), 0)
    const list  = invoices.slice(0, 5).map(i => `  • ${i.number}: €${(i.total || 0).toFixed(2)}`).join('\n')
    return `🔴 Facturas vencidas:\n• Total: €${total.toFixed(2)}\n• Facturas: ${invoices.length}\n${list}`
  } catch { return 'No se pudo consultar las facturas vencidas.' }
}

async function fetchWhoOwes(salonId: string): Promise<string> {
  try {
    const { data: invoices } = await getSupabase()
      .from('invoices').select('total, number, due_date, clients(name)')
      .eq('salon_id', salonId).in('status', ['sent', 'pending'])
      .order('due_date', { ascending: true }).limit(8)
    if (!invoices?.length) return 'No hay cobros pendientes.'
    const now   = new Date()
    const lines = invoices.map(i => {
      const name = (i.clients as any)?.name || 'Cliente'
      const due  = i.due_date ? new Date(i.due_date).toLocaleDateString('es-ES') : 'sin vencimiento'
      return `  • ${name}: €${(i.total || 0).toFixed(2)} (vence ${due})`
    })
    return `👥 Clientes que te deben:\n${lines.join('\n')}`
  } catch { return 'No se pudo consultar la lista de deudores.' }
}

async function fetchIncome(salonId: string): Promise<string> {
  try {
    const now          = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await getSupabase()
      .from('transactions').select('amount').eq('salon_id', salonId).eq('type', 'income').gte('created_at', startOfMonth)
    if (!txns?.length) return 'No hay ingresos registrados este mes.'
    const total = txns.reduce((s, t) => s + (t.amount || 0), 0)
    return `📈 Ingresos este mes: €${total.toFixed(2)} (${txns.length} registros)`
  } catch { return 'No se pudo consultar los ingresos.' }
}

async function fetchExpenses(salonId: string): Promise<string> {
  try {
    const now          = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await getSupabase()
      .from('transactions').select('amount').eq('salon_id', salonId).eq('type', 'expense').gte('created_at', startOfMonth)
    if (!txns?.length) return 'No hay gastos registrados este mes.'
    const total = txns.reduce((s, t) => s + (t.amount || 0), 0)
    return `📉 Gastos este mes: €${total.toFixed(2)} (${txns.length} registros)`
  } catch { return 'No se pudo consultar los gastos.' }
}

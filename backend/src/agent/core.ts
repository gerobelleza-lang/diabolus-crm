/**
 * core.ts — Núcleo agéntico channel-agnostic (Bloque A, Rebanada 4)
 *
 * Recibe AgentInput normalizado → devuelve AgentOutput normalizado.
 * No sabe de qué canal viene (web / telegram / whatsapp).
 *
 * v2 — 27 Jun 2026:
 *  ✅ Memoria conversacional (historial + resúmenes automáticos)
 *  ✅ 3 cerebros (Rápida/Inteligente/Brillante) por salón
 *  ✅ Modelo base cambiado de Hermes 3 70B a Gemini 2.5 Flash
 *
 * Flujo:
 *  action_response → executePendingAction | cancelPendingAction
 *  image           → vision.ts → gate → card
 *  text            → parser → intent routing → gate (writes) | DB read (queries)
 *
 * PRINCIPIO: nunca escribe ni envía sin confirmación explícita.
 */

import { parseUserInput }                                          from './parser'
import { routeToLLM, callOpenRouter, buildSystemPrompt, BRAIN_MODELS, getTimeContext, generateProactiveInsights } from './llm-router'
import { createClient }                                            from '@supabase/supabase-js'
import { createPendingAction, executePendingAction, cancelPendingAction } from './confirmation'
import type { ConfirmationCard }                                   from './confirmation'
import { suggestCategory }                                         from './tools'
import { extractFromImage }                                        from './vision'
import {
  saveMessage,
  buildMemoryContext,
  shouldGenerateSummary,
  generateAndStoreSummary,
  getSalonAIConfig,
} from './memory'
import type { BrainTier } from './memory'

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
  routing?:       { level: string; model: string; label: string; estimatedCost: string }
}

// ─── Supabase ────────────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!
  )
}

// ─── Channel link helpers (seguridad: externo → tenant) ──────────────────────

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

// ─── Main entry (with memory wrapper) ────────────────────────────────────────

export async function processAgentInput(input: AgentInput): Promise<AgentOutput> {
  // Save user message to memory (fire and forget for text inputs)
  if (input.type === 'text' && input.text) {
    saveMessage({
      salon_id: input.tenantId,
      user_id:  input.userId || null,
      channel:  input.channel,
      role:     'user',
      content:  input.text,
    }).catch(() => {})
  }

  // Process the input
  const result = await processAgentInputInternal(input)

  // Save assistant response to memory (fire and forget)
  const replyContent = result.replyText || result.needsInfo || result.card?.summary || ''
  if (replyContent && input.type !== 'action_response') {
    saveMessage({
      salon_id: input.tenantId,
      user_id:  input.userId || null,
      channel:  input.channel,
      role:     'assistant',
      content:  replyContent,
    }).catch(() => {})

    // Check if we need to generate a summary (every ~20 messages)
    shouldGenerateSummary(input.tenantId)
      .then(needed => { if (needed) generateAndStoreSummary(input.tenantId) })
      .catch(() => {})
  }

  return result
}

// ─── Internal processing ─────────────────────────────────────────────────────

async function processAgentInputInternal(input: AgentInput): Promise<AgentOutput> {
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
  if (/^(hola|hey|buenas|buenos días|buenas tardes|buenas noches|ey|hi|hello|qué hay|qué tal|holi|ola|buenas!|hola!|hey!)[\s]*[!?]?$/i.test(userInput)) {
    // Dynamic greeting based on time of day
    const tc = getTimeContext()
    let greeting: string
    if (tc.esLunes) {
      greeting = `${tc.saludo}. Lunes — nueva semana. ¿Arrancamos por los cobros pendientes? 😈`
    } else if (tc.esViernes && tc.hora >= 14) {
      greeting = `${tc.saludo}. Viernes. ¿Repasamos cómo ha ido la semana?`
    } else if (tc.esFinDeMes) {
      greeting = `${tc.saludo}. Fin de mes — hay que cerrar cobros. ¿Qué movemos?`
    } else if (tc.esPrincipioMes) {
      greeting = `${tc.saludo}. Mes nuevo. ¿Registramos los gastos fijos?`
    } else if (tc.hora >= 22 || tc.hora < 6) {
      greeting = `${tc.saludo}. Si puede esperar a mañana, descansa. Si no, dime.`
    } else {
      greeting = `${tc.saludo}. ¿Qué movemos? 😈`
    }
    return { replyText: greeting }
  }
  if (/^(ayuda|help|comandos|opciones|qué puedes hacer|para qué sirves|cómo funciona)[\s]*[?]?$/i.test(userInput)) {
    return {
      replyText: [
        '😈 <b>Diablilla — Comandos</b>',
        '',
        '🧾 <b>Facturas</b>',
        '• "factura a López 800€ instalación" → crea factura al instante',
        '• "crea factura para Ana por 150€ servicios" → ídem',
        '• "la factura de Ana está pagada" → marca cobrada',
        '• "manda recordatorio a Ana" → aviso de cobro',
        '',
        '💰 <b>Tesorería</b>',
        '• "cobré 300€ de García" → registra ingreso',
        '• "gasté 80€ en material" → registra gasto',
        '• "¿cuánto tengo?" → balance del mes',
        '• "¿quién me debe?" → morosos',
        '',
        '👥 <b>Clientes</b>',
        '• "nuevo cliente Ana García tel 612345678"',
        '',
        '📷 <b>Foto</b>',
        '• Adjunta ticket o factura → leo y registro',
        '',
        '/balance /cobros /vencidas /reporte',
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

  // ── crear_cliente ────────────────────────────────────────────────────────
  if (/nuevo cliente|crear cliente|añadir cliente|agrega.{0,10}cliente|da de alta|registra.{0,15}cliente|alta.{0,10}cliente|registra\s+a\s+[A-ZÁÉÍÓÚÑ]|añade\s+a\s+[A-ZÁÉÍÓÚÑ]|a[ñn]ade\s+a\s+[A-ZÁÉÍÓÚÑ]|mete\s+a\s+[A-ZÁÉÍÓÚÑ]|apunta\s+a\s+[A-ZÁÉÍÓÚÑ]/i.test(userInput)) {
    const mNombre = userInput.match(
      /(?:nuevo\s+cliente|cliente|añade|crea|registra|alta|mete|apunta)\s+(?:a\s+)?(?:llamad[oa]?\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s+(?:con|tel\b|telf?\b|tlf\b|teléfono|telefono|email|,|$)|\s*$)/i
    )
    const nombre = mNombre ? mNombre[1].trim() : ''
    if (!nombre) {
      return { needsInfo: '¿Cómo se llama el cliente? Ej: "nuevo cliente Ana García"' }
    }
    const mPhone    = userInput.match(/(?:teléfono|telefono|telf?|móvil|movil|tlf)[\s:]+([+0-9\s]{7,15})/i)
    const mEmail    = userInput.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
    const mNif      = userInput.match(/(?:nif|cif|dni)[\s:]+([A-Z0-9]{7,9})/i)
    const mComercial = userInput.match(/(?:panadería|panaderia|bar|restaurante|cafetería|cafeteria|peluquería|peluqueria|tienda|negocio|empresa|clínica|clinica|farmacia|taller|academia|gimnasio|gym)\s+([A-Za-záéíóúñÁÉÍÓÚÑ\s]{2,30})/i)
    const nombreComercial = mComercial ? mComercial[0].trim() : undefined

    // Anti-duplicados
    try {
      const supabase = getSupabase()
      const { data: existentes } = await supabase
        .from('clients')
        .select('id, name')
        .eq('salon_id', tenantId)
        .ilike('name', `%${nombre.split(' ')[0]}%`)
        .limit(3)

      if (existentes && existentes.length > 0) {
        const lista = existentes.map(c => `• ${c.name}`).join('\n')
        return {
          needsInfo: `Ya tengo estos clientes con nombre similar:\n${lista}\n\n¿Es alguno de ellos? Si sí, dime cuál y le busco la ficha. Si es nuevo, dime "crear nuevo".`,
        }
      }
    } catch {}

    const card = await createPendingAction('crear_cliente', {
      nombre,
      nombre_comercial: nombreComercial,
      telefono: mPhone ? mPhone[1].trim().replace(/\s/g, '') : undefined,
      email:    mEmail ? mEmail[1]                            : undefined,
      nif:      mNif   ? mNif[1].toUpperCase()                : undefined,
    }, tenantId, userId)
    return { card }
  }

  // ── crear_factura / enviar_factura ───────────────────────────────────────
  if (/crea.{0,10}factura|nueva factura|factura para|hazme.{0,10}factura|factura a\s|apunta.{0,10}factura|registra.{0,10}factura|hacer.{0,10}factura|pon.{0,10}factura|mete.{0,10}factura|generar?.{0,10}factura/i.test(userInput)) {

    const noEnviar     = /no env[íi]|sin enviar|solo crea|solo borrador/i.test(userInput)
    const userWantsSend = !noEnviar && /env[íi]a|manda(?:l[ao])?|por\s+email|al\s+correo/i.test(userInput)

    const mCliente = userInput.match(
      /(?:para|a)\s+(?:(?:el|la|los|las|un|una)\s+)?([a-záéíóúñA-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,55}?)(?:\s+(?:con|por|de|,)|\s+\d|$)/i
    )
    let clienteNombre = mCliente ? mCliente[1].trim() : ''
    clienteNombre = clienteNombre.replace(/^(?:el|la|los|las|un|una)\s+/i, '').trim()

    let importeNum = 0
    const mImporteUnit = userInput.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur\w*)/i)
    if (mImporteUnit) {
      importeNum = parseFloat(mImporteUnit[1].replace(',', '.'))
    }

    let concepto = ''
    const mConcepto = userInput.match(
      /(?:concepto\s+(?:de\s+)?)([^,\n]+?)(?:\s+con\s+(?:el\s+)?(?:cif|nif)|,|\s*$)/i
    ) || userInput.match(
      /\bpor\b\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][^,\n]{3,80}?)(?:\s+con\s+|\s+cif\b|\s+nif\b|,|\s*$)/i
    )
    if (mConcepto) {
      concepto = mConcepto[1].trim().replace(/^de\s+/i, '').trim()
      concepto = concepto.charAt(0).toUpperCase() + concepto.slice(1)
    }

    if (!concepto && importeNum > 0) {
      const afterAmtMatch = userInput.match(
        /\d+(?:[.,]\d{1,2})?\s*(?:€|eur\w*)?\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][^\d,\n]{2,60}?)(?:\s+con\s+(?:el\s+)?(?:cif|nif)|,|\s*$)/i
      )
      if (afterAmtMatch) {
        const raw = afterAmtMatch[1].trim()
          .replace(/^(?:el|la|los|las|un|una|de|del|para|por)\s+/i, '')
          .trim()
        if (raw.length > 2) {
          concepto = raw.charAt(0).toUpperCase() + raw.slice(1)
        }
      }
    }

    const mCif   = userInput.match(/(?:cif|nif)\D{0,35}([A-Z]\s*\d{6,8}[A-Z0-9]?)/i)
    const cifNif = mCif ? mCif[1].replace(/\s/g, '').toUpperCase() : null

    const mEmailDir    = userInput.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
    const emailDirecto = mEmailDir ? mEmailDir[1] : null

    if (!clienteNombre) {
      return { needsInfo: '¿Para qué cliente es la factura? Ej: "factura a García 800€ instalación"' }
    }
    if (!importeNum) {
      return { needsInfo: `¿Por qué importe es la factura para ${clienteNombre}? Ej: "150€"` }
    }
    if (!concepto) {
      return { needsInfo: `¿Cuál es el concepto para ${clienteNombre}? Ej: "instalación eléctrica", "consultoría"` }
    }

    const { data: clientes } = await supabase
      .from('clients')
      .select('id, name, email, nif')
      .eq('salon_id', tenantId)
      .ilike('name', `%${clienteNombre}%`)
      .limit(3)

    if (!clientes || clientes.length === 0) {
      return { needsInfo: `No encontré al cliente "${clienteNombre}". ¿Lo creamos? Di "nuevo cliente ${clienteNombre}".` }
    }

    const cliente     = clientes[0]
    const clientEmail = emailDirecto || cliente.email || null

    if (userWantsSend && !clientEmail) {
      return { needsInfo: `Para enviar la factura a ${cliente.name} necesito su email. ¿Cuál es?` }
    }
    const doSend     = !noEnviar && !!clientEmail
    const actionType = doSend ? 'enviar_factura' : 'crear_factura'

    const lineas = [{
      concepto,
      cantidad:        1,
      precio_unitario: importeNum / 1.21,
      iva:             21,
    }]

    const params: Record<string, any> = {
      cliente_id:     cliente.id,
      cliente_nombre: cliente.name,
      lineas,
      total:          importeNum,
      fecha:          new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
    }
    if (doSend)  params.cliente_email = clientEmail
    if (cifNif)  params.cif_nif       = cifNif

    const card = await createPendingAction(actionType, params, tenantId, userId)
    return { card }
  }

  // ── facturas vencidas READ guard ──────────────────────────────────────────
  if (
    /^facturas?\s+vencidas?$|^ver\s+vencidas?$|^hay\s+vencidas?$|^cu[aá]ntas?\s+vencidas?$/i.test(userInput.trim()) ||
    /(?:listar?|ver|mostrar|hay|cu[aá]ntas?|qu[eé])\s+facturas?\s+vencidas?/i.test(userInput)
  ) {
    return { replyText: await fetchOverdue(tenantId) }
  }

  // ── cambiar_estado_factura ───────────────────────────────────────────────
  if (/paga[dr]a|cobrad[ao]|marca.{0,20}como|cambi.{0,10}estado|factura.{0,20}(pagad|cobrad|anuld)/i.test(userInput)) {
    let nuevoEstado = 'pagada'
    if (/vencid/i.test(userInput))       nuevoEstado = 'vencida'
    if (/anuld|cancel/i.test(userInput)) nuevoEstado = 'anulada'
    if (/pendiente/i.test(userInput))    nuevoEstado = 'pendiente'

    const mNum = userInput.match(/(?:#|factura\s+)?(\\d{4}-\\d{3,4})/i)
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

  // ── préstamo / adelanto nómina / anticipo ────────────────────────────────
  if (/pr[eé]stamo|adelanto\s+(?:de\s+)?(?:n[oó]mina|sueldo)|anticipo\s+(?:de\s+)?(?:n[oó]mina|sueldo)|anticipo\s+a\s|presto\s|presté\s/i.test(userInput)) {

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

  // ── gastos recurrentes del negocio ───────────────────────────────────────
  {
    const gastoMap: Array<{re: RegExp; concepto: string; categoria: string; ejemploImporte: string}> = [
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

    let matchedGasto: typeof gastoMap[0] | null = null
    for (const g of gastoMap) {
      if (g.re.test(userInput)) { matchedGasto = g; break }
    }

    if (matchedGasto) {
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
  }

  // ── cuota autónomo / seguridad social / nómina empleado ──────────────────
  if (/cuota\s+aut[oó]nomo|cuota\s+reta|seguridad\s+social|cuota\s+ss\b|n[oó]mina\s+de|pago\s+n[oó]mina/i.test(userInput)) {

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

  // ── READ intents & LLM fallback ──────────────────────────────────────────

  // Load salon AI config for brain tier
  const aiConfig = await getSalonAIConfig(tenantId)
  const brainTier: BrainTier = aiConfig.brain_tier || 'rapida'
  const routing = routeToLLM(parsed.confidence, userInput, false, brainTier)

  let finalResponse: string
  if (routing.level === 'L0') {
    finalResponse = await generateL0ReadResponse(parsed, tenantId)
  } else {
    try {
      // Load memory and dashboard context in parallel
      const [memoryCtx, dashData] = await Promise.all([
        buildMemoryContext(tenantId),
        getDashboardContext(tenantId),
      ])
      const systemPrompt = buildSystemPrompt(routing.label, memoryCtx, dashData.text, userInput)
      finalResponse = await callOpenRouter(routing.model, userInput, systemPrompt)

      // Append proactive insight (30% chance, max 1 per message)
      if (Math.random() < 0.3) {
        const tc = getTimeContext()
        const insights = generateProactiveInsights({
          timeContext: tc,
          facturasPendientes: dashData.structured.pendingCount,
          facturasVencidas: dashData.structured.overdueCount,
          balanceMes: dashData.structured.monthIncome - dashData.structured.monthExpenses,
          balanceMesAnterior: dashData.structured.lastMonthIncome,
        })
        if (insights.length > 0) {
          const pick = insights[Math.floor(Math.random() * insights.length)]
          finalResponse += `\n\n💡 ${pick.texto}`
        }
      }
    } catch (err) {
      console.warn('[Core] LLM error, fallback to L0:', err)
      finalResponse = await generateL0ReadResponse(parsed, tenantId)
    }
  }

  return {
    replyText: finalResponse,
    routing: {
      level: routing.level,
      model: routing.model,
      label: routing.label,
      estimatedCost: `€${routing.estimatedCost}`,
    },
  }
}

// ─── Dashboard context ────────────────────────────────────────────────────────

interface DashboardData {
  text: string
  structured: {
    pendingCount: number
    pendingAmount: number
    overdueCount: number
    overdueAmount: number
    monthIncome: number
    monthExpenses: number
    lastMonthIncome: number
  }
}

async function getDashboardContext(salonId: string): Promise<DashboardData> {
  const empty: DashboardData = {
    text: 'Datos no disponibles en este momento',
    structured: {
      pendingCount: 0, pendingAmount: 0,
      overdueCount: 0, overdueAmount: 0,
      monthIncome: 0, monthExpenses: 0, lastMonthIncome: 0,
    },
  }
  try {
    const supabase      = getSupabase()
    const now           = new Date()
    const startOfMonth  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()

    const [{ data: invoices }, { data: txns }, { data: lastMonthTxns }] = await Promise.all([
      supabase.from('invoices').select('total, status, due_date').eq('salon_id', salonId),
      supabase.from('transactions').select('amount, type').eq('salon_id', salonId).gte('created_at', startOfMonth),
      supabase.from('transactions').select('amount, type').eq('salon_id', salonId)
        .gte('created_at', startOfLastMonth).lt('created_at', startOfMonth),
    ])

    let pendingAmount = 0, pendingCount = 0, overdueAmount = 0, overdueCount = 0
    for (const inv of invoices || []) {
      if (['sent', 'pending'].includes(inv.status)) {
        pendingAmount += inv.total || 0; pendingCount++
        if (inv.due_date && new Date(inv.due_date) < now) {
          overdueAmount += inv.total || 0; overdueCount++
        }
      }
    }

    let income = 0, expenses = 0
    for (const t of txns || []) {
      if (t.type === 'income') income += t.amount || 0
      else if (t.type === 'expense') expenses += t.amount || 0
    }

    let lastMonthIncome = 0
    for (const t of lastMonthTxns || []) {
      if (t.type === 'income') lastMonthIncome += t.amount || 0
    }

    const structured = {
      pendingCount, pendingAmount,
      overdueCount, overdueAmount,
      monthIncome: income, monthExpenses: expenses,
      lastMonthIncome,
    }

    return {
      text: [
        `- Ingresos mes actual: EUR ${income.toFixed(2)}`,
        `- Gastos mes actual: EUR ${expenses.toFixed(2)}`,
        `- Balance: EUR ${(income - expenses).toFixed(2)}`,
        `- Pendiente de cobro: EUR ${pendingAmount.toFixed(2)} (${pendingCount} facturas)`,
        `- Vencido sin cobrar: EUR ${overdueAmount.toFixed(2)} (${overdueCount} facturas)`,
        `- Ingresos mes anterior: EUR ${lastMonthIncome.toFixed(2)}`,
      ].join('\n'),
      structured,
    }
  } catch {
    return empty
  }
}


// ─── L0 Read Response (direct DB queries, no LLM) ─────────────────────────────

async function generateL0ReadResponse(parsed: { intent: string; data: any }, salonId: string): Promise<string> {
  switch (parsed.intent) {
    case 'query_balance':
      return fetchBalance(salonId)
    case 'query_income':
      return fetchIncome(salonId)
    case 'query_expense':
      return fetchExpenses(salonId)
    case 'query_overdue':
      return fetchOverdue(salonId)
    case 'query_who_owes':
    case 'query_debtors':
      return fetchWhoOwes(salonId)
    case 'query_pending':
      return fetchPending(salonId)
    default:
      return fetchBalance(salonId)
  }
}

// ---- Insight data fetchers (standalone) ----

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

async function fetchPending(salonId: string): Promise<string> {
  try {
    const { data: invoices } = await getSupabase()
      .from('invoices').select('total, status').eq('salon_id', salonId).in('status', ['sent', 'pending'])
    if (!invoices?.length) return 'No hay cobros pendientes.'
    const total = invoices.reduce((s: number, i: any) => s + (i.total || 0), 0)
    return `Pendiente de cobro: Total EUR ${total.toFixed(2)} | Facturas: ${invoices.length}`
  } catch { return 'No se pudo consultar los cobros pendientes.' }
}

async function fetchOverdue(salonId: string): Promise<string> {
  try {
    const now  = new Date().toISOString()
    const { data: invoices } = await getSupabase()
      .from('invoices').select('total, number, due_date').eq('salon_id', salonId).in('status', ['sent', 'pending']).lt('due_date', now)
    if (!invoices?.length) return 'No hay facturas vencidas.'
    const total = invoices.reduce((s: number, i: any) => s + (i.total || 0), 0)
    const list  = invoices.slice(0, 5).map((i: any) => `  - ${i.number}: EUR ${(i.total || 0).toFixed(2)}`).join('\n')
    return `Facturas vencidas: Total EUR ${total.toFixed(2)} | Facturas: ${invoices.length}\n${list}`
  } catch { return 'No se pudo consultar las facturas vencidas.' }
}

async function fetchWhoOwes(salonId: string): Promise<string> {
  try {
    const { data: invoices } = await getSupabase()
      .from('invoices').select('total, due_date, clients(name)').eq('salon_id', salonId).in('status', ['sent', 'pending']).order('total', { ascending: false }).limit(10)
    if (!invoices?.length) return 'No hay deudores.'
    const lines = invoices.map((i: any) => {
      const name = (i.clients as any)?.name || 'Cliente'
      const due  = i.due_date ? new Date(i.due_date).toLocaleDateString('es-ES') : 'sin vencimiento'
      return `  - ${name}: EUR ${(i.total || 0).toFixed(2)} (vence ${due})`
    })
    return `Clientes que te deben:\n${lines.join('\n')}`
  } catch { return 'No se pudo consultar la lista de deudores.' }
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

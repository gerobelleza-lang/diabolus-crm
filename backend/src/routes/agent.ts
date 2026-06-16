// @ts-nocheck
/**
 * POST /api/agent/chat   — procesa input natural (texto)
 * POST /api/agent/photo  — procesa imagen de ticket/factura (visión)
 * POST /api/agent/confirm — ejecuta la acción pendiente tras OK del usuario
 * POST /api/agent/cancel  — descarta la acción pendiente
 *
 * PRINCIPIO: ninguna escritura ni envío ocurre sin OK explícito del usuario.
 * El gate (createPendingAction → tarjeta → executePendingAction) aplica a texto Y foto.
 *
 * Herramientas write/send:
 *   registrar_gasto | registrar_ingreso | crear_cliente
 *   crear_factura   | cambiar_estado_factura | enviar_recordatorio
 */

import { Hono } from 'hono'
import { parseUserInput } from '../agent/parser'
import { routeToLLM, callOpenRouter, DIABOLUS_SYSTEM_PROMPT } from '../agent/llm-router'
import { createClient } from '@supabase/supabase-js'
import { createPendingAction, executePendingAction, cancelPendingAction } from '../agent/confirmation'
import { suggestCategory } from '../agent/tools'
import { extractFromImage } from '../agent/vision'

export const agentRoutes = new Hono()

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  return createClient(url, key)
}

// ─── POST /api/agent/chat ──────────────────────────────────────────────────────

agentRoutes.post('/chat', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))

    if (!body || typeof body !== 'object' || !('userInput' in body)) {
      return c.json({ error: 'Missing userInput' }, 400)
    }

    const userInput = body.userInput as string
    if (typeof userInput !== 'string' || !userInput.trim()) {
      return c.json({ error: 'userInput must be non-empty string' }, 400)
    }

    const salonId = c.get('salonId') as string
    const userId  = c.get('userId')  as string

    // ── Paso 1: L0 Parser (determinístico, €0) ───────────────────────────────
    const parsed = parseUserInput(userInput)

    // ── WRITE: registrar_gasto / registrar_ingreso ───────────────────────────
    if (parsed.intent === 'create_income' || parsed.intent === 'create_expense') {
      const isIncome = parsed.intent === 'create_income'

      if (!parsed.data.amount || parsed.data.amount <= 0) {
        return c.json({
          status: 'needs_info',
          message: isIncome
            ? '¿Cuánto cobraste? Dime el importe. Ej: "cobré 150€ de Juan"'
            : '¿Cuánto gastaste? Dime el importe. Ej: "gasté 80€ en materiales"',
        })
      }

      const actionType = isIncome ? 'registrar_ingreso' : 'registrar_gasto'
      const parameters = isIncome
        ? {
            importe:  parsed.data.amount,
            concepto: parsed.data.concept || 'Servicio',
            cliente:  parsed.data.clientName !== 'Cliente' ? parsed.data.clientName : undefined,
            categoria: 'servicios',
          }
        : {
            importe:          parsed.data.amount,
            concepto:         parsed.data.concept || 'Gasto',
            es_gasto_empresa: true,
            categoria:        suggestCategory(parsed.data.concept || ''),
          }

      const card = await createPendingAction(actionType, parameters, salonId, userId)
      return c.json({ status: 'pending_confirmation', card })
    }

    // ── WRITE: crear_cliente ─────────────────────────────────────────────────
    if (/nuevo cliente|crear cliente|añadir cliente|agrega.{0,10}cliente|da de alta|registra.{0,15}cliente|alta.{0,10}cliente/i.test(userInput)) {
      let nombre = ''
      const mNombre = userInput.match(
        /(?:cliente|nuevo|añade|crea|registra|alta|high)\s+(?:llamad[oa]?\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s+(?:con|teléfono|telefono|email|,|$)|\s*$)/i
      )
      if (mNombre) nombre = mNombre[1].trim()

      if (!nombre) {
        return c.json({
          status: 'needs_info',
          message: '¿Cómo se llama el cliente? Ej: "nuevo cliente Ana García"',
        })
      }

      const mPhone = userInput.match(/(?:teléfono|telefono|telf?|móvil|movil|tlf)[\s:]+([+0-9\s]{7,15})/i)
      const telefono = mPhone ? mPhone[1].trim().replace(/\s/g, '') : undefined

      const mEmail = userInput.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
      const email = mEmail ? mEmail[1] : undefined

      const mNif = userInput.match(/(?:nif|cif|dni)[\s:]+([A-Z0-9]{7,9})/i)
      const nif = mNif ? mNif[1].toUpperCase() : undefined

      const card = await createPendingAction('crear_cliente', { nombre, telefono, email, nif }, salonId, userId)
      return c.json({ status: 'pending_confirmation', card })
    }

    // ── WRITE: crear_factura ─────────────────────────────────────────────────
    if (/crea.{0,10}factura|nueva factura|factura para|hazme.{0,10}factura|factura a\s/i.test(userInput)) {
      const mCliente = userInput.match(/(?:para|a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s+(?:por|de|con|,|$)|\s*$)/i)
      const clienteNombre = mCliente ? mCliente[1].trim() : ''

      const mImporte = userInput.match(/(\d+(?:[.,]\d{1,2})?)\s*€?(?:\s*euros?)?/i)
      const importeNum = mImporte ? parseFloat(mImporte[1].replace(',', '.')) : 0

      const mConcepto = userInput.match(/(?:por|concepto|servicio)[:\s]+([^,\n.]{3,60})/i)
      const concepto = mConcepto ? mConcepto[1].trim() : 'Servicios'

      if (!clienteNombre) {
        return c.json({
          status: 'needs_info',
          message: '¿Para qué cliente es la factura? Ej: "crea factura para Ana por 150€"',
        })
      }
      if (!importeNum) {
        return c.json({
          status: 'needs_info',
          message: '¿Por qué importe? Ej: "crea factura para Ana por 150€"',
        })
      }

      const supabase = getSupabase()
      const { data: clientes } = await supabase
        .from('clients')
        .select('id, name')
        .eq('salon_id', salonId)
        .ilike('name', `%${clienteNombre}%`)
        .limit(3)

      if (!clientes || clientes.length === 0) {
        return c.json({
          status: 'needs_info',
          message: `No encontré al cliente "${clienteNombre}". ¿Quieres crearlo primero? Di "nuevo cliente ${clienteNombre}".`,
        })
      }

      const cliente = clientes[0]
      const lineas = [{
        concepto,
        cantidad: 1,
        precio_unitario: importeNum / 1.21,
        iva: 21,
      }]

      const card = await createPendingAction('crear_factura', {
        cliente_id:     cliente.id,
        cliente_nombre: cliente.name,
        lineas,
        total:          importeNum,
        fecha:          new Date().toISOString().split('T')[0],
      }, salonId, userId)
      return c.json({ status: 'pending_confirmation', card })
    }

    // ── WRITE: cambiar_estado_factura ────────────────────────────────────────
    if (/paga[dr]a|cobrad[ao]|marca.{0,20}como|cambi.{0,10}estado|factura.{0,20}(pagad|cobrad|vencid|anuld)/i.test(userInput)) {
      const supabase = getSupabase()

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
          .eq('salon_id', salonId)
          .eq('number', mNum[1])
          .single()
        invoice = data
      } else {
        const mCliente = userInput.match(/(?:de|a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s|$)/i)
        if (mCliente) {
          const nombre = mCliente[1].trim()
          const { data: clientes } = await supabase
            .from('clients')
            .select('id')
            .eq('salon_id', salonId)
            .ilike('name', `%${nombre}%`)
            .limit(1)

          if (clientes && clientes.length > 0) {
            const { data: facturas } = await supabase
              .from('invoices')
              .select('id, number, total, status, clients(name)')
              .eq('salon_id', salonId)
              .eq('client_id', clientes[0].id)
              .in('status', ['pending', 'sent'])
              .order('created_at', { ascending: false })
              .limit(1)

            if (facturas && facturas.length > 0) invoice = facturas[0]
          }
        }
      }

      if (!invoice) {
        return c.json({
          status: 'needs_info',
          message: 'No encontré la factura. Dime el número (ej: "2026-001") o el nombre del cliente.',
        })
      }

      const card = await createPendingAction('cambiar_estado_factura', {
        factura_id:     invoice.id,
        factura_numero: invoice.number,
        cliente_nombre: (invoice.clients as any)?.name || '',
        importe:        invoice.total,
        estado_actual:  invoice.status,
        nuevo_estado:   nuevoEstado,
      }, salonId, userId)
      return c.json({ status: 'pending_confirmation', card })
    }

    // ── SEND: enviar_recordatorio ────────────────────────────────────────────
    if (/recordatorio|avisa.{0,10}[aá]|manda.{0,15}recorda|recuérdal|recuerdal|enviou?n?.{0,10}recorda/i.test(userInput)) {
      const supabase = getSupabase()

      const canal = /email|correo|mail/i.test(userInput) ? 'email' : 'whatsapp'

      const mCliente = userInput.match(/(?:a|para)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s|,|$)/i)
      const clienteNombre = mCliente ? mCliente[1].trim() : ''

      if (!clienteNombre) {
        return c.json({
          status: 'needs_info',
          message: '¿A qué cliente quieres mandarle el recordatorio? Ej: "manda recordatorio a Ana"',
        })
      }

      const { data: clientes } = await supabase
        .from('clients')
        .select('id, name, phone, email')
        .eq('salon_id', salonId)
        .ilike('name', `%${clienteNombre}%`)
        .limit(1)

      if (!clientes || clientes.length === 0) {
        return c.json({
          status: 'needs_info',
          message: `No encontré al cliente "${clienteNombre}". Revisa el nombre.`,
        })
      }

      const cliente = clientes[0]

      if (canal === 'whatsapp' && !cliente.phone) {
        return c.json({
          status: 'needs_info',
          message: `${cliente.name} no tiene número de WhatsApp registrado. ¿Quieres enviarlo por email?`,
        })
      }
      if (canal === 'email' && !cliente.email) {
        return c.json({
          status: 'needs_info',
          message: `${cliente.name} no tiene email registrado. ¿Quieres enviarlo por WhatsApp?`,
        })
      }

      const { data: facturas } = await supabase
        .from('invoices')
        .select('id, number, total, due_date')
        .eq('salon_id', salonId)
        .eq('client_id', cliente.id)
        .in('status', ['pending', 'sent'])
        .order('created_at', { ascending: false })
        .limit(1)

      if (!facturas || facturas.length === 0) {
        return c.json({
          status: 'needs_info',
          message: `${cliente.name} no tiene facturas pendientes.`,
        })
      }

      const factura = facturas[0]
      const vencimiento = factura.due_date
        ? new Date(factura.due_date).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : 'próximos días'

      const mensaje = `Hola ${cliente.name}, te recordamos que tienes pendiente de pago la factura ${factura.number} por importe de ${formatImporteSimple(factura.total)}. Fecha límite: ${vencimiento}. ¡Gracias!`

      const card = await createPendingAction('enviar_recordatorio', {
        factura_id:     factura.id,
        factura_numero: factura.number,
        cliente_nombre: cliente.name,
        cliente_phone:  cliente.phone  || null,
        cliente_email:  cliente.email  || null,
        importe:        factura.total,
        canal,
        mensaje,
      }, salonId, userId)
      return c.json({ status: 'pending_confirmation', card })
    }

    // ── READ intents → ejecutar directamente ──────────────────────────────────
    const routing = routeToLLM(parsed.confidence, userInput, false)

    let finalResponse: string
    if (routing.level === 'L0') {
      finalResponse = await generateL0ReadResponse(parsed)
    } else {
      try {
        const ctx = await getDashboardContext()
        const systemWithCtx = DIABOLUS_SYSTEM_PROMPT + '\n\nDatos actuales del negocio:\n' + ctx
        finalResponse = await callOpenRouter(routing.model, userInput, systemWithCtx)
      } catch (err) {
        console.warn('[LLM] Error, falling back to L0:', err)
        finalResponse = await generateL0ReadResponse(parsed)
      }
    }

    return c.json({
      status: 'success',
      message: finalResponse,
      routing: {
        level: routing.level,
        model: routing.model,
        rationale: routing.rationale,
        estimatedCost: `€${routing.estimatedCost}`,
      },
    })
  } catch (err) {
    console.error('[Agent] Error:', err)
    return c.json({ error: 'Agent error' }, 500)
  }
})

// ─── POST /api/agent/photo ─────────────────────────────────────────────────────
// Recibe: { image: base64, mimeType?: string }
// Extrae datos con visión → crea acción pendiente → devuelve tarjeta (mismo gate)
// La imagen NUNCA se guarda en servidor; la miniatura vive en el cliente.

agentRoutes.post('/photo', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { image, mimeType = 'image/jpeg' } = body

    if (!image || typeof image !== 'string') {
      return c.json({ error: 'Missing image (base64)' }, 400)
    }

    // Limitar tamaño: ~5MB imagen max
    if (image.length > 7_000_000) {
      return c.json({
        status: 'needs_info',
        message: 'La imagen es demasiado grande. Hazle una foto con menor resolución e inténtalo de nuevo.',
      }, 400)
    }

    const salonId = c.get('salonId') as string
    const userId  = c.get('userId')  as string

    // ── Extracción por visión ──────────────────────────────────────────────
    const extracted = await extractFromImage(image, mimeType)

    // ── Caso: varios tickets en una foto ──────────────────────────────────
    if (extracted.campos_dudosos.includes('multiple_tickets')) {
      return c.json({
        status: 'needs_info',
        message: 'Veo varios tickets en la foto. Manda uno por foto para registrarlos correctamente.',
        extracted,
      })
    }

    // ── Caso: moneda extranjera ────────────────────────────────────────────
    if (extracted.campos_dudosos.includes('moneda_extranjera')) {
      return c.json({
        status: 'needs_info',
        message: 'El ticket parece estar en otra moneda. ¿Me confirmas el importe en euros y el concepto?',
        extracted,
      })
    }

    // ── Anti-alucinación: confianza baja o importe nulo ───────────────────
    if (extracted.confianza === 'baja' || extracted.importe === null) {
      let msg = 'No consigo leer bien el ticket.'
      if (extracted.importe === null) msg += ' ¿Cuánto es el importe total?'
      if (extracted.concepto === null) msg += ' ¿Y de qué es el gasto?'
      msg += '\n\nO dímelo directamente: *"gasté 45€ en material"*'
      return c.json({
        status: 'needs_info',
        message: msg.trim(),
        extracted,
      })
    }

    // ── Todo legible — construir propuesta y pasar por el gate ────────────
    const actionType = extracted.tipo === 'ingreso' ? 'registrar_ingreso' : 'registrar_gasto'
    const today = new Date().toISOString().split('T')[0]

    const parameters =
      extracted.tipo === 'ingreso'
        ? {
            importe:        extracted.importe,
            concepto:       extracted.concepto || 'Ingreso de ticket',
            cliente:        extracted.proveedor || undefined,
            categoria:      extracted.categoria || 'servicios',
            fecha:          extracted.fecha || today,
            source:         'photo',
            campos_dudosos: extracted.campos_dudosos,
          }
        : {
            importe:          extracted.importe,
            concepto:         extracted.concepto || 'Gasto de ticket',
            proveedor:        extracted.proveedor || undefined,
            es_gasto_empresa: true,
            categoria:        extracted.categoria || suggestCategory(extracted.concepto || ''),
            fecha:            extracted.fecha || today,
            source:           'photo',
            campos_dudosos:   extracted.campos_dudosos,
          }

    const card = await createPendingAction(actionType, parameters, salonId, userId)

    return c.json({
      status:         'pending_confirmation',
      card,
      source:         'photo',
      campos_dudosos: extracted.campos_dudosos,
      confianza:      extracted.confianza,
    })
  } catch (err) {
    console.error('[Agent/Photo] Error:', err)
    return c.json({ error: 'Error procesando la imagen' }, 500)
  }
})

// ─── POST /api/agent/confirm ───────────────────────────────────────────────────

agentRoutes.post('/confirm', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { pending_action_id } = body

    if (!pending_action_id) {
      return c.json({ error: 'Missing pending_action_id' }, 400)
    }

    const result = await executePendingAction(pending_action_id)

    return c.json({
      status: result.ok ? 'success' : 'error',
      message: result.message,
    })
  } catch (err) {
    console.error('[Agent/Confirm] Error:', err)
    return c.json({ error: 'Confirm error' }, 500)
  }
})

// ─── POST /api/agent/cancel ────────────────────────────────────────────────────

agentRoutes.post('/cancel', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { pending_action_id } = body

    if (!pending_action_id) {
      return c.json({ error: 'Missing pending_action_id' }, 400)
    }

    await cancelPendingAction(pending_action_id)

    return c.json({
      status: 'success',
      message: 'Acción cancelada. No se ha guardado nada.',
    })
  } catch (err) {
    console.error('[Agent/Cancel] Error:', err)
    return c.json({ error: 'Cancel error' }, 500)
  }
})

// ─── Context for LLM ──────────────────────────────────────────────────────────

async function getDashboardContext(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    const [{ data: invoices }, { data: txns }] = await Promise.all([
      supabase.from('invoices').select('total, status, due_date'),
      supabase.from('transactions').select('amount, type').gte('created_at', startOfMonth),
    ])

    let pendingAmount = 0, pendingCount = 0, overdueAmount = 0, overdueCount = 0
    for (const inv of invoices || []) {
      if (['sent', 'pending'].includes(inv.status)) {
        pendingAmount += inv.total || 0
        pendingCount++
        if (inv.due_date && new Date(inv.due_date) < now) {
          overdueAmount += inv.total || 0
          overdueCount++
        }
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
  } catch {
    return 'Datos no disponibles en este momento'
  }
}

// ─── L0 Read responses ────────────────────────────────────────────────────────

async function generateL0ReadResponse(parsed: ReturnType<typeof parseUserInput>): Promise<string> {
  const { intent } = parsed

  switch (intent) {
    case 'query_balance':   return fetchBalance()
    case 'query_debtors':   return fetchPending()
    case 'query_overdue':   return fetchOverdue()
    case 'query_who_owes':  return fetchWhoOwes()
    case 'query_income':    return fetchIncome()
    case 'query_expense':   return fetchExpenses()
    case 'unclear':
    case 'unclear_query':
    default:
      return [
        'Puedo ayudarte con:',
        '• *"gasté 45€ en material hoy"* → registra el gasto',
        '• *"cobré 300€ de Ana por corte"* → registra el ingreso',
        '• 📷 *Adjunta una foto* de cualquier ticket o factura',
        '• *"nuevo cliente Ana García tel 612345678"* → crea cliente',
        '• *"crea factura para Ana por 150€"* → prepara factura borrador',
        '• *"la factura de Ana está pagada"* → actualiza estado',
        '• *"manda recordatorio a Ana"* → envía aviso de cobro',
        '• *"¿cuánto tengo?"* → balance del mes',
        '• *"¿quién me debe?"* → cobros pendientes',
      ].join('\n')
  }
}

async function fetchBalance(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await supabase
      .from('transactions').select('amount, type').gte('created_at', startOfMonth)

    if (!txns || txns.length === 0) return 'No hay transacciones registradas este mes.'

    let income = 0, expenses = 0
    for (const t of txns) {
      if (t.type === 'income') income += t.amount || 0
      else if (t.type === 'expense') expenses += t.amount || 0
    }
    const balance = income - expenses
    return `💰 Este mes:\n• Ingresos: €${income.toFixed(2)}\n• Gastos: €${expenses.toFixed(2)}\n• Balance: €${balance.toFixed(2)}`
  } catch {
    return 'No se pudo consultar el balance.'
  }
}

async function fetchPending(): Promise<string> {
  try {
    const supabase = getSupabase()
    const { data: invoices } = await supabase
      .from('invoices').select('total, status').in('status', ['sent', 'pending'])
    if (!invoices || invoices.length === 0) return 'No hay cobros pendientes.'
    const total = invoices.reduce((s, i) => s + (i.total || 0), 0)
    return `⏳ Pendiente de cobro:\n• Total: €${total.toFixed(2)}\n• Facturas: ${invoices.length}`
  } catch {
    return 'No se pudo consultar los cobros pendientes.'
  }
}

async function fetchOverdue(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date().toISOString()
    const { data: invoices } = await supabase
      .from('invoices').select('total, number, due_date')
      .in('status', ['sent', 'pending']).lt('due_date', now)
      .order('due_date', { ascending: true })
    if (!invoices || invoices.length === 0) return '✅ No hay facturas vencidas.'
    const total = invoices.reduce((s, i) => s + (i.total || 0), 0)
    const list = invoices.slice(0, 5).map(i => `  • ${i.number}: €${(i.total || 0).toFixed(2)}`).join('\n')
    return `🔴 Facturas vencidas:\n• Total: €${total.toFixed(2)}\n• Facturas: ${invoices.length}\n${list}`
  } catch {
    return 'No se pudo consultar las facturas vencidas.'
  }
}

async function fetchWhoOwes(): Promise<string> {
  try {
    const supabase = getSupabase()
    const { data: invoices } = await supabase
      .from('invoices').select('total, number, due_date, clients(name)')
      .in('status', ['sent', 'pending']).order('due_date', { ascending: true }).limit(8)
    if (!invoices || invoices.length === 0) return 'No hay cobros pendientes.'
    const lines = invoices.map(i => {
      const name = (i.clients as any)?.name || 'Cliente'
      const due = i.due_date ? new Date(i.due_date).toLocaleDateString('es-ES') : 'sin vencimiento'
      return `  • ${name}: €${(i.total || 0).toFixed(2)} (vence ${due})`
    })
    return `👥 Clientes que te deben:\n${lines.join('\n')}`
  } catch {
    return 'No se pudo consultar la lista de deudores.'
  }
}

async function fetchIncome(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await supabase
      .from('transactions').select('amount').eq('type', 'income').gte('created_at', startOfMonth)
    if (!txns || txns.length === 0) return 'No hay ingresos registrados este mes.'
    const total = txns.reduce((s, t) => s + (t.amount || 0), 0)
    return `📈 Ingresos este mes: €${total.toFixed(2)} (${txns.length} registros)`
  } catch {
    return 'No se pudo consultar los ingresos.'
  }
}

async function fetchExpenses(): Promise<string> {
  try {
    const supabase = getSupabase()
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const { data: txns } = await supabase
      .from('transactions').select('amount').eq('type', 'expense').gte('created_at', startOfMonth)
    if (!txns || txns.length === 0) return 'No hay gastos registrados este mes.'
    const total = txns.reduce((s, t) => s + (t.amount || 0), 0)
    return `📉 Gastos este mes: €${total.toFixed(2)} (${txns.length} registros)`
  } catch {
    return 'No se pudo consultar los gastos.'
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatImporteSimple(n: number): string {
  return `${Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

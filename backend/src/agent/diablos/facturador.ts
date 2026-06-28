/**
 * 🧾 El Facturador — Tu único trabajo es facturar correctamente.
 *
 * Maneja: crear factura, enviar factura, cambiar estado, facturas vencidas.
 */

import { createPendingAction } from '../confirmation'
import { getSupabase } from './index'
import { DIABLO_METAS } from './metas'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './metas'
import type { AgentInput } from '../core'

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId } = input
  const userInput = (input.text || '').trim()
  const supabase = getSupabase()

  // ── Facturas vencidas (READ) ──────────────────────────────────────────────
  if (classification.intent === 'facturas_vencidas') {
    return { replyText: await fetchOverdue(tenantId) }
  }

  // ── Cambiar estado factura ────────────────────────────────────────────────
  if (classification.intent === 'cambiar_estado') {
    let nuevoEstado = 'pagada'
    if (/vencid/i.test(userInput))       nuevoEstado = 'vencida'
    if (/anuld|cancel/i.test(userInput)) nuevoEstado = 'anulada'
    if (/pendiente/i.test(userInput))    nuevoEstado = 'pendiente'

    const mNum = userInput.match(/(?:#|factura\s+)?(\d{4}-\d{3,4})/i)
    let invoice: any = null

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

  // ── Crear / Enviar factura ────────────────────────────────────────────────
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

  // ── Búsqueda en catálogo de productos ─────────────────────────────────
  let productMatch: { name: string; price: number; iva_rate: number } | null = null
  if (concepto) {
    const { data: productos } = await supabase
      .from('products')
      .select('name, price, iva_rate')
      .eq('salon_id', tenantId)
      .eq('is_active', true)
      .ilike('name', `%${concepto}%`)
      .limit(1)
    if (productos && productos.length > 0) {
      productMatch = productos[0]
    }
  }

  if (productMatch && !importeNum) {
    const ivaRate = productMatch.iva_rate ?? 21
    importeNum = productMatch.price * (1 + ivaRate / 100)
    importeNum = Math.round(importeNum * 100) / 100
  }

  if (productMatch) {
    concepto = productMatch.name
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

  const ivaRate = productMatch?.iva_rate ?? 21
  const precioBase = importeNum / (1 + ivaRate / 100)

  const lineas = [{
    concepto,
    cantidad:        1,
    precio_unitario: Math.round(precioBase * 100) / 100,
    iva:             ivaRate,
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
  if (productMatch) params.producto_catalogo = productMatch.name

  const card = await createPendingAction(actionType, params, tenantId, userId)
  return { card }
}

// ── READ: facturas vencidas ─────────────────────────────────────────────────

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

export const FacturadorDiablo: DiabloHandler = {
  meta: DIABLO_METAS.facturador,
  handle,
}

/**
 * 💰 El Cobrador — Tu misión: que paguen.
 *
 * Maneja: recordatorios de cobro, quién debe, facturas vencidas (morosos).
 */

import { createPendingAction } from '../confirmation'
import { getSupabase } from './index'
import { DIABLO_METAS } from './metas'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './metas'
import type { AgentInput } from '../core'

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId } = input
  const userInput = (input.text || '').trim()

  // ── READ queries ──────────────────────────────────────────────────────────
  if (classification.intent === 'query_who_owes')  return { replyText: await fetchWhoOwes(tenantId) }
  if (classification.intent === 'query_overdue')   return { replyText: await fetchOverdue(tenantId) }
  if (classification.intent === 'query_debtors')   return { replyText: await fetchWhoOwes(tenantId) }
  if (classification.intent === 'query_pending')   return { replyText: await fetchPending(tenantId) }

  // ── Enviar recordatorio ───────────────────────────────────────────────────
  const supabase = getSupabase()
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

// ── READ fetchers ───────────────────────────────────────────────────────────

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

async function fetchPending(salonId: string): Promise<string> {
  try {
    const { data: invoices } = await getSupabase()
      .from('invoices').select('total, status').eq('salon_id', salonId).in('status', ['sent', 'pending'])
    if (!invoices?.length) return 'No hay cobros pendientes.'
    const total = invoices.reduce((s: number, i: any) => s + (i.total || 0), 0)
    return `Pendiente de cobro: Total EUR ${total.toFixed(2)} | Facturas: ${invoices.length}`
  } catch { return 'No se pudo consultar los cobros pendientes.' }
}

export const CobradorDiablo: DiabloHandler = {
  meta: DIABLO_METAS.cobrador,
  handle,
}

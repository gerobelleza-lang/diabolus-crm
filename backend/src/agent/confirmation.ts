// @ts-nocheck
/**
 * Gate de confirmación — el corazón del Bloque A.
 *
 * Flujo:
 *  1. El agente detecta una intención de escritura/envío.
 *  2. createPendingAction() → guarda con status 'pending' en agent_actions
 *     y devuelve ConfirmationCard para mostrar al usuario.
 *  3. Si el usuario confirma → executePendingAction() ejecuta la herramienta real.
 *  4. Si cancela → cancelPendingAction() marca como 'cancelled'.
 *
 * NUNCA se ejecuta ninguna escritura/envío sin confirmación explícita.
 * Reglas duras:
 *  - Idempotencia: confirmar 2 veces el mismo id no escribe 2 veces.
 *  - Caducidad: rechaza acciones expiradas (10 min).
 *  - Envíos (send): la tarjeta muestra preview del texto exacto a enviar.
 */

import { createClient } from '@supabase/supabase-js'
import { suggestCategory } from './tools'

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!
  )
}

function todayMadrid(): string {
  // Siempre usar zona horaria de Madrid para que medianoche no dé el día anterior
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' })
}
// backward compat
function today(): string { return todayMadrid() }

function formatDate(dateStr?: string): string {
  // Siempre formatear en zona Madrid para evitar off-by-one en servidor US East (iad1)
  // new Date("2026-06-18") = UTC midnight → en UTC-4 serían las 20h del día 17
  const d = dateStr ? new Date(dateStr) : new Date()
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid' })
}

function formatImporte(n: number): string {
  return `${Number(n).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ConfirmationCard {
  type: 'confirmation_card'
  action: string
  summary: string
  fields: Array<{ label: string; value: string }>
  preview?: string        // solo para acciones 'send': texto exacto que se va a mandar
  actions: ['confirmar', 'cancelar']
  pending_action_id: string
}

// ─── Card builders ─────────────────────────────────────────────────────────────

const SUMMARIES: Record<string, string> = {
  registrar_gasto:        '💸 Registrar gasto',
  registrar_ingreso:      '💰 Registrar ingreso',
  crear_cliente:          '👤 Crear cliente',
  crear_factura:          '🧾 Crear factura (borrador)',
  cambiar_estado_factura: '🔄 Cambiar estado de factura',
  enviar_recordatorio:    '📩 Enviar recordatorio de cobro',
  enviar_factura:         '📧 Crear factura y enviar al cliente',
}

function buildCardFields(
  actionType: string,
  p: Record<string, any>
): Array<{ label: string; value: string }> {
  const cat = p.categoria || suggestCategory(p.concepto || '')

  switch (actionType) {
    case 'registrar_gasto':
      return [
        { label: 'Importe',   value: formatImporte(p.importe) },
        { label: 'Concepto',  value: p.concepto || '—' },
        ...(p.proveedor ? [{ label: 'Proveedor', value: p.proveedor }] : []),
        { label: 'Fecha',     value: formatDate(p.fecha) },
        { label: 'Tipo',      value: p.es_gasto_empresa !== false ? 'Gasto de empresa ✓' : 'Gasto personal' },
        { label: 'Categoría', value: cat },
      ]

    case 'registrar_ingreso':
      return [
        { label: 'Importe',   value: formatImporte(p.importe) },
        { label: 'Concepto',  value: p.concepto || '—' },
        ...(p.cliente ? [{ label: 'Cliente', value: p.cliente }] : []),
        { label: 'Fecha',     value: formatDate(p.fecha) },
        { label: 'Categoría', value: p.categoria || 'servicios' },
      ]

    case 'crear_cliente':
      return [
        { label: 'Nombre',    value: p.nombre || '—' },
        ...(p.telefono ? [{ label: 'Teléfono', value: p.telefono }] : []),
        ...(p.email    ? [{ label: 'Email',    value: p.email    }] : []),
        ...(p.nif      ? [{ label: 'NIF/CIF',  value: p.nif      }] : []),
      ]

    case 'crear_factura': {
      const lineas = p.lineas || []
      const total = p.total || lineas.reduce((acc, l) => {
        const base = (l.cantidad || 1) * l.precio_unitario
        const iva  = base * ((l.iva || 21) / 100)
        return acc + base + iva
      }, 0)
      const lineasText = lineas.map(l =>
        `${l.concepto} × ${l.cantidad || 1} = ${formatImporte((l.cantidad || 1) * l.precio_unitario)}`
      ).join(' · ')
      return [
        { label: 'Cliente',     value: p.cliente_nombre || p.cliente || '—' },
        ...(p.cif_nif ? [{ label: 'CIF/NIF', value: p.cif_nif }] : []),
        { label: 'Líneas',      value: lineasText || '—' },
        { label: 'Total',       value: formatImporte(total) },
        { label: 'Fecha',       value: formatDate(p.fecha) },
        ...(p.vencimiento ? [{ label: 'Vencimiento', value: formatDate(p.vencimiento) }] : []),
      ]
    }

    case 'cambiar_estado_factura':
      return [
        { label: 'Factura',       value: p.factura_numero || p.factura_id || '—' },
        ...(p.cliente_nombre ? [{ label: 'Cliente', value: p.cliente_nombre }] : []),
        ...(p.importe        ? [{ label: 'Importe', value: formatImporte(p.importe) }] : []),
        { label: 'Estado actual', value: p.estado_actual || '—' },
        { label: 'Nuevo estado',  value: p.nuevo_estado  || '—' },
      ]

    case 'enviar_recordatorio':
      return [
        { label: 'Para',    value: `${p.cliente_nombre || '—'}${p.factura_numero ? ` (factura ${p.factura_numero})` : ''}${p.importe ? `, ${formatImporte(p.importe)}` : ''}` },
        { label: 'Canal',   value: p.canal === 'whatsapp' ? '📱 WhatsApp' : '📧 Email' },
      ]

    case 'enviar_factura': {
      const lineas = p.lineas || []
      const total = p.total || lineas.reduce((acc, l) => {
        const base = (l.cantidad || 1) * l.precio_unitario
        const iva  = base * ((l.iva || 21) / 100)
        return acc + base + iva
      }, 0)
      const lineasText = lineas.map(l =>
        `${l.concepto} × ${l.cantidad || 1} = ${formatImporte((l.cantidad || 1) * l.precio_unitario)}`
      ).join(' · ')
      return [
        { label: 'Cliente',  value: p.cliente_nombre || p.cliente || '—' },
        { label: 'Email',    value: p.cliente_email || '—' },
        ...(p.cif_nif ? [{ label: 'CIF/NIF', value: p.cif_nif }] : []),
        { label: 'Líneas',   value: lineasText || '—' },
        { label: 'Total',    value: formatImporte(total) },
        { label: 'Acción',   value: '🧾 Crear factura + 📧 Enviar email' },
      ]
    }

    default:
      return Object.entries(p)
        .filter(([k]) => !['cliente_id', 'factura_id'].includes(k))
        .map(([k, v]) => ({ label: k, value: String(v) }))
  }
}

// ─── Create pending action ─────────────────────────────────────────────────────

export async function createPendingAction(
  actionType: string,
  parameters: Record<string, any>,
  salonId: string,
  userId?: string
): Promise<ConfirmationCard> {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('agent_actions')
    .insert({
      action_type: actionType,
      parameters,
      status: 'pending',
      salon_id: salonId,
      user_id: userId || null,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create pending action: ${error?.message}`)
  }

  const card: ConfirmationCard = {
    type: 'confirmation_card',
    action: actionType,
    summary: SUMMARIES[actionType] || actionType,
    fields: buildCardFields(actionType, parameters),
    actions: ['confirmar', 'cancelar'],
    pending_action_id: data.id,
  }

  // Para envíos: incluir preview del texto exacto
  if (parameters.mensaje) {
    card.preview = parameters.mensaje
  }

  return card
}

// ─── Execute confirmed action ──────────────────────────────────────────────────

export async function executePendingAction(
  pendingActionId: string
): Promise<{ ok: boolean; message: string }> {
  const supabase = getSupabase()

  const { data: action, error } = await supabase
    .from('agent_actions')
    .select('*')
    .eq('id', pendingActionId)
    .eq('status', 'pending')
    .single()

  if (error || !action) {
    return { ok: false, message: 'Acción no encontrada o ya procesada.' }
  }

  // Idempotencia: si ya fue ejecutada, no volver a ejecutar
  if (action.status !== 'pending') {
    return { ok: false, message: `Esta acción ya fue ${action.status}.` }
  }

  // Caducidad
  if (new Date(action.expires_at) < new Date()) {
    await supabase
      .from('agent_actions')
      .update({ status: 'expired' })
      .eq('id', pendingActionId)
    return {
      ok: false,
      message: 'La confirmación ha expirado (10 min). Vuelve a enviar el mensaje.',
    }
  }

  // Marcar como ejecutado ANTES de ejecutar (previene doble ejecución por race condition)
  const { error: updateErr } = await supabase
    .from('agent_actions')
    .update({ status: 'executed', executed_at: new Date().toISOString() })
    .eq('id', pendingActionId)
    .eq('status', 'pending') // solo actualiza si sigue pending

  if (updateErr) {
    return { ok: false, message: 'No se pudo confirmar la acción. Inténtalo de nuevo.' }
  }

  // Ejecutar la herramienta
  let result: { ok: boolean; message: string }
  switch (action.action_type) {
    case 'registrar_gasto':
      result = await executeGasto(action.parameters, action.salon_id)
      break
    case 'registrar_ingreso':
      result = await executeIngreso(action.parameters, action.salon_id)
      break
    case 'crear_cliente':
      result = await executeCrearCliente(action.parameters, action.salon_id)
      break
    case 'crear_factura':
      result = await executeCrearFactura(action.parameters, action.salon_id)
      break
    case 'cambiar_estado_factura':
      result = await executeCambiarEstado(action.parameters, action.salon_id)
      break
    case 'enviar_recordatorio':
      result = await executeEnviarRecordatorio(action.parameters, action.salon_id)
      break
    case 'enviar_factura':
      result = await executeEnviarFactura(action.parameters, action.salon_id)
      break
    default:
      result = { ok: false, message: `Tipo de acción desconocida: ${action.action_type}` }
  }

  if (result.ok) {
    // Audit log (columnas reales: tool_name, payload, result, confirmed, level)
    await supabase.from('audit_log').insert({
      salon_id:  action.salon_id,
      tool_name: `agent_${action.action_type}`,
      payload:   action.parameters,
      result:    { ok: result.ok, message: result.message },
      confirmed: true,
      level:     1,
    })
  } else {
    // Si falló, revertir a pending para que el usuario pueda reintentar
    await supabase
      .from('agent_actions')
      .update({ status: 'pending', executed_at: null })
      .eq('id', pendingActionId)
  }

  return result
}

// ─── Cancel pending action ─────────────────────────────────────────────────────

export async function cancelPendingAction(
  pendingActionId: string
): Promise<{ ok: boolean }> {
  const supabase = getSupabase()
  await supabase
    .from('agent_actions')
    .update({ status: 'cancelled' })
    .eq('id', pendingActionId)
    .eq('status', 'pending')
  return { ok: true }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTORS
// ═══════════════════════════════════════════════════════════════════════════════

async function executeGasto(
  p: Record<string, any>,
  salonId: string
): Promise<{ ok: boolean; message: string }> {
  const supabase  = getSupabase()
  const categoria = p.categoria || suggestCategory(p.concepto || '')
  const desc      = p.proveedor ? `${p.concepto} (${p.proveedor})` : p.concepto

  const { error } = await supabase.from('transactions').insert({
    amount:   p.importe,
    type:     'expense',
    concept:  desc,
    date:     p.fecha || todayMadrid(),
    category: categoria,
    salon_id: salonId,
  })

  if (error) return { ok: false, message: `Error al guardar: ${error.message}` }
  return {
    ok: true,
    message: `✅ Gasto registrado\n• ${formatImporte(p.importe)} — ${p.concepto}\n• Categoría: ${categoria}\n• Fecha: ${formatDate(p.fecha)}`,
  }
}

async function executeIngreso(
  p: Record<string, any>,
  salonId: string
): Promise<{ ok: boolean; message: string }> {
  const supabase  = getSupabase()
  const categoria = p.categoria || 'servicios'
  const desc      = p.cliente ? `${p.concepto} — ${p.cliente}` : p.concepto

  const { error } = await supabase.from('transactions').insert({
    amount:   p.importe,
    type:     'income',
    concept:  desc,
    date:     p.fecha || todayMadrid(),
    category: categoria,
    salon_id: salonId,
  })

  if (error) return { ok: false, message: `Error al guardar: ${error.message}` }
  return {
    ok: true,
    message: `✅ Ingreso registrado\n• ${formatImporte(p.importe)} — ${p.concepto}${p.cliente ? `\n• Cliente: ${p.cliente}` : ''}\n• Fecha: ${formatDate(p.fecha)}`,
  }
}

async function executeCrearCliente(
  p: Record<string, any>,
  salonId: string
): Promise<{ ok: boolean; message: string }> {
  const supabase = getSupabase()

  // ¿Registro completo? Solo lo marcamos completo si tiene al menos phone o email
  const tieneContacto = !!(p.telefono || p.email)
  const recordatorio  = tieneContacto
    ? null
    : new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString() // +10 días

  const { data, error } = await supabase
    .from('clients')
    .insert({
      name:                     p.nombre,
      nombre_comercial:         p.nombre_comercial || null,
      phone:                    p.telefono         || null,
      email:                    p.email            || null,
      salon_id:                 salonId,
      registro_completo:        tieneContacto,
      recordatorio_registro_at: recordatorio,
    })
    .select('id')
    .single()

  if (error) return { ok: false, message: `Error al crear cliente: ${error.message}` }

  // nif opcional — columna puede no estar en schema cache, ignorar si falla
  if (data && p.nif) {
    await supabase.from('clients').update({ nif: p.nif }).eq('id', data.id).eq('salon_id', salonId)
  }

  const avisoIncompleto = tieneContacto
    ? ''
    : '\n⚠️ Registro pendiente de completar — te aviso en 10 días si no añades sus datos.'

  return {
    ok: true,
    message: `✅ Cliente creado\n• ${p.nombre}${p.nombre_comercial ? `\n• Negocio: ${p.nombre_comercial}` : ''}${p.telefono ? `\n• Tel: ${p.telefono}` : ''}${p.email ? `\n• Email: ${p.email}` : ''}${avisoIncompleto}`,
  }
}

async function executeCrearFactura(
  p: Record<string, any>,
  salonId: string
): Promise<{ ok: boolean; message: string }> {
  const supabase = getSupabase()

  // Calcular total
  const lineas = p.lineas || []
  let subtotal = 0
  let totalIva = 0
  for (const l of lineas) {
    const base = (l.cantidad || 1) * l.precio_unitario
    const iva  = base * ((l.iva !== undefined ? l.iva : 21) / 100)
    subtotal += base
    totalIva += iva
  }
  const total = subtotal + totalIva

  // Generar número de factura
  const year = new Date().getFullYear()
  const { count } = await supabase
    .from('invoices')
    .select('*', { count: 'exact', head: true })
    .eq('salon_id', salonId)
  const num = String((count || 0) + 1).padStart(3, '0')
  const invoiceNumber = `${year}-${num}`

  // Insertar cabecera
  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .insert({
      number:     invoiceNumber,
      client_id:  p.cliente_id || null,
      salon_id:   salonId,
      total:      total,
      status:     'pending',
      issue_date: p.fecha      || today(),
      due_date:   p.vencimiento || null,
    })
    .select('id')
    .single()

  if (invErr || !invoice) {
    return { ok: false, message: `Error al crear factura: ${invErr?.message}` }
  }

  // Insertar líneas
  if (lineas.length > 0) {
    const items = lineas.map(l => ({
      invoice_id:      invoice.id,
      concepto:        l.concepto,
      cantidad:        l.cantidad || 1,
      precio_unitario: l.precio_unitario,
      iva:             l.iva !== undefined ? l.iva : 21,
      subtotal:        (l.cantidad || 1) * l.precio_unitario,
      total_line:      (l.cantidad || 1) * l.precio_unitario * (1 + (l.iva !== undefined ? l.iva : 21) / 100),
    }))
    await supabase.from('invoice_items').insert(items)
  }

  // Si vino CIF/NIF y el cliente no lo tenía → actualizarlo
  if (p.cif_nif && p.cliente_id) {
    try {
      const { data: cl } = await supabase.from('clients').select('nif').eq('id', p.cliente_id).single()
      if (cl && !cl.nif) {
        await supabase.from('clients').update({ nif: p.cif_nif }).eq('id', p.cliente_id).eq('salon_id', salonId)
      }
    } catch {}
  }

  return {
    ok: true,
    message: `✅ Factura creada (borrador)\n• Número: ${invoiceNumber}\n• Cliente: ${p.cliente_nombre || p.cliente || '—'}\n• Total: ${formatImporte(total)}\n• Estado: pendiente`,
  }
}

async function executeCambiarEstado(
  p: Record<string, any>,
  salonId: string
): Promise<{ ok: boolean; message: string }> {
  const supabase = getSupabase()

  const updates: Record<string, any> = { status: p.nuevo_estado }
  if (p.nuevo_estado === 'pagada') {
    updates.paid_at = new Date().toISOString()
  }

  const { error } = await supabase
    .from('invoices')
    .update(updates)
    .eq('id', p.factura_id)
    .eq('salon_id', salonId)

  if (error) return { ok: false, message: `Error al actualizar: ${error.message}` }

  const estadoEmoji = {
    pagada:   '✅',
    pendiente:'⏳',
    vencida:  '🔴',
    anulada:  '❌',
  }[p.nuevo_estado] || '•'

  return {
    ok: true,
    message: `${estadoEmoji} Factura ${p.factura_numero || ''} marcada como *${p.nuevo_estado}*${p.cliente_nombre ? `\n• Cliente: ${p.cliente_nombre}` : ''}`,
  }
}

async function executeEnviarRecordatorio(
  p: Record<string, any>,
  salonId: string
): Promise<{ ok: boolean; message: string }> {
  const canal   = p.canal || 'whatsapp'
  const mensaje = p.mensaje || ''

  if (canal === 'whatsapp') {
    return enviarWhatsApp(p, mensaje)
  } else {
    return enviarEmail(p, mensaje)
  }
}

async function enviarWhatsApp(
  p: Record<string, any>,
  mensaje: string
): Promise<{ ok: boolean; message: string }> {
  const waToken   = process.env.WHATSAPP_ACCESS_TOKEN
  const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const to        = p.cliente_phone

  if (!waToken || !waPhoneId) {
    return { ok: false, message: 'WhatsApp no configurado (faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID).' }
  }
  if (!to) {
    return { ok: false, message: 'El cliente no tiene número de WhatsApp registrado.' }
  }

  // Normalizar número: solo dígitos, con prefijo 34 si no lo tiene
  const digits = to.replace(/[^0-9]/g, '')
  const phoneE164 = digits.startsWith('34') ? digits : `34${digits}`

  const resp = await fetch(
    `https://graph.facebook.com/v19.0/${waPhoneId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${waToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:                phoneE164,
        type:              'text',
        text:              { body: mensaje },
      }),
    }
  )

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as any
    return { ok: false, message: `Error WhatsApp: ${err?.error?.message || resp.status}` }
  }

  // Registrar sent_at en la factura
  if (p.factura_id) {
    const supabase = getSupabase()
    await supabase
      .from('invoices')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', p.factura_id)
  }

  return {
    ok: true,
    message: `✅ Recordatorio enviado por WhatsApp
• Para: ${p.cliente_nombre || phoneE164}
• Factura: ${p.factura_numero || '—'}`,
  }
}

async function enviarEmail(
  p: Record<string, any>,
  mensaje: string
): Promise<{ ok: boolean; message: string }> {
  const apiKey = process.env.RESEND_API_KEY
  const from   = process.env.FROM_EMAIL || 'Diabolus CRM <onboarding@resend.dev>'
  const to     = p.cliente_email

  if (!apiKey) {
    return { ok: false, message: 'Email no configurado (falta RESEND_API_KEY).' }
  }
  if (!to) {
    return { ok: false, message: 'El cliente no tiene email registrado.' }
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to:      [to],
      subject: `Recordatorio de pago${p.factura_numero ? ` — factura ${p.factura_numero}` : ''}`,
      text:    mensaje,
      html:    `<p>${mensaje.replace(/\n/g, '<br>')}</p>`,
    }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    return { ok: false, message: `Error email: ${err.message || resp.status}` }
  }

  if (p.factura_id) {
    const supabase = getSupabase()
    await supabase
      .from('invoices')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', p.factura_id)
  }

  return {
    ok: true,
    message: `✅ Recordatorio enviado por email\n• Para: ${p.cliente_nombre || to}\n• Factura: ${p.factura_numero || '—'}`,
  }
}

// ─── Enviar factura (crear + email en un paso) ─────────────────────────────────

async function executeEnviarFactura(
  p: Record<string, any>,
  salonId: string
): Promise<{ ok: boolean; message: string }> {
  const supabase = getSupabase()

  // 1. Calcular total
  const lineas = p.lineas || []
  let subtotal = 0
  let totalIva = 0
  for (const l of lineas) {
    const base = (l.cantidad || 1) * l.precio_unitario
    const iva  = base * ((l.iva !== undefined ? l.iva : 21) / 100)
    subtotal += base
    totalIva += iva
  }
  const total = p.total || subtotal + totalIva

  // 2. Generar número de factura
  const year = new Date().getFullYear()
  const { count } = await supabase
    .from('invoices')
    .select('*', { count: 'exact', head: true })
    .eq('salon_id', salonId)
  const num = String((count || 0) + 1).padStart(3, '0')
  const invoiceNumber = `${year}-${num}`

  // 3. Insertar cabecera
  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .insert({
      number:     invoiceNumber,
      client_id:  p.cliente_id || null,
      salon_id:   salonId,
      total:      total,
      status:     'sent',
      issue_date: p.fecha      || today(),
      due_date:   p.vencimiento || null,
      sent_at:    new Date().toISOString(),
    })
    .select('id')
    .single()

  if (invErr || !invoice) {
    return { ok: false, message: `Error al crear factura: ${invErr?.message}` }
  }

  // 4. Insertar líneas
  if (lineas.length > 0) {
    const items = lineas.map(l => ({
      invoice_id:      invoice.id,
      concepto:        l.concepto,
      cantidad:        l.cantidad || 1,
      precio_unitario: l.precio_unitario,
      iva:             l.iva !== undefined ? l.iva : 21,
      subtotal:        (l.cantidad || 1) * l.precio_unitario,
      total_line:      (l.cantidad || 1) * l.precio_unitario * (1 + (l.iva !== undefined ? l.iva : 21) / 100),
    }))
    await supabase.from('invoice_items').insert(items)
  }

  // 4b. Si vino CIF/NIF y el cliente no lo tenía → actualizarlo
  if (p.cif_nif && p.cliente_id) {
    try {
      const { data: cl } = await supabase.from('clients').select('nif').eq('id', p.cliente_id).single()
      if (cl && !cl.nif) {
        await supabase.from('clients').update({ nif: p.cif_nif }).eq('id', p.cliente_id).eq('salon_id', salonId)
      }
    } catch {}
  }

  // 5. Obtener email del cliente (puede venir en p.cliente_email o buscarlo en BD)
  let clienteEmail = p.cliente_email
  let clienteNombre = p.cliente_nombre || p.cliente || '—'
  let salonNombre = 'Tu negocio'

  if (!clienteEmail && p.cliente_id) {
    const { data: clientData } = await supabase
      .from('clients')
      .select('email, name')
      .eq('id', p.cliente_id)
      .single()
    if (clientData) {
      clienteEmail = clientData.email
      clienteNombre = clientData.name || clienteNombre
    }
  }

  // Obtener nombre del salón para el email
  const { data: salonData } = await supabase
    .from('salons')
    .select('name')
    .eq('id', salonId)
    .single()
  if (salonData) salonNombre = salonData.name

  if (!clienteEmail) {
    return {
      ok: true,
      message: `✅ Factura ${invoiceNumber} creada\n• Cliente: ${clienteNombre}\n• Total: ${formatImporte(total)}\n⚠️ No se pudo enviar: el cliente no tiene email registrado. Añádelo en Clientes.`,
    }
  }

  // 6. Enviar email via Resend
  const apiKey  = process.env.RESEND_API_KEY
  const fromEmail = process.env.FROM_EMAIL || 'Diabolus CRM <noreply@diabolus.es>'

  if (!apiKey) {
    return {
      ok: true,
      message: `✅ Factura ${invoiceNumber} creada\n• Cliente: ${clienteNombre}\n• Total: ${formatImporte(total)}\n⚠️ Email no enviado: falta configuración de email.`,
    }
  }

  // Construir líneas del email
  const lineasHtml = lineas.map(l => {
    const baseL = (l.cantidad || 1) * l.precio_unitario
    const ivaL  = baseL * ((l.iva !== undefined ? l.iva : 21) / 100)
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${l.concepto}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${l.cantidad || 1}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${formatImporte(baseL)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${l.iva !== undefined ? l.iva : 21}%</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${formatImporte(baseL + ivaL)}</td>
    </tr>`
  }).join('')

  const emailHtml = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <div style="background:#15101F;padding:28px 32px">
      <h1 style="color:#E3BE7A;margin:0;font-size:22px;font-weight:700">Diabolus CRM</h1>
      <p style="color:#8B5CF6;margin:6px 0 0;font-size:13px">${salonNombre}</p>
    </div>
    <div style="padding:32px">
      <h2 style="color:#15101F;margin:0 0 6px">Factura ${invoiceNumber}</h2>
      <p style="color:#666;margin:0 0 24px">Estimado/a ${clienteNombre},</p>
      <p style="color:#444;margin:0 0 20px">Te enviamos la siguiente factura para tu revisión:</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <thead>
          <tr style="background:#f9f9f9">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;text-transform:uppercase">Concepto</th>
            <th style="padding:8px 12px;text-align:center;font-size:12px;color:#888;text-transform:uppercase">Cant.</th>
            <th style="padding:8px 12px;text-align:right;font-size:12px;color:#888;text-transform:uppercase">Base</th>
            <th style="padding:8px 12px;text-align:right;font-size:12px;color:#888;text-transform:uppercase">IVA</th>
            <th style="padding:8px 12px;text-align:right;font-size:12px;color:#888;text-transform:uppercase">Total</th>
          </tr>
        </thead>
        <tbody>${lineasHtml || `<tr><td colspan="5" style="padding:8px 12px;color:#666">Servicios prestados</td></tr>`}</tbody>
      </table>
      <div style="text-align:right;padding:12px 0;border-top:2px solid #15101F">
        <span style="font-size:20px;font-weight:700;color:#15101F">${formatImporte(total)}</span>
      </div>
      <p style="color:#888;font-size:12px;margin-top:24px">Factura emitida el ${new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: 'long', year: 'numeric' })}.</p>
    </div>
    <div style="background:#f9f9f9;padding:16px 32px;text-align:center">
      <p style="color:#bbb;font-size:11px;margin:0">Gestionado con <strong>Diabolus CRM</strong> · <a href="https://diabolus.es" style="color:#8B5CF6">diabolus.es</a></p>
    </div>
  </div>
</body>
</html>`

  const emailText = `Factura ${invoiceNumber}\n\nEstimado/a ${clienteNombre},\n\nAdjuntamos tu factura:\n${lineas.map(l => `• ${l.concepto}: ${formatImporte((l.cantidad||1)*l.precio_unitario)}`).join('\n')}\n\nTotal: ${formatImporte(total)}\n\nGracias por confiar en ${salonNombre}.\n\nDiabolus CRM · diabolus.es`

  const resp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from:    fromEmail,
      to:      [clienteEmail],
      subject: `Factura ${invoiceNumber} — ${salonNombre}`,
      html:    emailHtml,
      text:    emailText,
    }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    return {
      ok: true,
      message: `✅ Factura ${invoiceNumber} creada\n• Cliente: ${clienteNombre}\n• Total: ${formatImporte(total)}\n⚠️ Email no enviado: ${err.message || resp.status}`,
    }
  }

  return {
    ok: true,
    message: `✅ Factura ${invoiceNumber} creada y enviada\n• Cliente: ${clienteNombre}\n• Email: ${clienteEmail}\n• Total: ${formatImporte(total)}\n• Estado: enviada`,
  }
}

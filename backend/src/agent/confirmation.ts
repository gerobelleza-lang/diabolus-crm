// @ts-nocheck
/**
 * Gate de confirmación — el corazón del Bloque A.
 *
 * Flujo:
 *  1. El agente detecta una intención de escritura.
 *  2. createPendingAction() → guarda la acción con status 'pending' en agent_actions
 *     y devuelve una ConfirmationCard para mostrar al usuario.
 *  3. Si el usuario confirma → executePendingAction() ejecuta la herramienta real.
 *  4. Si cancela → cancelPendingAction() marca la acción como 'cancelled'.
 *
 * NUNCA se ejecuta ninguna escritura sin confirmación explícita.
 */

import { createClient } from '@supabase/supabase-js'
import { suggestCategory } from './tools'

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!
  )
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function formatDate(dateStr?: string): string {
  const d = dateStr ? new Date(dateStr) : new Date()
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
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
  actions: ['confirmar', 'cancelar']
  pending_action_id: string
}

// ─── Card builders ─────────────────────────────────────────────────────────────

const SUMMARIES: Record<string, string> = {
  registrar_gasto:   '💸 Registrar gasto',
  registrar_ingreso: '💰 Registrar ingreso',
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
    default:
      return Object.entries(p).map(([k, v]) => ({ label: k, value: String(v) }))
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
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create pending action: ${error?.message}`)
  }

  return {
    type: 'confirmation_card',
    action: actionType,
    summary: SUMMARIES[actionType] || actionType,
    fields: buildCardFields(actionType, parameters),
    actions: ['confirmar', 'cancelar'],
    pending_action_id: data.id,
  }
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

  // Execute the tool
  let result: { ok: boolean; message: string }
  switch (action.action_type) {
    case 'registrar_gasto':
      result = await executeGasto(action.parameters, action.salon_id)
      break
    case 'registrar_ingreso':
      result = await executeIngreso(action.parameters, action.salon_id)
      break
    default:
      result = { ok: false, message: `Tipo de acción desconocida: ${action.action_type}` }
  }

  if (result.ok) {
    // Update action + write audit log in parallel
    await Promise.all([
      supabase
        .from('agent_actions')
        .update({ status: 'executed', executed_at: new Date().toISOString() })
        .eq('id', pendingActionId),
      supabase.from('audit_log').insert({
        salon_id: action.salon_id,
        user_id: action.user_id,
        action: `agent_${action.action_type}`,
        changes: action.parameters,
        created_at: new Date().toISOString(),
      }),
    ])
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

// ─── Executors ─────────────────────────────────────────────────────────────────

async function executeGasto(
  p: Record<string, any>,
  salonId: string
): Promise<{ ok: boolean; message: string }> {
  const supabase = getSupabase()
  const categoria = p.categoria || suggestCategory(p.concepto || '')
  const desc = p.proveedor ? `${p.concepto} (${p.proveedor})` : p.concepto

  const { error } = await supabase.from('transactions').insert({
    amount: p.importe,
    type: 'expense',
    description: desc,
    date: p.fecha || today(),
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
  const supabase = getSupabase()
  const categoria = p.categoria || 'servicios'
  const desc = p.cliente ? `${p.concepto} — ${p.cliente}` : p.concepto

  const { error } = await supabase.from('transactions').insert({
    amount: p.importe,
    type: 'income',
    description: desc,
    date: p.fecha || today(),
    category: categoria,
    salon_id: salonId,
  })

  if (error) return { ok: false, message: `Error al guardar: ${error.message}` }

  return {
    ok: true,
    message: `✅ Ingreso registrado\n• ${formatImporte(p.importe)} — ${p.concepto}${p.cliente ? `\n• Cliente: ${p.cliente}` : ''}\n• Fecha: ${formatDate(p.fecha)}`,
  }
}

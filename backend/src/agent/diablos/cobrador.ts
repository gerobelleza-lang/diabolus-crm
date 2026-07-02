/**
 * 💰 El Cobrador v2 — Arquitectura híbrida LLM + determinista
 *
 * 3 capas (misma plantilla que El Facturador v2):
 *
 * Capa 1 — Extractor LLM: interpreta qué quiere el usuario
 *          (enviar recordatorio, consultar deudores, pausar, etc.)
 *          Fallback a regex si el LLM falla.
 *
 * Capa 2 — Validación determinista: busca cliente/factura en BD,
 *          valida canal, formatea mensaje. NUNCA inventa contenido.
 *
 * Capa 3 — Preview + Gate: muestra preview exacto de lo que se
 *          enviará, solo ejecuta tras confirmación explícita.
 *
 * REGLA INNEGOCIABLE: enviar_recordatorio NUNCA ejecuta sin
 * confirmación explícita. Enforced por código (createPendingAction),
 * no por prompt.
 */

import { createPendingAction } from '../confirmation'
import { getSupabase } from './index'
import { DIABLO_METAS } from './metas'
import { callOpenRouter } from '../llm-router'
import { logDiabloUsage } from './metrics'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './metas'
import type { AgentInput } from '../core'

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — El Cobrador
// ═══════════════════════════════════════════════════════════════════════════════

const COBRADOR_SYSTEM_PROMPT = `Eres El Cobrador de Diabolus. Tu única misión: que te paguen lo que te deben.

PERSONALIDAD:
- Directo, sin rodeos: "Te deben 1.200€. ¿Mando aviso?"
- Datos primero, emoción después
- Siempre ofrece la acción inmediata

QUÉ HACES:
- Dices quién debe y cuánto (READ — sin gate)
- Muestras facturas vencidas con días de retraso (READ — sin gate)
- Envías recordatorios de cobro (WRITE — SIEMPRE con gate)
- Pausas/reanudas recordatorios de un cliente (WRITE — con gate)

REGLAS DE ORO:
1. NUNCA redactas mensajes de cobro propios — usas las plantillas del dueño
2. NUNCA envías sin confirmación explícita del usuario
3. Si falta información, preguntas: "¿A qué cliente?" o "¿Por email o WhatsApp?"
4. Muestras preview EXACTO del mensaje antes de pedir confirmación
5. Si el cliente no tiene canal disponible, lo dices y sugieres alternativa

FORMATO DE RESPUESTAS READ:
- Tabla clara: cliente | importe | días vencida | nivel
- Total pendiente al final
- Sugerencia de acción: "¿Mando aviso al top 3?"`.trim()

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 1 — EXTRACTOR LLM
// ═══════════════════════════════════════════════════════════════════════════════

const EXTRACTION_PROMPT = `Eres un extractor de intenciones de cobro. Tu ÚNICO trabajo es extraer datos estructurados del mensaje del usuario.

Devuelve SOLO un JSON válido con este schema:
{
  "accion": "enviar_recordatorio" | "consultar_deudores" | "consultar_vencidas" | "consultar_pendiente" | "pausar_recordatorios" | "reanudar_recordatorios",
  "cliente_nombre": string | null,
  "canal": "email" | "whatsapp" | "telegram" | null,
  "dias_pausa": number | null
}

Reglas:
- Si el usuario dice "manda recordatorio a Ana" → accion "enviar_recordatorio", cliente_nombre "Ana"
- Si dice "por email" o "por correo" → canal "email"
- Si dice "por whatsapp" o "por wa" → canal "whatsapp"
- Si dice "quién me debe" o "morosos" → accion "consultar_deudores"
- Si dice "facturas vencidas" → accion "consultar_vencidas"
- Si dice "pendiente de cobro" → accion "consultar_pendiente"
- Si dice "pausa recordatorios de Ana" → accion "pausar_recordatorios"
- Si dice "reanuda recordatorios de Ana" → accion "reanudar_recordatorios"
- Si un campo no está claro → null
- PROHIBIDO inventar datos
- Respuesta SOLO JSON, sin markdown, sin explicación`.trim()

interface CobradorExtraction {
  accion: string
  cliente_nombre: string | null
  canal: 'email' | 'whatsapp' | 'telegram' | null
  dias_pausa: number | null
}

async function extractWithLLM(userInput: string): Promise<CobradorExtraction | null> {
  try {
    const { text } = await callOpenRouter(
      'nousresearch/hermes-3-llama-3.1-70b',
      userInput,
      EXTRACTION_PROMPT,
      { temperature: 0, max_tokens: 200 }
    )

    const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    // Validate required field
    if (!parsed.accion) return null

    return {
      accion: parsed.accion,
      cliente_nombre: parsed.cliente_nombre || null,
      canal: parsed.canal || null,
      dias_pausa: parsed.dias_pausa || null,
    }
  } catch {
    return null
  }
}

function extractWithRegex(userInput: string): CobradorExtraction | null {
  const lower = userInput.toLowerCase()

  // Detect action
  let accion: string | null = null
  if (/(?:manda|envia|envía|env[ií]a|envi[aá]|lanza|mand[aá])\s*(?:un\s+)?recordatorio/i.test(lower) ||
      /recordatorio\s+(?:a|para|de)/i.test(lower) ||
      /cobra\s+a|avisa\s+a|reclama\s+a/i.test(lower)) {
    accion = 'enviar_recordatorio'
  } else if (/qui[eé]n\s+(?:me\s+)?debe|morosos?|deudores?|qui[eé]n\s+debe/i.test(lower)) {
    accion = 'consultar_deudores'
  } else if (/facturas?\s+vencid|vencid[ao]s?/i.test(lower)) {
    accion = 'consultar_vencidas'
  } else if (/pendiente\s+de\s+cobro|por\s+cobrar|me\s+deben/i.test(lower)) {
    accion = 'consultar_pendiente'
  } else if (/paus[ae]\s+(?:los\s+)?recordatorios?|deten\s+(?:los\s+)?aviso/i.test(lower)) {
    accion = 'pausar_recordatorios'
  } else if (/reanud[ae]\s+(?:los\s+)?recordatorios?|activ[ae]\s+(?:los\s+)?aviso/i.test(lower)) {
    accion = 'reanudar_recordatorios'
  }

  if (!accion) return null

  // Extract client name — context-aware patterns
  let cliente_nombre: string | null = null
  const NOISE = /\s+(?:por|un|una|el|la|los|las|que|con|sin|desde|hasta|\d+)\s*.*$/i

  if (accion === 'enviar_recordatorio') {
    // "recordatorio a Ana", "cobra a María López"
    const mAction = userInput.match(
      /(?:recordatorio|cobra|avisa|reclama)\s+(?:a|para)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑA-Z][a-záéíóúñ]+){0,3})/i
    )
    if (mAction) cliente_nombre = mAction[1].replace(NOISE, '').trim()
  } else if (accion === 'pausar_recordatorios' || accion === 'reanudar_recordatorios') {
    // "recordatorios de Ana García"
    const mPause = userInput.match(
      /(?:recordatorios?|avisos?)\s+(?:de|para)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/i
    )
    if (mPause) cliente_nombre = mPause[1].replace(NOISE, '').trim()
  }

  // Fallback: generic "a/para/de [Name]"
  if (!cliente_nombre) {
    const mGeneric = userInput.match(
      /(?:a|para|de)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2})/i
    )
    if (mGeneric) cliente_nombre = mGeneric[1].replace(NOISE, '').trim()
  }

  // Extract channel
  let canal: 'email' | 'whatsapp' | 'telegram' | null = null
  if (/email|correo|mail/i.test(lower)) canal = 'email'
  else if (/whatsapp|wa\b|wha\b/i.test(lower)) canal = 'whatsapp'
  else if (/telegram/i.test(lower)) canal = 'telegram'

  // Extract pause days
  let dias_pausa: number | null = null
  const mDias = lower.match(/(\d+)\s*d[ií]as?/)
  if (mDias) dias_pausa = parseInt(mDias[1])

  return { accion, cliente_nombre, canal, dias_pausa }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 2 — VALIDACIÓN DETERMINISTA
// ═══════════════════════════════════════════════════════════════════════════════

function formatImporte(n: number): string {
  return `${Number(n).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPA 3 — HANDLER CON PREVIEW + GATE
// ═══════════════════════════════════════════════════════════════════════════════

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId = 'unknown' } = input
  const userInput = (input.text || '').trim()

  // ── Capa 1: Extracción ──────────────────────────────────────────────────
  const startMs = Date.now()
  let extraction = await extractWithLLM(userInput)
  const llmWorked = !!extraction

  if (!extraction) {
    extraction = extractWithRegex(userInput)
  }

  if (!extraction) {
    // Use classification from router as last resort
    if (classification.intent === 'query_who_owes' || classification.intent === 'query_debtors') {
      extraction = { accion: 'consultar_deudores', cliente_nombre: null, canal: null, dias_pausa: null }
    } else if (classification.intent === 'query_overdue') {
      extraction = { accion: 'consultar_vencidas', cliente_nombre: null, canal: null, dias_pausa: null }
    } else if (classification.intent === 'query_pending') {
      extraction = { accion: 'consultar_pendiente', cliente_nombre: null, canal: null, dias_pausa: null }
    } else if (classification.intent === 'send_reminder') {
      extraction = { accion: 'enviar_recordatorio', cliente_nombre: null, canal: null, dias_pausa: null }
    } else {
      return { replyText: '¿Qué necesitas? Puedo decirte quién te debe, mandar un recordatorio, o pausar avisos.' }
    }
  }

  // Log LLM usage if applicable
  if (llmWorked) {
    logDiabloUsage(userId, tenantId, {
      diablo: 'cobrador',
      prompt_tokens: 200,
      completion_tokens: 50,
      response_ms: Date.now() - startMs,
    })
  }

  // ── Capa 2+3: Routing por acción ────────────────────────────────────────
  switch (extraction.accion) {
    case 'consultar_deudores':
      return { replyText: await fetchWhoOwes(tenantId) }

    case 'consultar_vencidas':
      return { replyText: await fetchOverdue(tenantId) }

    case 'consultar_pendiente':
      return { replyText: await fetchPending(tenantId) }

    case 'enviar_recordatorio':
      return await handleEnviarRecordatorio(extraction, tenantId, userId)

    case 'pausar_recordatorios':
      return await handlePausarRecordatorios(extraction, tenantId, userId)

    case 'reanudar_recordatorios':
      return await handleReanudarRecordatorios(extraction, tenantId, userId)

    default:
      return { replyText: '¿Qué necesitas? Puedo decirte quién te debe, mandar un recordatorio, o pausar avisos.' }
  }
}

// ── ENVIAR RECORDATORIO (write → gate obligatorio) ─────────────────────────

async function handleEnviarRecordatorio(
  extraction: CobradorExtraction,
  tenantId: string,
  userId: string
): Promise<DiabloResponse> {
  const supabase = getSupabase()

  // ── Validación: necesitamos cliente ──
  if (!extraction.cliente_nombre) {
    return { needsInfo: '¿A qué cliente quieres mandarle el recordatorio? Ej: "manda recordatorio a Ana"' }
  }

  // ── Buscar cliente en BD ──
  const { data: clientes } = await supabase
    .from('clients')
    .select('id, name, phone, email, cazador_paused_until')
    .eq('salon_id', tenantId)
    .ilike('name', `%${extraction.cliente_nombre}%`)
    .limit(5)

  if (!clientes?.length) {
    return { needsInfo: `No encontré al cliente "${extraction.cliente_nombre}". Revisa el nombre o prueba con otro.` }
  }

  // Si hay múltiples coincidencias, pedir clarificación
  if (clientes.length > 1) {
    const names = clientes.map(c => `  • ${c.name}`).join('\n')
    return { needsInfo: `Encontré varios clientes:\n${names}\n\n¿A cuál te refieres?` }
  }

  const cliente = clientes[0]

  // ── Check si recordatorios pausados ──
  if (cliente.cazador_paused_until) {
    const pauseDate = new Date(cliente.cazador_paused_until)
    const now = new Date()
    if (pauseDate > now && pauseDate.getFullYear() < 2999) {
      const fechaPausa = pauseDate.toLocaleDateString('es-ES')
      return {
        needsInfo: `⏸️ Los recordatorios de ${cliente.name} están pausados hasta el ${fechaPausa}. ¿Quieres reanudarlos?`,
      }
    }
    if (pauseDate.getFullYear() >= 2999) {
      return {
        needsInfo: `⏸️ ${cliente.name} está marcado como "en negociación" (pausado indefinidamente). ¿Quieres reanudar?`,
      }
    }
  }

  // ── Determinar canal ──
  const canal = extraction.canal || (cliente.phone ? 'whatsapp' : 'email')

  if (canal === 'whatsapp' && !cliente.phone) {
    return { needsInfo: `${cliente.name} no tiene WhatsApp registrado. ¿Lo enviamos por email?` }
  }
  if (canal === 'email' && !cliente.email) {
    return { needsInfo: `${cliente.name} no tiene email registrado. ¿Lo enviamos por WhatsApp?` }
  }

  // ── Buscar facturas pendientes/vencidas ──
  const { data: facturas } = await supabase
    .from('invoices')
    .select('id, number, total, due_date, status')
    .eq('salon_id', tenantId)
    .eq('client_id', cliente.id)
    .in('status', ['sent'])
    .order('due_date', { ascending: true })
    .limit(5)

  if (!facturas?.length) {
    return { needsInfo: `${cliente.name} no tiene facturas pendientes de pago. 🎉` }
  }

  // ── Calcular totales y construir mensaje ──
  const now = new Date()
  const totalDeuda = facturas.reduce((s, f) => s + (f.total || 0), 0)

  // Usar la factura más antigua (o la única)
  const factura = facturas[0]
  const dueDate = factura.due_date ? new Date(factura.due_date) : null
  const diasVencida = dueDate ? Math.floor((now.getTime() - dueDate.getTime()) / 86400000) : 0
  const vencimiento = dueDate
    ? dueDate.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : 'próximos días'

  // ── Buscar plantilla configurada por el dueño ──
  const { data: config } = await supabase
    .from('cazador_config')
    .select('*')
    .eq('salon_id', tenantId)
    .single()

  let mensaje: string
  if (config) {
    // Usar plantilla del dueño según nivel
    let level = 1
    if (diasVencida >= (config.level3_days || 7)) level = 3
    else if (diasVencida >= (config.level2_days || 3)) level = 2

    const template = level === 1 ? config.level1_msg
      : level === 2 ? config.level2_msg
      : config.level3_msg

    // Interpolación segura — SOLO variables aprobadas
    mensaje = interpolateTemplate(template || '', {
      nombre: cliente.name,
      importe: formatImporte(factura.total || 0),
      dias: String(diasVencida),
      numero: factura.number || factura.id.slice(0, 8),
      bizum: '', // se añade del salón
    })
  } else {
    // Plantilla por defecto (NO inventada por LLM)
    mensaje = `Hola ${cliente.name}, te recordamos que tienes pendiente de pago la factura ${factura.number || factura.id.slice(0, 8)} por importe de ${formatImporte(factura.total || 0)}. Fecha límite: ${vencimiento}. ¡Gracias!`
  }

  // ── CAPA 3: Preview + Gate ──────────────────────────────────────────────
  // NUNCA se ejecuta sin gate — createPendingAction es OBLIGATORIO
  const previewLines = [
    `📋 **Preview del recordatorio:**`,
    ``,
    `👤 **Cliente:** ${cliente.name}`,
    `📧 **Canal:** ${canal === 'whatsapp' ? '📱 WhatsApp' : canal === 'email' ? '📧 Email' : '💬 Telegram'}`,
    `🧾 **Factura:** ${factura.number || factura.id.slice(0, 8)}`,
    `💰 **Importe:** ${formatImporte(factura.total || 0)}`,
    `📅 **Vencimiento:** ${vencimiento}`,
    diasVencida > 0 ? `⏰ **Días vencida:** ${diasVencida}` : '',
    facturas.length > 1 ? `⚠️ **Tiene ${facturas.length} facturas pendientes** (total: ${formatImporte(totalDeuda)})` : '',
    ``,
    `📝 **Mensaje exacto que se enviará:**`,
    `"${mensaje}"`,
  ].filter(Boolean)

  const card = await createPendingAction('enviar_recordatorio', {
    factura_id: factura.id,
    factura_numero: factura.number || factura.id.slice(0, 8),
    cliente_nombre: cliente.name,
    cliente_phone: cliente.phone || null,
    cliente_email: cliente.email || null,
    importe: factura.total,
    canal,
    mensaje,
  }, tenantId, userId)

  return {
    replyText: previewLines.join('\n'),
    card,
  }
}

// ── PAUSAR RECORDATORIOS (write → gate) ────────────────────────────────────

async function handlePausarRecordatorios(
  extraction: CobradorExtraction,
  tenantId: string,
  userId: string
): Promise<DiabloResponse> {
  if (!extraction.cliente_nombre) {
    return { needsInfo: '¿De qué cliente quieres pausar los recordatorios?' }
  }

  const supabase = getSupabase()
  const { data: clientes } = await supabase
    .from('clients')
    .select('id, name, cazador_paused_until')
    .eq('salon_id', tenantId)
    .ilike('name', `%${extraction.cliente_nombre}%`)
    .limit(1)

  if (!clientes?.length) {
    return { needsInfo: `No encontré al cliente "${extraction.cliente_nombre}".` }
  }

  const cliente = clientes[0]
  const dias = extraction.dias_pausa || 3
  const pauseUntil = new Date(Date.now() + dias * 24 * 60 * 60 * 1000)

  // Gate: crear pending action para la pausa
  const card = await createPendingAction('pausar_cazador', {
    cliente_id: cliente.id,
    cliente_nombre: cliente.name,
    dias_pausa: dias,
    pause_until: pauseUntil.toISOString(),
  }, tenantId, userId)

  return {
    replyText: `⏸️ Pausar recordatorios de **${cliente.name}** durante ${dias} días (hasta ${pauseUntil.toLocaleDateString('es-ES')}). ¿Confirmas?`,
    card,
  }
}

// ── REANUDAR RECORDATORIOS ─────────────────────────────────────────────────

async function handleReanudarRecordatorios(
  extraction: CobradorExtraction,
  tenantId: string,
  userId: string
): Promise<DiabloResponse> {
  if (!extraction.cliente_nombre) {
    return { needsInfo: '¿De qué cliente quieres reanudar los recordatorios?' }
  }

  const supabase = getSupabase()
  const { data: clientes } = await supabase
    .from('clients')
    .select('id, name, cazador_paused_until')
    .eq('salon_id', tenantId)
    .ilike('name', `%${extraction.cliente_nombre}%`)
    .limit(1)

  if (!clientes?.length) {
    return { needsInfo: `No encontré al cliente "${extraction.cliente_nombre}".` }
  }

  const cliente = clientes[0]

  if (!cliente.cazador_paused_until) {
    return { replyText: `Los recordatorios de ${cliente.name} ya están activos. 🟢` }
  }

  const card = await createPendingAction('reanudar_cazador', {
    cliente_id: cliente.id,
    cliente_nombre: cliente.name,
  }, tenantId, userId)

  return {
    replyText: `🟢 Reanudar recordatorios de **${cliente.name}** ¿Confirmas?`,
    card,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERPOLACIÓN SEGURA DE PLANTILLAS
// ═══════════════════════════════════════════════════════════════════════════════

// Whitelist de variables permitidas — NUNCA se permite inyectar contenido libre
const ALLOWED_TEMPLATE_VARS = new Set(['nombre', 'importe', 'dias', 'numero', 'bizum'])

function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (!ALLOWED_TEMPLATE_VARS.has(key)) return match // Variable no permitida → dejar literal
    return vars[key] ?? match
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// READ FETCHERS (sin gate — solo lectura)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchWhoOwes(salonId: string): Promise<string> {
  try {
    const supabase = getSupabase()
    const today = new Date().toISOString().split('T')[0]

    const { data: invoices } = await supabase
      .from('invoices')
      .select('total, due_date, status, clients(name)')
      .eq('salon_id', salonId)
      .in('status', ['sent'])
      .order('total', { ascending: false })
      .limit(15)

    if (!invoices?.length) return '🎉 No hay deudores — todo al día.'

    const now = new Date()
    const lines = invoices.map((i: any) => {
      const name = (i.clients as any)?.name || 'Cliente'
      const due = i.due_date ? new Date(i.due_date) : null
      const dias = due ? Math.floor((now.getTime() - due.getTime()) / 86400000) : 0
      const vencida = dias > 0
      const emoji = vencida ? (dias > 7 ? '🔴' : dias > 3 ? '🟠' : '🟡') : '⚪'
      const dueStr = due ? due.toLocaleDateString('es-ES') : 'sin fecha'
      return `${emoji} ${name}: ${formatImporte(i.total || 0)}${vencida ? ` · ${dias}d vencida` : ` · vence ${dueStr}`}`
    })

    const total = invoices.reduce((s, i: any) => s + (i.total || 0), 0)

    return [
      `💰 **Clientes que te deben:**`,
      '',
      ...lines,
      '',
      `**Total pendiente: ${formatImporte(total)}**`,
      '',
      `¿Mando recordatorio a alguno? Ej: "manda recordatorio a [nombre]"`,
    ].join('\n')
  } catch {
    return 'No se pudo consultar la lista de deudores.'
  }
}

async function fetchOverdue(salonId: string): Promise<string> {
  try {
    const supabase = getSupabase()
    const today = new Date().toISOString().split('T')[0]

    const { data: invoices } = await supabase
      .from('invoices')
      .select('total, number, due_date, clients(name)')
      .eq('salon_id', salonId)
      .in('status', ['sent'])
      .lt('due_date', today)
      .order('due_date', { ascending: true })

    if (!invoices?.length) return '🎉 No hay facturas vencidas.'

    const now = new Date()
    const total = invoices.reduce((s, i: any) => s + (i.total || 0), 0)

    const lines = invoices.slice(0, 10).map((i: any) => {
      const dias = Math.floor((now.getTime() - new Date(i.due_date).getTime()) / 86400000)
      const emoji = dias > 7 ? '🔴' : dias > 3 ? '🟠' : '🟡'
      const name = (i.clients as any)?.name || 'Sin cliente'
      return `${emoji} ${i.number}: ${formatImporte(i.total || 0)} — ${name} · ${dias}d`
    })

    return [
      `📋 **Facturas vencidas:** ${invoices.length}`,
      `💰 **Total: ${formatImporte(total)}**`,
      '',
      ...lines,
      invoices.length > 10 ? `\n... y ${invoices.length - 10} más` : '',
    ].filter(Boolean).join('\n')
  } catch {
    return 'No se pudo consultar las facturas vencidas.'
  }
}

async function fetchPending(salonId: string): Promise<string> {
  try {
    const { data: invoices } = await getSupabase()
      .from('invoices')
      .select('total, status')
      .eq('salon_id', salonId)
      .in('status', ['sent'])

    if (!invoices?.length) return '🎉 No hay cobros pendientes.'

    const total = invoices.reduce((s, i: any) => s + (i.total || 0), 0)

    return `💰 **Pendiente de cobro:** ${formatImporte(total)} en ${invoices.length} factura(s).`
  } catch {
    return 'No se pudo consultar los cobros pendientes.'
  }
}

// ═══════════════════════════════════════════════════════════════════════════════

export const CobradorDiablo: DiabloHandler = {
  meta: DIABLO_METAS.cobrador,
  handle,
}

/**
 * core.ts — Diablilla: la jefa de orquesta 🔥
 *
 * v3 — 28 Jun 2026: Arquitectura Los Diablos
 *
 * Diablilla ya no hace todo. Ahora clasifica, delega y envuelve.
 * El cliente habla SOLO con ella, pero ve qué Diablo trabajó.
 *
 * Flujo:
 *  action_response → executePendingAction | cancelPendingAction
 *  image           → El Contable (ticket photos)
 *  text            → classifyIntent → Diablo.handle() → wrapWithTag
 *
 * PRINCIPIO: nunca escribe ni envía sin confirmación explícita.
 */

import { parseUserInput }                             from './parser'
import { routeToLLM, callOpenRouter, buildSystemPrompt, getTimeContext, generateProactiveInsights } from './llm-router'
import { createClient }                                from '@supabase/supabase-js'
import { createPendingAction, executePendingAction, cancelPendingAction } from './confirmation'
import type { ConfirmationCard }                       from './confirmation'
import {
  saveMessage,
  buildMemoryContext,
  shouldGenerateSummary,
  generateAndStoreSummary,
  getSalonAIConfig,
} from './memory'
import type { BrainTier } from './memory'

// ── Los Diablos ─────────────────────────────────────────────────────────────
import { DIABLOS, DIABLO_TAGS, classifyIntent } from './diablos/index'
import type { DiabloName, IntentClassification } from './diablos/index'
import { getDashboardContext } from './diablos/guardian'

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
  diablo?:        DiabloName | 'diablilla'
  diablo_emoji?:  string
  diablo_label?:  string
}

// ─── Supabase ────────────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!
  )
}

// ─── Channel link helpers ────────────────────────────────────────────────────

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
  // Save user message to memory
  if (input.type === 'text' && input.text) {
    saveMessage({
      salon_id: input.tenantId,
      user_id:  input.userId || null,
      channel:  input.channel,
      role:     'user',
      content:  input.text,
    }).catch(() => {})
  }

  const result = await processAgentInputInternal(input)

  // Save assistant response to memory
  const replyContent = result.replyText || result.needsInfo || result.card?.summary || ''
  if (replyContent && input.type !== 'action_response') {
    saveMessage({
      salon_id: input.tenantId,
      user_id:  input.userId || null,
      channel:  input.channel,
      role:     'assistant',
      content:  replyContent,
    }).catch(() => {})

    shouldGenerateSummary(input.tenantId)
      .then(needed => { if (needed) generateAndStoreSummary(input.tenantId) })
      .catch(() => {})
  }

  return result
}

// ─── Internal: Classify → Delegate → Wrap ────────────────────────────────────

async function processAgentInputInternal(input: AgentInput): Promise<AgentOutput> {
  const { tenantId, type, userId } = input

  // ── 1. Confirm / Cancel (stays in core — no Diablo needed) ────────────────
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

  // ── 2. Image → El Contable ────────────────────────────────────────────────
  if (type === 'image') {
    const classification: IntentClassification = { diablo: 'contable', intent: 'image_ticket', confidence: 1 }
    const response = await DIABLOS.contable.handle(input, classification)
    return wrapResponse(response, 'contable')
  }

  // ── 3. Text → Classify → Delegate ────────────────────────────────────────
  const userInput = (input.text || '').trim()
  if (!userInput) return { needsInfo: '¿Qué necesitas? Escribe "ayuda" para ver los comandos.' }

  // Run parser
  const parsed = parseUserInput(userInput)

  // Classify intent to a Diablo
  const classification = classifyIntent(userInput, parsed.intent, parsed.confidence)

  // ── Diablilla herself handles greetings ───────────────────────────────────
  if (classification.diablo === 'diablilla') {
    return handleGreeting(userInput)
  }

  // ── Delegate to the appropriate Diablo ────────────────────────────────────
  const diabloName = classification.diablo as DiabloName
  const diablo = DIABLOS[diabloName]

  if (!diablo) {
    // Safety fallback — should never happen
    return DIABLOS.confesor.handle(input, { diablo: 'confesor', intent: 'general', confidence: 0.5 })
  }

  const response = await diablo.handle(input, classification)

  // ── For unclear intents that El Confesor couldn't handle with confidence,
  //    try the LLM fallback (Guardian-style with full context) ────────────────
  if (
    diabloName === 'confesor' &&
    classification.confidence < 0.5 &&
    !response.replyText?.includes('Confesor') &&
    !response.card
  ) {
    return await handleLLMFallback(userInput, tenantId, parsed, classification)
  }

  return wrapResponse(response, diabloName)
}

// ─── Greeting handler (Diablilla herself) ────────────────────────────────────

function handleGreeting(userInput: string): AgentOutput {
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
  return { replyText: greeting, diablo: 'diablilla', diablo_emoji: '🔥', diablo_label: 'Diablilla' }
}

// ─── LLM fallback (full context, for truly unclear queries) ──────────────────

async function handleLLMFallback(
  userInput: string,
  tenantId: string,
  parsed: { intent: string; confidence: number },
  classification: IntentClassification
): Promise<AgentOutput> {
  try {
    const aiConfig = await getSalonAIConfig(tenantId)
    const brainTier: BrainTier = aiConfig.brain_tier || 'rapida'
    const routing = routeToLLM(parsed.confidence, userInput, false, brainTier)

    const [memoryCtx, dashData] = await Promise.all([
      buildMemoryContext(tenantId),
      getDashboardContext(tenantId),
    ])

    const systemPrompt = buildSystemPrompt(routing.label, memoryCtx, dashData.text, userInput)
    let finalResponse = await callOpenRouter(routing.model, userInput, systemPrompt)

    // Proactive insight from El Guardián (30% chance)
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

    return {
      replyText: finalResponse,
      routing: {
        level: routing.level,
        model: routing.model,
        label: routing.label,
        estimatedCost: `€${routing.estimatedCost}`,
      },
      diablo: 'diablilla',
      diablo_emoji: '🔥',
      diablo_label: 'Diablilla',
    }
  } catch {
    return {
      replyText: 'No te he entendido del todo. ¿Puedes reformularlo? O escribe "ayuda" para ver lo que puedo hacer.',
      diablo: 'confesor',
      diablo_emoji: '🪞',
      diablo_label: 'El Confesor',
    }
  }
}

// ─── Wrap response with Diablo tag ───────────────────────────────────────────

function wrapResponse(response: any, diabloName: DiabloName): AgentOutput {
  const tag = DIABLO_TAGS[diabloName]
  const meta = DIABLOS[diabloName]?.meta

  const output: AgentOutput = {
    ...response,
    diablo: diabloName,
    diablo_emoji: meta?.emoji || '😈',
    diablo_label: meta?.displayName || diabloName,
  }

  // Append tag to replyText if present (not for cards/needsInfo — those show in the UI differently)
  if (output.replyText && !output.card) {
    output.replyText = `${output.replyText}\n\n<small>${tag}</small>`
  }

  // For cards, add diablo info to the summary
  if (output.card) {
    output.card.summary = `${meta?.emoji || '😈'} ${meta?.displayName || ''} — ${output.card.summary}`
  }

  return output
}

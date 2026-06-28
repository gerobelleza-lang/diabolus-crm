/**
 * LLM Router — Sistema de 3 Cerebros de Diablilla v2
 *
 * Cerebros:
 *  🧠 Rápida     → Gemini 2.5 Flash  (incluida en todos los planes)
 *  🧠 Inteligente → GPT-4.1 Mini     (incluida en El Pacto / El Infierno)
 *  🧠 Brillante  → Claude Sonnet 4   (incluida en El Infierno)
 *
 * v2 — 27 Jun 2026:
 *  ✅ Personalidad V2 con contexto temporal, tono adaptativo e insights proactivos
 *  ✅ buildSystemPrompt ahora usa buildSystemPromptV2 internamente
 */

import type { BrainTier } from './memory'
import {
  buildSystemPromptV2,
  getTimeContext,
  generateProactiveInsights,
  detectTone,
} from './diablilla-personality'
import type { TimeContext, ProactiveInsight, DiablillaTone } from './diablilla-personality'

// Re-export personality utilities for use in core.ts
export { getTimeContext, generateProactiveInsights, detectTone }
export type { TimeContext, ProactiveInsight, DiablillaTone }

// ─── Model map ────────────────────────────────────────────────────────────────

export const BRAIN_MODELS: Record<BrainTier, { model: string; label: string; costPerMTok: number }> = {
  rapida: {
    model: 'google/gemini-2.5-flash',
    label: '🧠 Diablilla Rápida',
    costPerMTok: 0.15,
  },
  inteligente: {
    model: 'openai/gpt-4.1-mini',
    label: '🧠 Diablilla Inteligente',
    costPerMTok: 0.40,
  },
  brillante: {
    model: 'anthropic/claude-sonnet-4',
    label: '🧠 Diablilla Brillante',
    costPerMTok: 3.00,
  },
}

// ─── Routing decision ─────────────────────────────────────────────────────────

export interface RoutingDecision {
  level: 'L0' | 'L1' | 'L2'
  model: string
  label: string
  rationale: string
  estimatedCost: number
}

export function routeToLLM(
  parserConfidence: number,
  userInput: string,
  needsTools: boolean,
  brainTier: BrainTier = 'rapida'
): RoutingDecision {
  // L0: parser is confident enough — no LLM needed
  if (parserConfidence > 0.85 && !needsTools) {
    return {
      level: 'L0',
      model: 'parser',
      label: 'Parser L0',
      rationale: 'Parser confident (>85%). No LLM needed.',
      estimatedCost: 0,
    }
  }

  const brain = BRAIN_MODELS[brainTier] || BRAIN_MODELS.rapida

  // L1: simple queries — still use the salon's chosen brain
  if (parserConfidence > 0.7 && userInput.length < 80) {
    return {
      level: 'L1',
      model: brain.model,
      label: brain.label,
      rationale: `Parser semi-confident. Using ${brain.label}.`,
      estimatedCost: brain.costPerMTok * 0.001,
    }
  }

  // L2: everything else — use the salon's chosen brain
  return {
    level: 'L2',
    model: brain.model,
    label: brain.label,
    rationale: `Full LLM call. Using ${brain.label}.`,
    estimatedCost: brain.costPerMTok * 0.005,
  }
}

// ─── OpenRouter call ──────────────────────────────────────────────────────────

export async function callOpenRouter(
  model: string,
  userMessage: string,
  systemPrompt?: string,
  options?: { temperature?: number; max_tokens?: number }
): Promise<{ text: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; model_used: string } | null }> {
  const apiKey = process.env.OPENROUTER_API_KEY

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set.')
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://diabolus.es',
      'X-Title': 'Diabolus CRM',
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: userMessage },
      ],
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.max_tokens ?? 800,
    }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText)
    throw new Error(`OpenRouter error (${response.status}): ${errText}`)
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; model?: string }
  const text = data.choices?.[0]?.message?.content || 'No response from LLM'
  const usage = data.usage ? {
    prompt_tokens: data.usage.prompt_tokens || 0,
    completion_tokens: data.usage.completion_tokens || 0,
    total_tokens: data.usage.total_tokens || 0,
    model_used: data.model || model
  } : null
  return { text, usage }
}

// ─── System prompt builder (v2 — personality-aware) ───────────────────────────

export function buildSystemPrompt(
  brainLabel: string,
  memoryContext: string,
  dashboardContext: string,
  userInput?: string
): string {
  const timeContext = getTimeContext()
  const insights = generateProactiveInsights({
    timeContext,
    // Dashboard data will be parsed from dashboardContext if available
  })
  const tone = detectTone(userInput || '', timeContext, insights)

  return buildSystemPromptV2({
    brainLabel,
    memoryContext,
    dashboardContext,
    timeContext,
    insights,
    tone,
  })
}

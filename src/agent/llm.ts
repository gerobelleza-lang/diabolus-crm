// Cliente LLM vía OpenRouter con tool calling nativo (niveles 1-3).
// Sin OPENROUTER_API_KEY el servidor sigue funcionando: el nivel 0 (parser)
// opera igual y los niveles 1-3 devuelven un aviso claro.

import type { RouteLevel, ToolCall } from './types.js';
import { toolDefinitionsForLLM } from './tools/schemas.js';

export function buildSystemPrompt(opts: {
  businessName: string;
  businessProfile: string;
  today: string;
  rollingSummary?: string;
}): string {
  return `Eres el agente operativo de ${opts.businessName}.
Perfil del negocio: ${opts.businessProfile}
Fecha actual: ${opts.today}

REGLAS DURAS:
1. Solo actúas mediante tools. Nunca inventes datos financieros ni IDs.
2. Importe ambiguo o ausente → pregunta. Nunca adivines dinero.
3. Cliente ambiguo (varios matches de find_client) → pregunta mostrando opciones.
4. Fechas relativas ("ayer", "el martes") → resuélvelas con get_date ANTES de cualquier escritura.
5. Las acciones de escritura las confirma el usuario en la interfaz: tú solo propones la tool call.
6. Peticiones fuera del negocio → redirige en una frase.
7. Responde en español, máximo 2 frases antes de la tool call.${opts.rollingSummary ? `\n\nMEMORIA DE SESIÓN: ${opts.rollingSummary}` : ''}`;
}

interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface LLMTurn {
  text: string | null;
  toolCalls: Array<ToolCall & { id: string }>;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function modelForLevel(level: RouteLevel): string {
  const small = process.env.MODEL_SMALL || 'openai/gpt-4.1-mini';
  const large = process.env.MODEL_LARGE || 'anthropic/claude-sonnet-4';
  return level >= 3 ? large : small;
}

export async function callLLM(level: RouteLevel, messages: LLMMessage[]): Promise<LLMTurn> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      text: 'Niveles 1-3 desactivados: falta OPENROUTER_API_KEY en .env.local. El nivel 0 (frases tipo "ingreso 50 corte María") funciona sin clave.',
      toolCalls: [],
    };
  }

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelForLevel(level),
      messages,
      tools: toolDefinitionsForLLM(),
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 600,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenRouter ${response.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: LLMMessage }>;
  };
  const message = data.choices?.[0]?.message;
  const toolCalls = (message?.tool_calls || []).map((tc) => ({
    id: tc.id,
    tool: tc.function.name as ToolCall['tool'],
    args: safeParseJSON(tc.function.arguments),
  }));

  return { text: message?.content ?? null, toolCalls };
}

function safeParseJSON(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export type { LLMMessage };

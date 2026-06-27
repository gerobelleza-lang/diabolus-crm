/**
 * memory.ts — Sistema de memoria conversacional de Diablilla
 *
 * Cada mensaje se guarda en conversation_history.
 * Cada 20 mensajes se genera un resumen comprimido.
 * Al iniciar sesión, se inyectan los últimos mensajes + resúmenes.
 *
 * Usa fetch directo a Supabase REST API (Edge Runtime compatible).
 * NO usa @supabase/supabase-js.
 */

// ─── Supabase REST helpers ────────────────────────────────────────────────────

function supabaseUrl(): string {
  return process.env.SUPABASE_URL || ''
}
function supabaseKey(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ''
}
function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: supabaseKey(),
    Authorization: `Bearer ${supabaseKey()}`,
    ...extra,
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversationMessage {
  id?: string
  salon_id: string
  user_id?: string | null
  channel: 'web' | 'telegram' | 'whatsapp'
  role: 'user' | 'assistant'
  content: string
  metadata?: Record<string, unknown>
  created_at?: string
}

export interface ConversationSummary {
  id?: string
  salon_id: string
  summary: string
  message_count: number
  period_start: string
  period_end: string
  created_at?: string
}

// ─── Save message ─────────────────────────────────────────────────────────────

export async function saveMessage(
  msg: Omit<ConversationMessage, 'id' | 'created_at'>
): Promise<void> {
  try {
    await fetch(`${supabaseUrl()}/rest/v1/conversation_history`, {
      method: 'POST',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        salon_id: msg.salon_id,
        user_id: msg.user_id || null,
        channel: msg.channel,
        role: msg.role,
        content: msg.content,
        metadata: msg.metadata || {},
      }),
    })
  } catch (err) {
    console.warn('[Memory] Error saving message:', err)
  }
}

// ─── Load recent messages ─────────────────────────────────────────────────────

export async function loadRecentMessages(
  salonId: string,
  limit: number = 10
): Promise<ConversationMessage[]> {
  try {
    const url = `${supabaseUrl()}/rest/v1/conversation_history` +
      `?salon_id=eq.${salonId}` +
      `&order=created_at.desc` +
      `&limit=${limit}` +
      `&select=id,salon_id,user_id,channel,role,content,created_at`
    const res = await fetch(url, { headers: headers() })
    if (!res.ok) return []
    const data = (await res.json()) as ConversationMessage[]
    return data.reverse() // oldest first for context injection
  } catch {
    return []
  }
}

// ─── Load summaries ───────────────────────────────────────────────────────────

export async function loadSummaries(
  salonId: string,
  limit: number = 3
): Promise<ConversationSummary[]> {
  try {
    const url = `${supabaseUrl()}/rest/v1/conversation_summaries` +
      `?salon_id=eq.${salonId}` +
      `&order=created_at.desc` +
      `&limit=${limit}` +
      `&select=id,salon_id,summary,message_count,period_start,period_end,created_at`
    const res = await fetch(url, { headers: headers() })
    if (!res.ok) return []
    return (await res.json()) as ConversationSummary[]
  } catch {
    return []
  }
}

// ─── Build memory context string ──────────────────────────────────────────────

export async function buildMemoryContext(salonId: string): Promise<string> {
  const [summaries, recentMessages] = await Promise.all([
    loadSummaries(salonId, 3),
    loadRecentMessages(salonId, 10),
  ])

  if (summaries.length === 0 && recentMessages.length === 0) {
    return '' // No memory yet — first interaction
  }

  const parts: string[] = ['\n# MI MEMORIA — LO QUE RECUERDO']

  if (summaries.length > 0) {
    parts.push('\n## Resúmenes de conversaciones anteriores')
    for (const s of summaries.reverse()) {
      const start = new Date(s.period_start).toLocaleDateString('es-ES', {
        day: '2-digit', month: 'short', timeZone: 'Europe/Madrid',
      })
      const end = new Date(s.period_end).toLocaleDateString('es-ES', {
        day: '2-digit', month: 'short', timeZone: 'Europe/Madrid',
      })
      parts.push(`[${start} → ${end}]: ${s.summary}`)
    }
  }

  if (recentMessages.length > 0) {
    parts.push('\n## Últimos mensajes de esta sesión')
    for (const m of recentMessages) {
      const who = m.role === 'user' ? 'Jefe' : 'Diablilla'
      // Truncate to keep context window manageable
      const content = m.content.length > 250
        ? m.content.substring(0, 250) + '…'
        : m.content
      parts.push(`${who}: ${content}`)
    }
  }

  return parts.join('\n')
}

// ─── Check if summary is needed ───────────────────────────────────────────────

export async function shouldGenerateSummary(salonId: string): Promise<boolean> {
  try {
    // Get latest summary timestamp
    const summaries = await loadSummaries(salonId, 1)
    const since = summaries.length > 0
      ? summaries[0].period_end
      : '2020-01-01T00:00:00Z'

    // Count messages since last summary
    const url = `${supabaseUrl()}/rest/v1/conversation_history` +
      `?salon_id=eq.${salonId}` +
      `&created_at=gt.${since}` +
      `&select=id`
    const res = await fetch(url, {
      headers: headers({
        Prefer: 'count=exact',
        'Range-Unit': 'items',
        Range: '0-0',
      }),
    })
    const contentRange = res.headers.get('content-range')
    if (!contentRange) return false
    const match = contentRange.match(/\/(\d+)/)
    const count = match ? parseInt(match[1]) : 0
    return count >= 20
  } catch {
    return false
  }
}

// ─── Generate and store summary ───────────────────────────────────────────────

export async function generateAndStoreSummary(salonId: string): Promise<void> {
  try {
    // Load last 20 messages
    const messages = await loadRecentMessages(salonId, 20)
    if (messages.length < 15) return

    const conversationText = messages
      .map(m => `${m.role === 'user' ? 'Jefe' : 'Diablilla'}: ${m.content}`)
      .join('\n')

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) return

    // Always use cheapest model for summaries
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://diabolus.es',
        'X-Title': 'Diabolus CRM',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: [
              'Resume esta conversación entre un dueño de negocio (Jefe) y su asistente financiera (Diablilla).',
              'Incluye:',
              '- Datos clave: nombres de clientes mencionados, importes, decisiones tomadas',
              '- Acciones completadas: facturas creadas, cobros registrados, recordatorios enviados',
              '- Compromisos pendientes: lo que el Jefe dijo que haría o pidió para después',
              '- Estado emocional del Jefe: si estaba contento, preocupado, con prisa',
              'Máximo 150 palabras. En español. Sin introducción — ve directo al resumen.',
            ].join('\n'),
          },
          { role: 'user', content: conversationText },
        ],
        temperature: 0.1,
        max_tokens: 300,
      }),
    })

    if (!response.ok) return

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const summary = data.choices?.[0]?.message?.content
    if (!summary) return

    const periodStart = messages[0].created_at || new Date().toISOString()
    const periodEnd = messages[messages.length - 1].created_at || new Date().toISOString()

    await fetch(`${supabaseUrl()}/rest/v1/conversation_summaries`, {
      method: 'POST',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        salon_id: salonId,
        summary,
        message_count: messages.length,
        period_start: periodStart,
        period_end: periodEnd,
      }),
    })

    console.log(`[Memory] Summary generated for salon ${salonId}`)
  } catch (err) {
    console.warn('[Memory] Error generating summary:', err)
  }
}

// ─── Get salon AI config (brain tier) ─────────────────────────────────────────

export type BrainTier = 'rapida' | 'inteligente' | 'brillante'

export interface SalonAIConfig {
  brain_tier: BrainTier
  custom_greeting?: string
  personality_notes?: string
}

export async function getSalonAIConfig(salonId: string): Promise<SalonAIConfig> {
  try {
    const url = `${supabaseUrl()}/rest/v1/salon_ai_config` +
      `?salon_id=eq.${salonId}` +
      `&select=brain_tier,custom_greeting,personality_notes` +
      `&limit=1`
    const res = await fetch(url, { headers: headers() })
    if (!res.ok) return { brain_tier: 'rapida' }
    const data = (await res.json()) as SalonAIConfig[]
    return data.length > 0 ? data[0] : { brain_tier: 'rapida' }
  } catch {
    return { brain_tier: 'rapida' }
  }
}

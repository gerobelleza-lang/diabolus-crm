/**
 * 📊 Diablo Metrics — Usage tracking per Diablo
 * Logs to audit_log with action='diablo_usage'
 */

import { getSupabaseAdmin } from '../../integrations/supabase'

export interface DiabloUsage {
  diablo: string        // e.g. 'facturador', 'abogado'
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  model_used: string
  response_ms: number   // response time in ms
}

/**
 * Log a Diablo interaction to audit_log
 */
export async function logDiabloUsage(
  userId: string,
  salonId: string,
  usage: DiabloUsage
): Promise<void> {
  try {
    const supabase = getSupabaseAdmin()
    await supabase.from('audit_log').insert([{
      user_id: userId,
      salon_id: salonId,
      action: 'diablo_usage',
      changes: {
        diablo: usage.diablo,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        model_used: usage.model_used,
        response_ms: usage.response_ms
      },
      created_at: new Date().toISOString()
    }])
  } catch (e) {
    // Non-blocking — metrics should never break the chat flow
    console.error('[metrics] Failed to log diablo usage:', e)
  }
}

/**
 * Query aggregated metrics per Diablo
 */
export async function getDiabloMetrics(
  salonId?: string,
  days: number = 30
): Promise<{
  diablo: string
  total_calls: number
  total_tokens: number
  avg_tokens: number
  avg_response_ms: number
  total_prompt_tokens: number
  total_completion_tokens: number
  models_used: Record<string, number>
}[]> {
  const supabase = getSupabaseAdmin()
  const since = new Date(Date.now() - days * 86400000).toISOString()

  let query = supabase
    .from('audit_log')
    .select('changes, created_at')
    .eq('action', 'diablo_usage')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(10000)

  if (salonId) {
    query = query.eq('salon_id', salonId)
  }

  const { data, error } = await query

  if (error || !data) return []

  // Aggregate by diablo
  const agg: Record<string, {
    calls: number
    tokens: number
    prompt: number
    completion: number
    ms: number
    models: Record<string, number>
  }> = {}

  for (const row of data) {
    const c = row.changes as any
    if (!c?.diablo) continue
    const d = c.diablo as string
    if (!agg[d]) agg[d] = { calls: 0, tokens: 0, prompt: 0, completion: 0, ms: 0, models: {} }
    agg[d].calls++
    agg[d].tokens += c.total_tokens || 0
    agg[d].prompt += c.prompt_tokens || 0
    agg[d].completion += c.completion_tokens || 0
    agg[d].ms += c.response_ms || 0
    const model = c.model_used || 'unknown'
    agg[d].models[model] = (agg[d].models[model] || 0) + 1
  }

  return Object.entries(agg).map(([diablo, stats]) => ({
    diablo,
    total_calls: stats.calls,
    total_tokens: stats.tokens,
    avg_tokens: stats.calls > 0 ? Math.round(stats.tokens / stats.calls) : 0,
    avg_response_ms: stats.calls > 0 ? Math.round(stats.ms / stats.calls) : 0,
    total_prompt_tokens: stats.prompt,
    total_completion_tokens: stats.completion,
    models_used: stats.models
  })).sort((a, b) => b.total_calls - a.total_calls)
}

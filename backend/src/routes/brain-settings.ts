// POST /api/agent/brain — Get or set brain tier for the salon
// GET:  returns current brain config
// POST: { brain_tier: 'rapida' | 'inteligente' | 'brillante' } — sets it

import { Hono } from 'hono'

const app = new Hono()

function getSupabase() {
  const url = process.env.SUPABASE_URL || 'https://emygbvxkhfbwyhbapaae.supabase.co'
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  return {
    async from(table: string) {
      return {
        async select(columns: string) {
          return {
            async eq(field: string, value: string) {
              return {
                async single() {
                  const res = await fetch(
                    `${url}/rest/v1/${table}?${field}=eq.${value}&select=${columns}&limit=1`,
                    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
                  )
                  const arr = await res.json()
                  return { data: arr?.[0] || null, error: null }
                }
              }
            }
          }
        },
        async upsert(data: any) {
          const res = await fetch(`${url}/rest/v1/${table}`, {
            method: 'POST',
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=representation',
            },
            body: JSON.stringify(data),
          })
          const result = await res.json()
          return { data: result, error: res.ok ? null : result }
        }
      }
    }
  }
}

const VALID_TIERS = ['rapida', 'inteligente', 'brillante'] as const
type BrainTier = typeof VALID_TIERS[number]

const BRAIN_INFO: Record<BrainTier, { name: string; emoji: string; desc: string; model: string; tier_required: string }> = {
  rapida: {
    name: 'Rápida',
    emoji: '⚡',
    desc: 'Respuestas veloces para el día a día. Gemini 2.5 Flash.',
    model: 'google/gemini-2.5-flash',
    tier_required: 'purgatorio',
  },
  inteligente: {
    name: 'Inteligente',
    emoji: '🧠',
    desc: 'Más contexto, mejor razonamiento. GPT-4.1 Mini.',
    model: 'openai/gpt-4.1-mini',
    tier_required: 'pacto',
  },
  brillante: {
    name: 'Brillante',
    emoji: '👑',
    desc: 'La mente más potente. Análisis profundo. Claude Sonnet 4.',
    model: 'anthropic/claude-sonnet-4',
    tier_required: 'infierno',
  },
}

// GET /api/agent/brain — get current brain config
app.get('/', async (c) => {
  const salonId = (c as any).get?.('salonId') || c.req.header('x-salon-id') || ''
  if (!salonId) return c.json({ error: 'No salon context' }, 400)

  const sb = getSupabase()
  const table = await sb.from('salon_ai_config')
  const query = await table.select('*')
  const result = await query.eq('salon_id', salonId)
  const { data } = await result.single()

  const currentTier: BrainTier = data?.brain_tier || 'rapida'

  return c.json({
    current: currentTier,
    info: BRAIN_INFO[currentTier],
    available: Object.entries(BRAIN_INFO).map(([id, info]) => ({
      id,
      ...info,
      active: id === currentTier,
    })),
  })
})

// POST /api/agent/brain — set brain tier
app.post('/', async (c) => {
  const salonId = (c as any).get?.('salonId') || c.req.header('x-salon-id') || ''
  if (!salonId) return c.json({ error: 'No salon context' }, 400)

  let body: { brain_tier?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const newTier = body.brain_tier as BrainTier
  if (!VALID_TIERS.includes(newTier)) {
    return c.json({ error: `Invalid brain tier. Must be one of: ${VALID_TIERS.join(', ')}` }, 400)
  }

  const sb = getSupabase()
  const table = await sb.from('salon_ai_config')
  const { error } = await table.upsert({
    salon_id: salonId,
    brain_tier: newTier,
    updated_at: new Date().toISOString(),
  })

  if (error) return c.json({ error: 'Failed to update brain tier' }, 500)

  const info = BRAIN_INFO[newTier]
  return c.json({
    ok: true,
    current: newTier,
    info,
    message: `${info.emoji} Cerebro cambiado a ${info.name}. ${info.desc}`,
  })
})

export const brainSettingsRoutes = app

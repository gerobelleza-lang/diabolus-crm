// POST /api/agent/brain — Get or set brain tier for the salon
// GET:  returns current brain config
// POST: { brain_tier: 'rapida' | 'inteligente' | 'brillante' } — sets it

import { Hono } from 'hono'

const app = new Hono()

const SUPABASE_URL = 'https://emygbvxkhfbwyhbapaae.supabase.co'

function getHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
}

const VALID_TIERS = ['rapida', 'inteligente', 'brillante'] as const
type BrainTier = typeof VALID_TIERS[number]

const BRAIN_INFO: Record<BrainTier, { name: string; emoji: string; desc: string; model: string; tier_required: string }> = {
  rapida: {
    name: 'Rapida',
    emoji: '⚡',
    desc: 'Respuestas veloces para el dia a dia. Gemini 2.5 Flash.',
    model: 'google/gemini-2.5-flash',
    tier_required: 'purgatorio',
  },
  inteligente: {
    name: 'Inteligente',
    emoji: '🧠',
    desc: 'Mas contexto, mejor razonamiento. GPT-4.1 Mini.',
    model: 'openai/gpt-4.1-mini',
    tier_required: 'pacto',
  },
  brillante: {
    name: 'Brillante',
    emoji: '👑',
    desc: 'La mente mas potente. Analisis profundo. Claude Sonnet 4.',
    model: 'anthropic/claude-sonnet-4',
    tier_required: 'infierno',
  },
}

// GET /api/agent/brain — get current brain config
app.get('/', async (c) => {
  const salonId = (c as any).get?.('salonId') || c.req.header('x-salon-id') || ''
  if (!salonId) return c.json({ error: 'No salon context' }, 400)

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/salon_ai_config?salon_id=eq.${salonId}&select=*&limit=1`,
    { headers: getHeaders() }
  )
  const rows = await res.json()
  const data = Array.isArray(rows) ? rows[0] : null

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

  // Use on_conflict=salon_id so PostgREST knows which constraint to merge on
  const res = await fetch(`${SUPABASE_URL}/rest/v1/salon_ai_config?on_conflict=salon_id`, {
    method: 'POST',
    headers: {
      ...getHeaders(),
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({
      salon_id: salonId,
      brain_tier: newTier,
      updated_at: new Date().toISOString(),
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    console.error('brain-settings upsert error:', err)
    return c.json({ error: 'Failed to update brain tier' }, 500)
  }

  const info = BRAIN_INFO[newTier]
  return c.json({
    ok: true,
    current: newTier,
    info,
    message: `${info.emoji} Cerebro cambiado a ${info.name}. ${info.desc}`,
  })
})

export const brainSettingsRoutes = app

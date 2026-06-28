// ============================================================
// GUARDIÁN PROACTIVO — Route: POST /api/internal/guardian/scan
// Edge Runtime compatible — fetch only, Web Crypto API
// Detectores F1: moroso_cronico, ingreso_sin_factura
// Confesor: temp 0.3 | Anti-fatigue: max 3/week, 9-20h Madrid
// ============================================================

import { Hono } from 'hono'

const guardianRoutes = new Hono()

// ---- Helpers ----
async function computeDedupHash(
  salonId: string,
  detectorType: string,
  entityId: string,
  severity: string
): Promise<string> {
  const raw = `${salonId}:${detectorType}:${entityId}:${severity}`
  const data = new TextEncoder().encode(raw)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

function madridHour(): number {
  const now = new Date()
  const madrid = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    hour: 'numeric',
    hour12: false,
  }).format(now)
  return parseInt(madrid, 10)
}

// ---- Types ----
interface GuardianObservation {
  salon_id: string
  detector_type: 'moroso_cronico' | 'ingreso_sin_factura'
  severity: 'low' | 'medium' | 'high'
  entity_type: 'client' | 'invoice' | 'transaction'
  entity_id: string
  payload: Record<string, unknown>
  dedup_hash: string
}

interface ScanResult {
  salon_id: string
  observations_created: number
  observations_sent: number
  skipped_dedup: number
  skipped_fatigue: number
}

// ---- Detector 1: Moroso Crónico ----
async function detectMorosos(
  url: string, key: string, salonId: string
): Promise<GuardianObservation[]> {
  const obs: GuardianObservation[] = []
  const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString().split('T')[0]
  const thirtySevenDaysAgo = new Date(Date.now() - 37 * 864e5).toISOString().split('T')[0]

  const res = await fetch(
    `${url}/rest/v1/invoices?select=id,client_id,total,date,due_date,number,clients(name)&salon_id=eq.${salonId}&status=eq.sent&or=(and(due_date.not.is.null,due_date.lt.${sevenDaysAgo}),and(due_date.is.null,date.lt.${thirtySevenDaysAgo}))`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  )
  if (!res.ok) return obs
  const invoices = await res.json()

  for (const inv of invoices) {
    const dueDate = inv.due_date ||
      new Date(new Date(inv.date).getTime() + 30 * 864e5).toISOString().split('T')[0]
    const daysOverdue = Math.floor(
      (Date.now() - new Date(dueDate).getTime()) / 864e5
    )
    const severity: 'low' | 'medium' | 'high' =
      daysOverdue > 60 ? 'high' : daysOverdue > 30 ? 'medium' : 'low'

    obs.push({
      salon_id: salonId,
      detector_type: 'moroso_cronico',
      severity,
      entity_type: 'invoice',
      entity_id: inv.id,
      payload: {
        invoice_number: inv.number,
        client_name: inv.clients?.name || 'Desconocido',
        client_id: inv.client_id,
        total: inv.total,
        due_date: dueDate,
        days_overdue: daysOverdue,
      },
      dedup_hash: await computeDedupHash(salonId, 'moroso_cronico', inv.id, severity),
    })
  }
  return obs
}

// ---- Detector 2: Ingreso sin Factura ----
async function detectIngresosSinFactura(
  url: string, key: string, salonId: string
): Promise<GuardianObservation[]> {
  const obs: GuardianObservation[] = []
  const ninetyDaysAgo = new Date(Date.now() - 90 * 864e5).toISOString().split('T')[0]

  const txRes = await fetch(
    `${url}/rest/v1/transactions?select=id,client_id,amount,description,date,clients(name)&salon_id=eq.${salonId}&type=eq.income&date=gte.${ninetyDaysAgo}&client_id=not.is.null`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  )
  if (!txRes.ok) return obs
  const transactions = await txRes.json()
  if (transactions.length === 0) return obs

  const invRes = await fetch(
    `${url}/rest/v1/invoices?select=client_id&salon_id=eq.${salonId}&date=gte.${ninetyDaysAgo}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  )
  const invoicedClients = new Set<string>()
  if (invRes.ok) {
    for (const inv of await invRes.json()) {
      if (inv.client_id) invoicedClients.add(inv.client_id)
    }
  }

  for (const tx of transactions) {
    if (invoicedClients.has(tx.client_id)) continue
    const severity: 'low' | 'medium' | 'high' =
      tx.amount > 1000 ? 'high' : tx.amount > 300 ? 'medium' : 'low'

    obs.push({
      salon_id: salonId,
      detector_type: 'ingreso_sin_factura',
      severity,
      entity_type: 'transaction',
      entity_id: tx.id,
      payload: {
        client_name: tx.clients?.name || 'Desconocido',
        client_id: tx.client_id,
        amount: tx.amount,
        description: tx.description,
        date: tx.date,
      },
      dedup_hash: await computeDedupHash(salonId, 'ingreso_sin_factura', tx.id, severity),
    })
  }
  return obs
}

// ---- Anti-fatigue: count sent this week ----
async function countSentThisWeek(url: string, key: string, salonId: string): Promise<number> {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString()
  const res = await fetch(
    `${url}/rest/v1/guardian_observations?select=id&salon_id=eq.${salonId}&status=eq.sent&sent_at=gte.${weekAgo}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' } }
  )
  return parseInt(res.headers.get('content-range')?.split('/')[1] || '0', 10)
}

// ---- Dedup check ----
async function existingHashes(url: string, key: string, hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set()
  const list = hashes.map(h => `"${h}"`).join(',')
  const res = await fetch(
    `${url}/rest/v1/guardian_observations?select=dedup_hash&dedup_hash=in.(${list})&status=in.(new,sent)`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  )
  if (!res.ok) return new Set()
  const rows = await res.json()
  return new Set(rows.map((r: { dedup_hash: string }) => r.dedup_hash))
}

// ---- Expire old (14d) ----
async function expireOld(url: string, key: string): Promise<number> {
  const cutoff = new Date(Date.now() - 14 * 864e5).toISOString()
  const res = await fetch(
    `${url}/rest/v1/guardian_observations?status=eq.sent&sent_at=lt.${cutoff}`,
    {
      method: 'PATCH',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation,count=exact',
      },
      body: JSON.stringify({ status: 'expired' }),
    }
  )
  return parseInt(res.headers.get('content-range')?.split('/')[1] || '0', 10)
}

// ---- Confesor: verbalize with GPT-4.1 Mini (temp 0.3) ----
async function verbalize(obs: GuardianObservation, openaiKey: string): Promise<string> {
  const p = obs.payload as Record<string, unknown>
  const context = obs.detector_type === 'moroso_cronico'
    ? `Factura ${p.invoice_number} de ${p.client_name} por ${p.total}€. Vencida hace ${p.days_overdue} días. Severidad: ${obs.severity}.`
    : `Cobro de ${p.amount}€ de ${p.client_name} el ${p.date} (concepto: "${p.description || 'sin concepto'}"). Sin factura asociada. Severidad: ${obs.severity}.`

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        temperature: 0.3,
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content: 'Eres el Confesor de Diabolus. Verbalizas observaciones financieras del Guardián Proactivo para el dueño del negocio. Estilo: directo, profesional, sin rodeos. Tutea. Máximo 2 frases. No uses emojis. Incluye cifras exactas. Si es grave, que se note la urgencia. Si es leve, tono informativo. Nunca inventes datos — usa solo lo proporcionado.',
          },
          { role: 'user', content: context },
        ],
      }),
    })
    if (!res.ok) return context
    const data = await res.json()
    return data.choices?.[0]?.message?.content || context
  } catch {
    return context
  }
}

// ---- Deliver via Telegram ----
async function deliverTelegram(chatId: string, text: string, botToken: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🛡️ Guardián:\n${text}`,
      parse_mode: 'HTML',
    }),
  })
  return res.ok
}

// ---- Main scan handler ----
guardianRoutes.post('/scan', async (c) => {
  const secret = c.req.header('x-internal-secret') || ''
  const expected = process.env.INTERNAL_API_SECRET || process.env.INTERNAL_SECRET
  if (!expected || secret !== expected) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || ''
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  const OPENAI = process.env.OPENAI_API_KEY || ''
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''

  // Time window check (9-20h Madrid)
  const hour = madridHour()
  if (hour < 9 || hour >= 20) {
    return c.json({ ok: true, skipped: 'outside_window', hour })
  }

  // Expire old observations
  const expired = await expireOld(SUPABASE_URL, KEY)

  // Get active salons
  const salonsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/salons?select=id,name,telegram_chat_id,notify_channel,whatsapp_number&is_active=eq.true`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
  )
  if (!salonsRes.ok) return c.json({ error: 'Failed to fetch salons' }, 500)
  const salons = await salonsRes.json()

  const results: ScanResult[] = []

  for (const salon of salons) {
    const result: ScanResult = {
      salon_id: salon.id,
      observations_created: 0,
      observations_sent: 0,
      skipped_dedup: 0,
      skipped_fatigue: 0,
    }

    // Anti-fatigue
    const sentThisWeek = await countSentThisWeek(SUPABASE_URL, KEY, salon.id)
    if (sentThisWeek >= 3) {
      result.skipped_fatigue = -1
      results.push(result)
      continue
    }
    const budget = 3 - sentThisWeek

    // Run detectors in parallel
    const [morosos, sinFactura] = await Promise.all([
      detectMorosos(SUPABASE_URL, KEY, salon.id),
      detectIngresosSinFactura(SUPABASE_URL, KEY, salon.id),
    ])

    const allObs = [...morosos, ...sinFactura]
    if (allObs.length === 0) { results.push(result); continue }

    // Dedup
    const existing = await existingHashes(SUPABASE_URL, KEY, allObs.map(o => o.dedup_hash))
    const newObs = allObs.filter(o => {
      if (existing.has(o.dedup_hash)) { result.skipped_dedup++; return false }
      return true
    })

    // Priority sort (high first), cap at budget
    const order = { high: 0, medium: 1, low: 2 }
    newObs.sort((a, b) => order[a.severity] - order[b.severity])
    const toSend = newObs.slice(0, budget)
    result.skipped_fatigue += newObs.length - toSend.length

    for (const obs of toSend) {
      // Verbalize
      const text = await verbalize(obs, OPENAI)

      // Insert
      const insertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/guardian_observations`,
        {
          method: 'POST',
          headers: {
            apikey: KEY, Authorization: `Bearer ${KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          body: JSON.stringify({ ...obs, verbalized_text: text, status: 'new' }),
        }
      )
      if (!insertRes.ok) continue
      result.observations_created++
      const [inserted] = await insertRes.json()

      // Deliver via Telegram
      let delivered = false
      const chatId = salon.telegram_chat_id
      if (chatId && TG_TOKEN) {
        delivered = await deliverTelegram(chatId, text, TG_TOKEN)
      }

      if (delivered) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/guardian_observations?id=eq.${inserted.id}`,
          {
            method: 'PATCH',
            headers: {
              apikey: KEY, Authorization: `Bearer ${KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ status: 'sent', sent_at: new Date().toISOString() }),
          }
        )
        result.observations_sent++
      }
    }
    results.push(result)
  }

  return c.json({ ok: true, results, expired })
})

export { guardianRoutes }

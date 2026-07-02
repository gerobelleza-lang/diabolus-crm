/**
 * 🛡️ El Guardián v2 — Vigilancia proactiva de salud financiera
 *
 * Arquitectura 4-capas:
 *   Capa 0: Retrieval — datos financieros reales de Supabase
 *   Capa 1: Análisis determinista — health score + insight contextual
 *   Capa 2: LLM solo narrativa — redacta sobre datos pre-calculados
 *   Capa 3: Anti-invención — valida cifras LLM contra datos de entrada
 *
 * Detectores F1: moroso_cronico, ingreso_sin_factura
 * Anti-fatigue: max 3/week, 9-20h Madrid
 * Dedup: SHA-256 hash
 *
 * Edge Runtime compatible — fetch only, Web Crypto API
 */

import { Hono } from 'hono'

const guardianRoutes = new Hono()

// ═══════════════════════════════════════════════════════════
// TIPOS EXPORTADOS
// ═══════════════════════════════════════════════════════════

export interface SalonMetrics {
  overdueCount: number
  overdueAmount: number
  highSeverityCount: number
  uninvoicedIncomeTotal: number
  income30d: number
  expenses30d: number
  balance30d: number
}

export interface GuardianObservation {
  salon_id: string
  detector_type: 'moroso_cronico' | 'ingreso_sin_factura'
  severity: 'low' | 'medium' | 'high'
  entity_type: 'client' | 'invoice' | 'transaction'
  entity_id: string
  payload: Record<string, unknown>
  dedup_hash: string
}

export interface ScanResult {
  salon_id: string
  salon_name: string
  health_score: number
  health_emoji: string
  contextual_insight: string
  observations_created: number
  observations_sent: number
  skipped_dedup: number
  skipped_fatigue: number
}

// ═══════════════════════════════════════════════════════════
// FUNCIONES PURAS EXPORTADAS (testables)
// ═══════════════════════════════════════════════════════════

/**
 * Health Score: determinista, 0-100
 * Fórmula fija — NO LLM
 */
export function computeHealthScore(m: SalonMetrics): number {
  let score = 80

  // Penalización por facturas vencidas: -5 por factura, tope -30
  score -= Math.min(m.overdueCount * 5, 30)

  // Penalización extra por severidad alta: -10 cada, tope -20
  score -= Math.min(m.highSeverityCount * 10, 20)

  // Penalización por ingresos sin factura
  if (m.uninvoicedIncomeTotal > 500) score -= 10
  else if (m.uninvoicedIncomeTotal > 0) score -= 5

  // Balance: bonus si positivo, penalización si muy negativo
  if (m.balance30d > 0) score += 10
  else if (m.balance30d < -500) score -= 10

  // Bonus por salud perfecta
  if (m.overdueCount === 0 && m.uninvoicedIncomeTotal === 0 && m.balance30d >= 0) {
    score += 10
  }

  return Math.max(0, Math.min(100, score))
}

/**
 * Emoji de salud según score
 */
export function healthEmoji(score: number): string {
  if (score >= 80) return '🟢'
  if (score >= 60) return '🟡'
  if (score >= 40) return '🟠'
  return '🔴'
}

/**
 * Formatea número a euros españoles: 1250.50 → "1.250,50€"
 */
export function formatEur(n: number): string {
  const abs = Math.abs(n)
  const parts = abs.toFixed(2).split('.')
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const sign = n < 0 ? '-' : ''
  return `${sign}${intPart},${parts[1]}€`
}

/**
 * Insight contextual: determinista, orden de prioridad
 * vencidas → cobro | balance negativo → gasto | fin de mes → urgencia
 */
export function selectContextualInsight(m: SalonMetrics, dayOfMonth: number): string {
  // Prioridad 1: alertas graves
  if (m.highSeverityCount > 0) {
    return `${m.highSeverityCount} alerta(s) grave(s): morosos o cobros sin factura requieren acción inmediata.`
  }
  // Prioridad 2: facturas vencidas → consejo de cobro
  if (m.overdueCount > 0) {
    return `${m.overdueCount} factura(s) vencida(s) por ${formatEur(m.overdueAmount)}. Prioriza el cobro.`
  }
  // Prioridad 3: balance negativo → controlar gasto
  if (m.balance30d < 0) {
    return `Balance negativo este mes: ${formatEur(m.balance30d)}. Controla gastos antes del cierre.`
  }
  // Prioridad 4: fin de mes → urgencia cobros
  if (dayOfMonth >= 25) {
    return 'Fin de mes: revisa cobros pendientes y cierra facturas abiertas.'
  }
  // Prioridad 5: ingresos sin factura → regularizar
  if (m.uninvoicedIncomeTotal > 0) {
    return `${formatEur(m.uninvoicedIncomeTotal)} cobrados sin factura. Regulariza para evitar problemas fiscales.`
  }
  // Sin alertas
  return 'Sin alertas. Salud financiera estable.'
}

/**
 * Calcula métricas de salón a partir de resultados de detectores
 */
export function computeMetricsFromObservations(
  morosos: GuardianObservation[],
  sinFactura: GuardianObservation[],
  income30d: number,
  expenses30d: number
): SalonMetrics {
  const overdueAmount = morosos.reduce(
    (sum, o) => sum + (typeof o.payload.total === 'number' ? o.payload.total : 0), 0
  )
  const highSeverityCount = [...morosos, ...sinFactura].filter(o => o.severity === 'high').length
  const uninvoicedIncomeTotal = sinFactura.reduce(
    (sum, o) => sum + (typeof o.payload.amount === 'number' ? o.payload.amount : 0), 0
  )

  return {
    overdueCount: morosos.length,
    overdueAmount,
    highSeverityCount,
    uninvoicedIncomeTotal,
    income30d,
    expenses30d,
    balance30d: income30d - expenses30d,
  }
}

/**
 * Recolecta todos los números permitidos de datos de entrada
 */
export function collectAllowedNumbers(
  metrics: SalonMetrics,
  observations: GuardianObservation[],
  healthScore: number
): Set<number> {
  const nums = new Set<number>()

  // Métricas
  for (const v of Object.values(metrics)) {
    if (typeof v === 'number') {
      nums.add(v)
      nums.add(Math.round(v * 100) / 100) // versión redondeada
    }
  }

  // Health score
  nums.add(healthScore)

  // Payloads de observaciones
  for (const obs of observations) {
    for (const v of Object.values(obs.payload)) {
      if (typeof v === 'number') {
        nums.add(v)
        nums.add(Math.round(v * 100) / 100)
      }
    }
  }

  // Eliminar NaN si se coló
  nums.delete(NaN)

  return nums
}

/**
 * 🔒 ANTI-INVENCIÓN: valida que toda cifra en texto LLM
 * existe en datos de entrada. Si contiene cifra inventada →
 * ELIMINA LA FRASE ENTERA (no enmascara con [X]).
 *
 * Patrón: mismo enfoque que citas falsas del Abogado.
 */

/** Verifica si un número está en el set allowed (tolerancia 0.01) */
function isNumberAllowed(n: number, allowed: Set<number>): boolean {
  if (isNaN(n)) return false
  for (const a of allowed) {
    if (Math.abs(n - a) < 0.01) return true
  }
  return false
}

/** Comprueba si una frase contiene algún número inventado */
export function sentenceHasInvented(sentence: string, allowed: Set<number>): boolean {
  const matches = sentence.match(/\d+(?:[.,]\d+)*/g)
  if (!matches) return false
  for (const match of matches) {
    const numDirect = parseFloat(match.replace(',', '.'))
    const numSpanish = parseFloat(match.replace(/\./g, '').replace(',', '.'))
    if (isNaN(numDirect) && isNaN(numSpanish)) continue
    if (!isNumberAllowed(numDirect, allowed) && !isNumberAllowed(numSpanish, allowed)) {
      return true // frase contiene al menos 1 inventado
    }
  }
  return false
}

export function validateLlmNumbers(
  text: string,
  allowed: Set<number>
): { cleaned: string; inventedCount: number } {
  // Separar en frases por . ! ? o \n seguido de espacio real
  // \s+ evita cortar dentro de números como 1.250,50
  const sentences = text.split(/(?<=[.!?\n])\s+/).filter(s => s.trim())
  let inventedCount = 0
  const kept: string[] = []

  for (const sentence of sentences) {
    if (sentenceHasInvented(sentence, allowed)) {
      inventedCount++
    } else {
      kept.push(sentence)
    }
  }

  const cleaned = kept.join(' ').trim()
  return { cleaned, inventedCount }
}

/**
 * Formatea el mensaje de resumen del scan para Telegram
 */
export function formatScanSummary(
  salonName: string,
  metrics: SalonMetrics,
  healthScore: number,
  insight: string,
  observationTexts: string[]
): string {
  const emoji = healthEmoji(healthScore)
  let msg = `🛡️ Guardián — ${salonName}\n`
  msg += `${emoji} Salud: ${healthScore}/100\n`
  msg += `📊 Ingresos 30d: ${formatEur(metrics.income30d)} | Gastos: ${formatEur(metrics.expenses30d)}\n`
  msg += `💡 ${insight}`

  if (observationTexts.length > 0) {
    msg += '\n\n📋 Alertas:'
    for (const t of observationTexts) {
      msg += `\n• ${t}`
    }
  }

  return msg
}

// ═══════════════════════════════════════════════════════════
// HELPERS INTERNOS
// ═══════════════════════════════════════════════════════════

async function computeDedupHash(
  salonId: string, detectorType: string, entityId: string, severity: string
): Promise<string> {
  const raw = `${salonId}:${detectorType}:${entityId}:${severity}`
  const data = new TextEncoder().encode(raw)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

function madridNow(): { hour: number; dayOfMonth: number } {
  const now = new Date()
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid', hour: 'numeric', hour12: false,
  }).format(now)
  const dayStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid', day: 'numeric',
  }).format(now)
  return { hour: parseInt(hourStr, 10), dayOfMonth: parseInt(dayStr, 10) }
}

// ═══════════════════════════════════════════════════════════
// DETECTORES (Capa 0 — Retrieval)
// ═══════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════
// BALANCE 30d (Capa 0 — Retrieval)
// ═══════════════════════════════════════════════════════════

async function fetchBalance30d(
  url: string, key: string, salonId: string
): Promise<{ income: number; expenses: number }> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0]
  const headers = { apikey: key, Authorization: `Bearer ${key}` }

  const [incRes, expRes] = await Promise.all([
    fetch(
      `${url}/rest/v1/transactions?select=amount&salon_id=eq.${salonId}&type=eq.income&date=gte.${thirtyDaysAgo}`,
      { headers }
    ),
    fetch(
      `${url}/rest/v1/transactions?select=amount&salon_id=eq.${salonId}&type=eq.expense&date=gte.${thirtyDaysAgo}`,
      { headers }
    ),
  ])

  let income = 0
  let expenses = 0

  if (incRes.ok) {
    const rows = await incRes.json()
    income = rows.reduce((s: number, r: { amount: number }) => s + (r.amount || 0), 0)
  }
  if (expRes.ok) {
    const rows = await expRes.json()
    expenses = rows.reduce((s: number, r: { amount: number }) => s + (r.amount || 0), 0)
  }

  return { income, expenses }
}

// ═══════════════════════════════════════════════════════════
// DEDUP + ANTI-FATIGUE + EXPIRE
// ═══════════════════════════════════════════════════════════

async function countSentThisWeek(url: string, key: string, salonId: string): Promise<number> {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString()
  const res = await fetch(
    `${url}/rest/v1/guardian_observations?select=id&salon_id=eq.${salonId}&status=eq.sent&sent_at=gte.${weekAgo}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' } }
  )
  return parseInt(res.headers.get('content-range')?.split('/')[1] || '0', 10)
}

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

// ═══════════════════════════════════════════════════════════
// CAPA 2 — LLM solo narrativa + CAPA 3 — Anti-invención
// ═══════════════════════════════════════════════════════════

async function verbalizeV2(
  obs: GuardianObservation,
  allowed: Set<number>,
  openaiKey: string
): Promise<string> {
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
            content: [
              'Eres el Confesor de Diabolus. Verbalizas observaciones financieras del Guardián Proactivo para el dueño del negocio.',
              'Estilo: directo, profesional, sin rodeos. Tutea. Máximo 2 frases. No uses emojis.',
              'REGLA ABSOLUTA: usa SOLO las cifras exactas del mensaje del usuario.',
              'NO calcules porcentajes, tendencias, proyecciones ni cifras derivadas.',
              'Si es grave, que se note la urgencia. Si es leve, tono informativo.',
            ].join(' '),
          },
          { role: 'user', content: context },
        ],
      }),
    })
    if (!res.ok) return context // fallback determinista
    const data = await res.json()
    const raw: string = data.choices?.[0]?.message?.content || context

    // Capa 3: Anti-invención — elimina frases con cifras inventadas
    const { cleaned, inventedCount } = validateLlmNumbers(raw, allowed)
    if (inventedCount > 0 && cleaned.length > 0) {
      return cleaned
    }
    if (inventedCount > 0 && cleaned.length === 0) {
      return context // todas las frases eran inventadas → fallback determinista
    }
    return cleaned || raw
  } catch {
    return context // fallback determinista
  }
}

// ═══════════════════════════════════════════════════════════
// DELIVER
// ═══════════════════════════════════════════════════════════

async function deliverTelegram(chatId: string, text: string, botToken: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  })
  return res.ok
}

// ═══════════════════════════════════════════════════════════
// MAIN SCAN HANDLER
// ═══════════════════════════════════════════════════════════

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

  // Ventana horaria: 9-20h Madrid
  const { hour, dayOfMonth } = madridNow()
  if (hour < 9 || hour >= 20) {
    return c.json({ ok: true, skipped: 'outside_window', hour })
  }

  // Expirar observaciones antiguas
  const expired = await expireOld(SUPABASE_URL, KEY)

  // Salones activos
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
      salon_name: salon.name || 'Sin nombre',
      health_score: 0,
      health_emoji: '🟢',
      contextual_insight: '',
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

    // Capa 0: Retrieval paralelo
    const [morosos, sinFactura, balance] = await Promise.all([
      detectMorosos(SUPABASE_URL, KEY, salon.id),
      detectIngresosSinFactura(SUPABASE_URL, KEY, salon.id),
      fetchBalance30d(SUPABASE_URL, KEY, salon.id),
    ])

    // Capa 1: Análisis determinista
    const metrics = computeMetricsFromObservations(
      morosos, sinFactura, balance.income, balance.expenses
    )
    const healthScore = computeHealthScore(metrics)
    const insight = selectContextualInsight(metrics, dayOfMonth)

    result.health_score = healthScore
    result.health_emoji = healthEmoji(healthScore)
    result.contextual_insight = insight

    const allObs = [...morosos, ...sinFactura]
    if (allObs.length === 0) {
      // Sin alertas → solo enviar resumen de salud si score < 80
      if (healthScore < 80) {
        const chatId = salon.telegram_chat_id
        if (chatId && TG_TOKEN) {
          const summary = formatScanSummary(salon.name, metrics, healthScore, insight, [])
          await deliverTelegram(chatId, summary, TG_TOKEN)
        }
      }
      results.push(result)
      continue
    }

    // Dedup
    const existing = await existingHashes(SUPABASE_URL, KEY, allObs.map(o => o.dedup_hash))
    const newObs = allObs.filter(o => {
      if (existing.has(o.dedup_hash)) { result.skipped_dedup++; return false }
      return true
    })

    // Prioridad: high > medium > low, cap al budget
    const order = { high: 0, medium: 1, low: 2 }
    newObs.sort((a, b) => order[a.severity] - order[b.severity])
    const toSend = newObs.slice(0, budget)
    result.skipped_fatigue += newObs.length - toSend.length

    // Recolectar números permitidos
    const allowedNums = collectAllowedNumbers(metrics, toSend, healthScore)

    const observationTexts: string[] = []

    for (const obs of toSend) {
      // Capa 2+3: Verbalizar con anti-invención
      const text = await verbalizeV2(obs, allowedNums, OPENAI)
      observationTexts.push(text)

      // Insertar en BD
      const insertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/guardian_observations`,
        {
          method: 'POST',
          headers: {
            apikey: KEY, Authorization: `Bearer ${KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          body: JSON.stringify({
            ...obs,
            verbalized_text: text,
            status: 'new',
            health_score: healthScore,
          }),
        }
      )
      if (!insertRes.ok) continue
      result.observations_created++
      const [inserted] = await insertRes.json()

      // Marcar como sent si se entrega
      const chatId = salon.telegram_chat_id
      let delivered = false
      if (chatId && TG_TOKEN) {
        // Enviar resumen completo solo con la primera observación
        if (observationTexts.length === 1) {
          // Se enviará el resumen al final
        }
        delivered = true // Se entregará en el resumen
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

    // Enviar resumen unificado por Telegram
    const chatId = salon.telegram_chat_id
    if (chatId && TG_TOKEN && observationTexts.length > 0) {
      const summary = formatScanSummary(
        salon.name, metrics, healthScore, insight, observationTexts
      )
      await deliverTelegram(chatId, summary, TG_TOKEN)
    }

    results.push(result)
  }

  return c.json({ ok: true, results, expired })
})

export { guardianRoutes }

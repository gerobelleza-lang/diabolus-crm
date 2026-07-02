/**
 * 🛡️ El Guardián v2 — Tests
 * Etiquetado honesto: [UNIT] = lógica pura sin BD
 */

// ═══════════════════════════════════════════════════════════
// IMPORTS (same-file extraction for testing)
// ═══════════════════════════════════════════════════════════

// --- Inline the exported functions for testing ---

interface SalonMetrics {
  overdueCount: number
  overdueAmount: number
  highSeverityCount: number
  uninvoicedIncomeTotal: number
  income30d: number
  expenses30d: number
  balance30d: number
}

interface GuardianObservation {
  salon_id: string
  detector_type: 'moroso_cronico' | 'ingreso_sin_factura'
  severity: 'low' | 'medium' | 'high'
  entity_type: 'client' | 'invoice' | 'transaction'
  entity_id: string
  payload: Record<string, unknown>
  dedup_hash: string
}

function computeHealthScore(m: SalonMetrics): number {
  let score = 80
  score -= Math.min(m.overdueCount * 5, 30)
  score -= Math.min(m.highSeverityCount * 10, 20)
  if (m.uninvoicedIncomeTotal > 500) score -= 10
  else if (m.uninvoicedIncomeTotal > 0) score -= 5
  if (m.balance30d > 0) score += 10
  else if (m.balance30d < -500) score -= 10
  if (m.overdueCount === 0 && m.uninvoicedIncomeTotal === 0 && m.balance30d >= 0) {
    score += 10
  }
  return Math.max(0, Math.min(100, score))
}

function healthEmoji(score: number): string {
  if (score >= 80) return '🟢'
  if (score >= 60) return '🟡'
  if (score >= 40) return '🟠'
  return '🔴'
}

function formatEur(n: number): string {
  const abs = Math.abs(n)
  const parts = abs.toFixed(2).split('.')
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const sign = n < 0 ? '-' : ''
  return `${sign}${intPart},${parts[1]}€`
}

function selectContextualInsight(m: SalonMetrics, dayOfMonth: number): string {
  if (m.highSeverityCount > 0) {
    return `${m.highSeverityCount} alerta(s) grave(s): morosos o cobros sin factura requieren acción inmediata.`
  }
  if (m.overdueCount > 0) {
    return `${m.overdueCount} factura(s) vencida(s) por ${formatEur(m.overdueAmount)}. Prioriza el cobro.`
  }
  if (m.balance30d < 0) {
    return `Balance negativo este mes: ${formatEur(m.balance30d)}. Controla gastos antes del cierre.`
  }
  if (dayOfMonth >= 25) {
    return 'Fin de mes: revisa cobros pendientes y cierra facturas abiertas.'
  }
  if (m.uninvoicedIncomeTotal > 0) {
    return `${formatEur(m.uninvoicedIncomeTotal)} cobrados sin factura. Regulariza para evitar problemas fiscales.`
  }
  return 'Sin alertas. Salud financiera estable.'
}

function computeMetricsFromObservations(
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

function collectAllowedNumbers(
  metrics: SalonMetrics,
  observations: GuardianObservation[],
  healthScore: number
): Set<number> {
  const nums = new Set<number>()
  for (const v of Object.values(metrics)) {
    if (typeof v === 'number') {
      nums.add(v)
      nums.add(Math.round(v * 100) / 100)
    }
  }
  nums.add(healthScore)
  for (const obs of observations) {
    for (const v of Object.values(obs.payload)) {
      if (typeof v === 'number') {
        nums.add(v)
        nums.add(Math.round(v * 100) / 100)
      }
    }
  }
  nums.delete(NaN)
  return nums
}

function isNumberAllowed(n: number, allowed: Set<number>): boolean {
  if (isNaN(n)) return false
  for (const a of allowed) {
    if (Math.abs(n - a) < 0.01) return true
  }
  return false
}

function sentenceHasInvented(sentence: string, allowed: Set<number>): boolean {
  const matches = sentence.match(/\d+(?:[.,]\d+)*/g)
  if (!matches) return false
  for (const match of matches) {
    const numDirect = parseFloat(match.replace(',', '.'))
    const numSpanish = parseFloat(match.replace(/\./g, '').replace(',', '.'))
    if (isNaN(numDirect) && isNaN(numSpanish)) continue
    if (!isNumberAllowed(numDirect, allowed) && !isNumberAllowed(numSpanish, allowed)) {
      return true
    }
  }
  return false
}

function validateLlmNumbers(
  text: string,
  allowed: Set<number>
): { cleaned: string; inventedCount: number } {
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

function formatScanSummary(
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
// TEST FRAMEWORK
// ═══════════════════════════════════════════════════════════

let passed = 0
let failed = 0
const failures: string[] = []

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`) }
  else { failed++; failures.push(msg); console.log(`  ❌ ${msg}`) }
}

function assertEq(a: unknown, b: unknown, msg: string) {
  assert(a === b, `${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`)
}

function assertIncludes(text: string, sub: string, msg: string) {
  assert(text.includes(sub), `${msg} — "${sub}" not found in "${text.slice(0, 100)}"`)
}

function assertNotIncludes(text: string, sub: string, msg: string) {
  assert(!text.includes(sub), `${msg} — "${sub}" found but shouldn't be in "${text.slice(0, 100)}"`)
}

// ═══════════════════════════════════════════════════════════
// HELPER: métricas base
// ═══════════════════════════════════════════════════════════

function baseMetrics(overrides: Partial<SalonMetrics> = {}): SalonMetrics {
  return {
    overdueCount: 0, overdueAmount: 0, highSeverityCount: 0,
    uninvoicedIncomeTotal: 0, income30d: 5000, expenses30d: 3000, balance30d: 2000,
    ...overrides,
  }
}

function makeObs(overrides: Partial<GuardianObservation> = {}): GuardianObservation {
  return {
    salon_id: 's1', detector_type: 'moroso_cronico', severity: 'medium',
    entity_type: 'invoice', entity_id: 'e1',
    payload: { total: 500, days_overdue: 15, invoice_number: '001', client_name: 'Test' },
    dedup_hash: 'abc123',
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════
// 1. computeHealthScore
// ═══════════════════════════════════════════════════════════

console.log('\n📊 computeHealthScore')

// 1.1 Salud perfecta → 100
assertEq(computeHealthScore(baseMetrics()), 100,
  '[UNIT] salud perfecta (0 alertas, balance +) → 100')

// 1.2 Facturas vencidas penalizan
assertEq(computeHealthScore(baseMetrics({ overdueCount: 3, overdueAmount: 900 })), 75,
  '[UNIT] 3 vencidas → -15, pierde bonus perfecto → 75')

// 1.3 Tope penalización vencidas
assertEq(computeHealthScore(baseMetrics({ overdueCount: 10, overdueAmount: 5000 })), 60,
  '[UNIT] 10 vencidas → tope -30, pierde bonus → 60')

// 1.4 Severidad alta extra
assertEq(computeHealthScore(baseMetrics({ overdueCount: 2, highSeverityCount: 2 })), 60,
  '[UNIT] 2 vencidas + 2 high → 80-10-20+10(bal) = 60')

// 1.5 Tope severidad alta
assertEq(computeHealthScore(baseMetrics({ highSeverityCount: 5 })), 80,
  '[UNIT] 5 high severity → 80-20+10(bal)+10(perfect) = 80')

// 1.6 Ingresos sin factura > 500€
assertEq(computeHealthScore(baseMetrics({ uninvoicedIncomeTotal: 800 })), 80,
  '[UNIT] 800€ sin factura → -10, pierde bonus → 80')

// 1.7 Ingresos sin factura ≤ 500€ pero > 0
assertEq(computeHealthScore(baseMetrics({ uninvoicedIncomeTotal: 200 })), 85,
  '[UNIT] 200€ sin factura → -5, pierde bonus → 85')

// 1.8 Balance negativo fuerte
assertEq(computeHealthScore(baseMetrics({ balance30d: -1000, income30d: 1000, expenses30d: 2000 })), 70,
  '[UNIT] balance -1000 → pierde bonus +10, gana -10 → 70')

// 1.9 Balance positivo
assertEq(computeHealthScore(baseMetrics({ balance30d: 500 })), 100,
  '[UNIT] balance +500 → bonus → 100')

// 1.10 Caso extremo: todo mal
{
  const worst = baseMetrics({
    overdueCount: 10, overdueAmount: 50000,
    highSeverityCount: 5,
    uninvoicedIncomeTotal: 2000,
    balance30d: -5000, income30d: 0, expenses30d: 5000,
  })
  assertEq(computeHealthScore(worst), 10,
    '[UNIT] todo mal → 80-30-20-10-10 = 10')
}

// 1.11 Nunca bajo 0
{
  const abysmal = baseMetrics({
    overdueCount: 100, highSeverityCount: 100,
    uninvoicedIncomeTotal: 100000, balance30d: -100000,
  })
  assertEq(computeHealthScore(abysmal), 10,
    '[UNIT] extremo → 80-30-20-10-10 = 10 (min achievable)')
}

// ═══════════════════════════════════════════════════════════
// 2. healthEmoji
// ═══════════════════════════════════════════════════════════

console.log('\n🎨 healthEmoji')

assertEq(healthEmoji(100), '🟢', '[UNIT] 100 → verde')
assertEq(healthEmoji(80), '🟢', '[UNIT] 80 → verde')
assertEq(healthEmoji(79), '🟡', '[UNIT] 79 → amarillo')
assertEq(healthEmoji(60), '🟡', '[UNIT] 60 → amarillo')
assertEq(healthEmoji(59), '🟠', '[UNIT] 59 → naranja')
assertEq(healthEmoji(40), '🟠', '[UNIT] 40 → naranja')
assertEq(healthEmoji(39), '🔴', '[UNIT] 39 → rojo')
assertEq(healthEmoji(0), '🔴', '[UNIT] 0 → rojo')

// ═══════════════════════════════════════════════════════════
// 3. formatEur
// ═══════════════════════════════════════════════════════════

console.log('\n💶 formatEur')

assertEq(formatEur(1250.50), '1.250,50€', '[UNIT] 1250.50 → 1.250,50€')
assertEq(formatEur(0), '0,00€', '[UNIT] 0 → 0,00€')
assertEq(formatEur(99.99), '99,99€', '[UNIT] 99.99 → 99,99€')
assertEq(formatEur(-500), '-500,00€', '[UNIT] -500 → -500,00€')
assertEq(formatEur(1000000), '1.000.000,00€', '[UNIT] 1M → 1.000.000,00€')

// ═══════════════════════════════════════════════════════════
// 4. selectContextualInsight — DETERMINISTA
// ═══════════════════════════════════════════════════════════

console.log('\n💡 selectContextualInsight')

// 4.1 High severity → máxima prioridad
{
  const m = baseMetrics({ highSeverityCount: 2, overdueCount: 3, balance30d: -1000 })
  const insight = selectContextualInsight(m, 15)
  assertIncludes(insight, '2 alerta(s) grave(s)', '[UNIT] high severity tiene prioridad sobre todo')
}

// 4.2 Vencidas → segunda prioridad
{
  const m = baseMetrics({ overdueCount: 3, overdueAmount: 1500, balance30d: -500 })
  const insight = selectContextualInsight(m, 15)
  assertIncludes(insight, '3 factura(s) vencida(s)', '[UNIT] vencidas → consejo de cobro')
  assertIncludes(insight, '1.500,00€', '[UNIT] importe en formato español')
}

// 4.3 Balance negativo → tercera prioridad
{
  const m = baseMetrics({ balance30d: -800, uninvoicedIncomeTotal: 200 })
  const insight = selectContextualInsight(m, 15)
  assertIncludes(insight, 'Balance negativo', '[UNIT] balance negativo → controlar gasto')
}

// 4.4 Fin de mes → cuarta prioridad
{
  const m = baseMetrics({ uninvoicedIncomeTotal: 100 })
  const insight = selectContextualInsight(m, 28)
  assertIncludes(insight, 'Fin de mes', '[UNIT] día 28 → urgencia fin de mes')
}

// 4.5 Ingresos sin factura → quinta prioridad
{
  const m = baseMetrics({ uninvoicedIncomeTotal: 300 })
  const insight = selectContextualInsight(m, 10)
  assertIncludes(insight, 'sin factura', '[UNIT] ingresos sin factura → regularizar')
}

// 4.6 Sin alertas
{
  const m = baseMetrics()
  const insight = selectContextualInsight(m, 10)
  assertEq(insight, 'Sin alertas. Salud financiera estable.',
    '[UNIT] sin alertas → mensaje positivo')
}

// 4.7 Prioridad: vencidas ganan a fin de mes
{
  const m = baseMetrics({ overdueCount: 1, overdueAmount: 500 })
  const insight = selectContextualInsight(m, 30)
  assertIncludes(insight, 'vencida(s)', '[UNIT] vencidas priorizan sobre fin de mes')
  assertNotIncludes(insight, 'Fin de mes', '[UNIT] fin de mes no aparece si hay vencidas')
}

// ═══════════════════════════════════════════════════════════
// 5. computeMetricsFromObservations
// ═══════════════════════════════════════════════════════════

console.log('\n📐 computeMetricsFromObservations')

{
  const morosos: GuardianObservation[] = [
    makeObs({ payload: { total: 500, days_overdue: 15 }, severity: 'medium' }),
    makeObs({ payload: { total: 2000, days_overdue: 90 }, severity: 'high', entity_id: 'e2' }),
  ]
  const sinFactura: GuardianObservation[] = [
    makeObs({
      detector_type: 'ingreso_sin_factura', entity_type: 'transaction',
      payload: { amount: 300 }, severity: 'low', entity_id: 'e3',
    }),
  ]
  const m = computeMetricsFromObservations(morosos, sinFactura, 8000, 5000)
  assertEq(m.overdueCount, 2, '[UNIT] overdueCount = 2')
  assertEq(m.overdueAmount, 2500, '[UNIT] overdueAmount = 500 + 2000')
  assertEq(m.highSeverityCount, 1, '[UNIT] highSeverityCount = 1')
  assertEq(m.uninvoicedIncomeTotal, 300, '[UNIT] uninvoicedIncome = 300')
  assertEq(m.income30d, 8000, '[UNIT] income30d pass-through')
  assertEq(m.expenses30d, 5000, '[UNIT] expenses30d pass-through')
  assertEq(m.balance30d, 3000, '[UNIT] balance = income - expenses')
}

// Caso vacío
{
  const m = computeMetricsFromObservations([], [], 0, 0)
  assertEq(m.overdueCount, 0, '[UNIT] vacío → overdueCount 0')
  assertEq(m.balance30d, 0, '[UNIT] vacío → balance 0')
}

// ═══════════════════════════════════════════════════════════
// 6. collectAllowedNumbers
// ═══════════════════════════════════════════════════════════

console.log('\n🔢 collectAllowedNumbers')

{
  const m = baseMetrics({ overdueCount: 3, overdueAmount: 1500 })
  const obs = [makeObs({ payload: { total: 500, days_overdue: 45 } })]
  const allowed = collectAllowedNumbers(m, obs, 75)
  assert(allowed.has(3), '[UNIT] overdueCount 3 en allowed')
  assert(allowed.has(1500), '[UNIT] overdueAmount 1500 en allowed')
  assert(allowed.has(500), '[UNIT] payload total 500 en allowed')
  assert(allowed.has(45), '[UNIT] payload days_overdue 45 en allowed')
  assert(allowed.has(75), '[UNIT] healthScore 75 en allowed')
  assert(!allowed.has(NaN), '[UNIT] NaN excluido')
}

// ═══════════════════════════════════════════════════════════
// 7. validateLlmNumbers — ⚔️ INNEGOCIABLE ⚔️
// ═══════════════════════════════════════════════════════════

console.log('\n🔒 validateLlmNumbers — ANTI-INVENCIÓN')

// 7.1 Texto sin números → intacto
{
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Todo está en orden, no hay alertas.',
    new Set([100])
  )
  assertEq(inventedCount, 0, '[UNIT] sin números en texto → 0 inventados')
  assertEq(cleaned, 'Todo está en orden, no hay alertas.', '[UNIT] texto sin números intacto')
}

// 7.2 Todos los números válidos → intacto
{
  const allowed = new Set([3, 1250, 45])
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Tienes 3 facturas vencidas por 1250€ desde hace 45 días.',
    allowed
  )
  assertEq(inventedCount, 0, '[UNIT] todos números válidos → 0 inventados')
  assertIncludes(cleaned, '3 facturas', '[UNIT] 3 preservado')
  assertIncludes(cleaned, '1250€', '[UNIT] 1250 preservado')
  assertIncludes(cleaned, '45 días', '[UNIT] 45 preservado')
}

// 7.3 ⚔️ INYECCIÓN LITERAL: frase con número inventado → frase entera eliminada
{
  const allowed = new Set([3, 1250, 45])
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Tienes 3 facturas por 1250€. El 78% de tus clientes son morosos.',
    allowed
  )
  assertEq(inventedCount, 1, '[UNIT] ⚔️ INYECCIÓN: 1 frase con inventado detectada')
  assertNotIncludes(cleaned, '78', '[UNIT] ⚔️ INYECCIÓN: 78 eliminado del texto')
  assertNotIncludes(cleaned, 'morosos', '[UNIT] ⚔️ INYECCIÓN: frase entera eliminada')
  assertIncludes(cleaned, '3 facturas', '[UNIT] ⚔️ INYECCIÓN: frase válida preservada')
  assertIncludes(cleaned, '1250€', '[UNIT] ⚔️ INYECCIÓN: 1250 preservado')
}

// 7.4 Frase con múltiples inventados → eliminada, frase válida preservada
{
  const allowed = new Set([500])
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Factura de 500€. Representa un 15% del total de 3333€ mensuales.',
    allowed
  )
  assertEq(inventedCount, 1, '[UNIT] 1 frase con inventados eliminada')
  assertIncludes(cleaned, '500€', '[UNIT] frase válida con 500 preservada')
  assertNotIncludes(cleaned, '15%', '[UNIT] frase inventada eliminada')
}

// 7.5 Formato español (1.250,50) — número real en allowed
{
  const allowed = new Set([1250.50])
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Deuda total: 1.250,50€.',
    allowed
  )
  assertEq(inventedCount, 0, '[UNIT] 1.250,50 = 1250.50 → válido')
}

// 7.6 Número inventado en formato español → frase eliminada
{
  const allowed = new Set([500])
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Importe válido: 500€. Total: 2.750,00€ de deuda.',
    allowed
  )
  assertEq(inventedCount, 1, '[UNIT] 2.750,00 inventado → frase eliminada')
  assertIncludes(cleaned, '500€', '[UNIT] frase válida preservada')
  assertNotIncludes(cleaned, '2.750', '[UNIT] frase con inventado eliminada')
}

// 7.7 Tolerancia 0.01 para redondeo
{
  const allowed = new Set([99.999])
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Importe: 100€.',
    allowed
  )
  assertEq(inventedCount, 0, '[UNIT] 100 ≈ 99.999 → tolerancia 0.01 OK')
}

// 7.8 Cero está permitido si en allowed
{
  const allowed = new Set([0])
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Balance: 0€.',
    allowed
  )
  assertEq(inventedCount, 0, '[UNIT] 0 en allowed → válido')
}

// 7.9 Set vacío → frase eliminada
{
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Hay 5 facturas por 3000€.',
    new Set()
  )
  assertEq(inventedCount, 1, '[UNIT] set vacío → frase eliminada')
  assertEq(cleaned, '', '[UNIT] sin frases válidas → texto vacío')
}

// 7.10 ⚔️ INYECCIÓN COMPLEJA: frase inventada eliminada, frase válida preservada
{
  const allowed = new Set([3, 1500, 45, 75])
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Tienes 3 facturas vencidas por 1500€. Proyectamos morosidad del 23% y pérdidas de 4500€.',
    allowed
  )
  assert(inventedCount >= 1, '[UNIT] ⚔️ INYECCIÓN COMPLEJA: frase con inventados eliminada')
  assertNotIncludes(cleaned, '23', '[UNIT] ⚔️ porcentaje inventado eliminado')
  assertNotIncludes(cleaned, '4500', '[UNIT] ⚔️ proyección inventada eliminada')
  assertIncludes(cleaned, '3 facturas', '[UNIT] ⚔️ frase válida preservada')
  assertIncludes(cleaned, '1500€', '[UNIT] ⚔️ dato real preservado')
}

// 7.11 ⚔️ INYECCIÓN: frase con score falso → eliminada
{
  const allowed = new Set([65, 2, 800, 100])
  const { cleaned, inventedCount } = validateLlmNumbers(
    'Salud: 65/100. Con 2 morosos por 800€. Si no actúas, caerá a 30 puntos.',
    allowed
  )
  assert(inventedCount >= 1, '[UNIT] ⚔️ score futuro inventado detectado')
  assertIncludes(cleaned, '65', '[UNIT] ⚔️ score real preservado')
  assertNotIncludes(cleaned, '30 puntos', '[UNIT] ⚔️ score falso eliminado')
}

// ═══════════════════════════════════════════════════════════
// 8. formatScanSummary
// ═══════════════════════════════════════════════════════════

console.log('\n📄 formatScanSummary')

{
  const m = baseMetrics({ overdueCount: 2, overdueAmount: 1500 })
  const summary = formatScanSummary('Peluquería Bella', m, 75, 'Prioriza el cobro.', [
    'Factura #1 vencida',
    'Factura #2 vencida',
  ])
  assertIncludes(summary, '🛡️ Guardián — Peluquería Bella', '[UNIT] header salon')
  assertIncludes(summary, '75/100', '[UNIT] health score')
  assertIncludes(summary, '🟡', '[UNIT] emoji amarillo para 75')
  assertIncludes(summary, 'Prioriza el cobro', '[UNIT] insight incluido')
  assertIncludes(summary, '📋 Alertas:', '[UNIT] sección alertas')
  assertIncludes(summary, '• Factura #1', '[UNIT] alerta 1 con bullet')
  assertIncludes(summary, '• Factura #2', '[UNIT] alerta 2 con bullet')
}

// Sin alertas
{
  const m = baseMetrics()
  const summary = formatScanSummary('Test', m, 100, 'Todo bien.', [])
  assertNotIncludes(summary, '📋 Alertas', '[UNIT] sin alertas → no muestra sección')
  assertIncludes(summary, '🟢', '[UNIT] emoji verde para 100')
}

// ═══════════════════════════════════════════════════════════
// 9. Integración lógica: detector → metrics → score → insight
// ═══════════════════════════════════════════════════════════

console.log('\n🔗 Integración lógica end-to-end')

{
  const morosos: GuardianObservation[] = [
    makeObs({ payload: { total: 1200, days_overdue: 65 }, severity: 'high' }),
    makeObs({ payload: { total: 300, days_overdue: 10 }, severity: 'low', entity_id: 'e2' }),
  ]
  const sinFactura: GuardianObservation[] = [
    makeObs({
      detector_type: 'ingreso_sin_factura', entity_type: 'transaction',
      payload: { amount: 800 }, severity: 'medium', entity_id: 'e3',
    }),
  ]

  // Step 1: Métricas
  const m = computeMetricsFromObservations(morosos, sinFactura, 4000, 3500)
  assertEq(m.overdueCount, 2, '[UNIT] e2e: 2 morosos')
  assertEq(m.overdueAmount, 1500, '[UNIT] e2e: 1200+300 = 1500')
  assertEq(m.highSeverityCount, 1, '[UNIT] e2e: 1 high severity')
  assertEq(m.uninvoicedIncomeTotal, 800, '[UNIT] e2e: 800 sin factura')
  assertEq(m.balance30d, 500, '[UNIT] e2e: 4000-3500 = 500')

  // Step 2: Health score
  const score = computeHealthScore(m)
  // 80 - 10(2*5) - 10(1*10) - 10(800>500) + 10(balance>0) = 60
  assertEq(score, 60, '[UNIT] e2e: score = 60')

  // Step 3: Emoji
  assertEq(healthEmoji(score), '🟡', '[UNIT] e2e: 60 → amarillo')

  // Step 4: Insight contextual (high severity tiene prioridad)
  const insight = selectContextualInsight(m, 15)
  assertIncludes(insight, '1 alerta(s) grave(s)', '[UNIT] e2e: high severity prioriza')

  // Step 5: Allowed numbers
  const allowed = collectAllowedNumbers(m, [...morosos, ...sinFactura], score)
  assert(allowed.has(1200), '[UNIT] e2e: 1200 en allowed')
  assert(allowed.has(300), '[UNIT] e2e: 300 en allowed')
  assert(allowed.has(800), '[UNIT] e2e: 800 en allowed')
  assert(allowed.has(65), '[UNIT] e2e: 65 (days_overdue) en allowed')
  assert(allowed.has(60), '[UNIT] e2e: 60 (score) en allowed')

  // Step 6: Validar texto LLM simulado — frase con inventado eliminada
  const fakeText = 'Moroso por 1200€ desde hace 65 días, otro por 300€. Proyección: perderás 5000€.'
  const { cleaned, inventedCount } = validateLlmNumbers(fakeText, allowed)
  assert(inventedCount >= 1, '[UNIT] e2e: frase con 5000 inventado eliminada')
  assertNotIncludes(cleaned, '5000', '[UNIT] e2e: proyección eliminada')
}

// ═══════════════════════════════════════════════════════════
// 10. Edge cases
// ═══════════════════════════════════════════════════════════

console.log('\n🧪 Edge cases')

// Día 25 exacto = fin de mes
{
  const m = baseMetrics()
  const insight = selectContextualInsight(m, 25)
  assertIncludes(insight, 'Fin de mes', '[UNIT] día 25 → fin de mes')
}

// Día 24 = no fin de mes
{
  const m = baseMetrics()
  const insight = selectContextualInsight(m, 24)
  assertEq(insight, 'Sin alertas. Salud financiera estable.',
    '[UNIT] día 24 → no fin de mes, sin alertas')
}

// Health score con balance exacto 0
{
  const m = baseMetrics({ balance30d: 0 })
  // balance 0 → no gana +10, no pierde -10, pero sí bonus perfecta
  assertEq(computeHealthScore(m), 90,
    '[UNIT] balance 0 → sin bonus balance, con bonus perfecta → 90')
}

// Health score con balance exacto -500 (umbral)
{
  const m = baseMetrics({ balance30d: -500 })
  // -500 no es < -500, así que no pierde -10 extra
  assertEq(computeHealthScore(m), 80,
    '[UNIT] balance -500 exacto → -500 not < -500, no penalty → 80')
}

// formatEur con centavos
assertEq(formatEur(0.01), '0,01€', '[UNIT] 0.01€')
assertEq(formatEur(12345678.99), '12.345.678,99€', '[UNIT] millones')

// ═══════════════════════════════════════════════════════════
// RESUMEN
// ═══════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`)
console.log(`🛡️ Guardián v2: ${passed}/${passed + failed} tests passed`)
if (failures.length > 0) {
  console.log(`\n❌ Failures:`)
  failures.forEach(f => console.log(`  - ${f}`))
}
console.log(`${'='.repeat(50)}`)
process.exit(failed > 0 ? 1 : 0)

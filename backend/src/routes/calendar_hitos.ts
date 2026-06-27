// @ts-nocheck
import { Hono } from 'hono'

export const calendarHitosRoute = new Hono()

// ─── Plazos legales fijos para autónomos España ─────────────────────────────
function getLegalDeadlines(year: number) {
  return [
    { date: `${year}-01-20`, title: 'AEAT — 4T IVA (mod. 303)' },
    { date: `${year}-01-30`, title: 'AEAT — 4T Retenciones IRPF (mod. 111/115)' },
    { date: `${year}-02-28`, title: 'AEAT — Declaración informativa anual (mod. 347)' },
    { date: `${year}-04-20`, title: 'AEAT — 1T IVA (mod. 303)' },
    { date: `${year}-04-20`, title: 'AEAT — 1T Retenciones IRPF (mod. 111/115)' },
    { date: `${year}-06-30`, title: 'AEAT — Renta anual IRPF (plazo general)' },
    { date: `${year}-07-20`, title: 'AEAT — 2T IVA (mod. 303)' },
    { date: `${year}-07-20`, title: 'AEAT — 2T Retenciones IRPF (mod. 111/115)' },
    { date: `${year}-10-20`, title: 'AEAT — 3T IVA (mod. 303)' },
    { date: `${year}-10-20`, title: 'AEAT — 3T Retenciones IRPF (mod. 111/115)' },
  ]
}

// ─── Generador ICS (iCalendar) ───────────────────────────────────────────────
function generateICS(
  events: Array<{ date: string; title: string; salon?: string }>
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Diabolus CRM//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Diabolus — Hitos',
    'X-WR-TIMEZONE:Europe/Madrid',
  ]

  for (const ev of events) {
    if (!ev.date) continue
    const dtDate  = ev.date.replace(/-/g, '')
    const uid     = `${dtDate}-${Math.random().toString(36).slice(2, 9)}@diabolus.es`
    const summary = ev.salon ? `[${ev.salon}] ${ev.title}` : ev.title

    lines.push(
      'BEGIN:VEVENT',
      `DTSTART;VALUE=DATE:${dtDate}`,
      `DTEND;VALUE=DATE:${dtDate}`,
      `SUMMARY:${summary.replace(/[,;\\]/g, '\\$&')}`,
      `UID:${uid}`,
      'DESCRIPTION:Generado automáticamente por Diabolus CRM',
      'END:VEVENT'
    )
  }

  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

// ─── Ruta: GET /api/internal/calendar-hitos ──────────────────────────────────
calendarHitosRoute.get('/', async (c) => {
  const secret   = c.req.header('x-internal-secret') || c.req.query('secret') || ''
  const expected = (c.env as any)?.INTERNAL_SECRET || 'diabolus_internal_2026'
  if (secret !== expected) return c.json({ error: 'Forbidden' }, 403)

  const SB_URL   = (c.env as any)?.SUPABASE_URL            || 'https://emygbvxkhfbwyhbapaae.supabase.co'
  const SB_KEY   = (c.env as any)?.SUPABASE_SERVICE_ROLE_KEY || ''
  const TG_TOKEN = (c.env as any)?.TELEGRAM_BOT_TOKEN      || ''
  const TG_CHAT  = (c.env as any)?.TELEGRAM_CHAT_ID        || '8356150792'

  const sb = (path: string) =>
    fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: {
        apikey:         SB_KEY,
        Authorization:  `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
      },
    }).then(r => r.json())

  try {
    const now    = new Date()
    const nowStr = now.toISOString().slice(0, 10)
    const future = new Date(now)
    future.setDate(future.getDate() + 60)
    const futStr = future.toISOString().slice(0, 10)

    // Salones activos
    const salons    = await sb('salons?select=id,name&is_active=eq.true')
    const safeArr   = (v: any): any[] => (Array.isArray(v) ? v : [])

    // Plazos legales (año actual + siguiente para cubrir 60 días)
    const year         = now.getFullYear()
    const allLegal     = [...getLegalDeadlines(year), ...getLegalDeadlines(year + 1)]
    const upcomingLegal = allLegal.filter(l => l.date >= nowStr && l.date <= futStr)

    const allEvents: Array<{
      date: string
      title: string
      salon_id?: string
      salon_name?: string
      tipo: string
      importe?: number
    }> = []

    // Plazos AEAT (sin salón — aplican a todos)
    for (const l of upcomingLegal) {
      allEvents.push({ date: l.date, title: l.title, tipo: 'legal' })
    }

    // Facturas pendientes/vencidas por salón
    const salonResults = await Promise.all(
      safeArr(salons).map(async (salon: any) => {
        const invoices = await sb(
          `invoices?select=id,number,concept,due_date,total,status` +
          `&salon_id=eq.${salon.id}` +
          `&status=in.(pending,overdue,sent)` +
          `&due_date=gte.${nowStr}&due_date=lte.${futStr}` +
          `&order=due_date.asc`
        )
        return { salon, invoices: safeArr(invoices) }
      })
    )

    for (const { salon, invoices } of salonResults) {
      for (const inv of invoices) {
        const dueDate = inv.due_date?.slice(0, 10) || ''
        if (!dueDate) continue
        const importe  = parseFloat(inv.total || 0)
        const concepto = inv.concept || inv.number || 'Factura'
        const emoji    = inv.status === 'overdue' ? '🔴' : '📄'
        allEvents.push({
          date:       dueDate,
          title:      `${emoji} Vence: ${concepto} — ${importe.toFixed(2)}€`,
          salon_id:   salon.id,
          salon_name: salon.name,
          tipo:       inv.status === 'overdue' ? 'vencida' : 'vencimiento',
          importe,
        })
      }
    }

    // Ordenar por fecha
    allEvents.sort((a, b) => a.date.localeCompare(b.date))

    // Generar ICS
    const icsContent = generateICS(
      allEvents.map(e => ({ date: e.date, title: e.title, salon: e.salon_name }))
    )

    // Resumen para Telegram
    const nVencimientos = allEvents.filter(e => e.tipo === 'vencimiento').length
    const nVencidas     = allEvents.filter(e => e.tipo === 'vencida').length
    const nLegal        = allEvents.filter(e => e.tipo === 'legal').length
    const totalExposed  = allEvents
      .filter(e => e.importe)
      .reduce((s, e) => s + (e.importe || 0), 0)

    const nextLines = allEvents.slice(0, 6).map(e => {
      const quien = e.salon_name ? `[${e.salon_name}]` : '[AEAT]'
      return `• ${e.date} ${quien} ${e.title.slice(0, 45)}`
    }).join('\n')

    const tgMsg =
      `📅 <b>Hitos — Próximos 60 días</b>\n\n` +
      `📄 ${nVencimientos} vencimientos de facturas\n` +
      `🔴 ${nVencidas} facturas ya vencidas\n` +
      `⚖️ ${nLegal} plazos AEAT/legales\n` +
      `💶 ${totalExposed.toFixed(2)}€ en juego\n\n` +
      `<b>Próximos hitos:</b>\n${nextLines || 'Sin hitos próximos'}\n\n` +
      `<i>Archivo .ics en el Drive mensual · Diabolus CRM</i>`

    if (TG_TOKEN) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, text: tgMsg, parse_mode: 'HTML' }),
      }).catch(() => {})
    }

    return c.json({
      ok:           true,
      generated_at: now.toISOString(),
      range:        { from: nowStr, to: futStr },
      summary: {
        vencimientos: nVencimientos,
        vencidas:     nVencidas,
        legal:        nLegal,
        total_euros:  Math.round(totalExposed * 100) / 100,
      },
      events:  allEvents,
      ics:     icsContent,
    })

  } catch (err: any) {
    console.error('[CalendarHitos]', err)
    return c.json({ error: err.message }, 500)
  }
})

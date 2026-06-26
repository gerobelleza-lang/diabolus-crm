// @ts-nocheck
import { Hono } from 'hono'

const BOE_API = 'https://www.boe.es/datosabiertos/api/boe/sumario'

const KEYWORDS = [
  'autónomo', 'autonomo', 'RETA', 'cotización', 'cotizacion',
  'IRPF', 'IVA', 'factura', 'facturación', 'facturacion',
  'seguridad social', 'hacienda', 'AEAT', 'tributar',
  'declaración', 'declaracion', 'módulos', 'modulos',
  'rendimiento', 'micropyme', 'pyme', 'SII',
  'recargo', 'retención', 'retencion', 'deducción', 'deduccion',
  'verifactu', 'VeriFactu', 'facturación electrónica',
  'facturacion electronica', 'imputación', 'imputacion',
  'estimación directa', 'estimacion directa', 'cuota'
]

export const boeSemanalRoute = new Hono()

boeSemanalRoute.post('/', async (c) => {
  const secret   = c.req.header('x-internal-secret') || c.req.query('secret') || ''
  const expected = (c.env as any)?.INTERNAL_SECRET || 'diabolus_internal_2026'
  if (secret !== expected) return c.json({ error: 'Forbidden' }, 403)

  const TG_TOKEN = (c.env as any)?.TELEGRAM_BOT_TOKEN || ''
  const TG_CHAT  = (c.env as any)?.TELEGRAM_CHAT_ID   || '8356150792'
  const OR_KEY   = (c.env as any)?.OPENROUTER_API_KEY  || ''

  try {
    const items: { date: string; title: string; url?: string }[] = []
    const today = new Date()

    // Últimos 7 días laborables
    for (let i = 1; i <= 10 && items.length < 40; i++) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const dow = d.getDay()
      if (dow === 0 || dow === 6) continue // skip weekend

      const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '')

      try {
        const res = await fetch(`${BOE_API}/${dateStr}`, {
          headers: { 'Accept': 'application/json' },
        })
        if (!res.ok) continue
        const data: any = await res.json()

        // Estructura: data.data.sumario.diario.seccion[]
        const secciones = data?.data?.sumario?.diario?.seccion ?? []
        const secArr = Array.isArray(secciones) ? secciones : [secciones]

        for (const sec of secArr) {
          const depts = sec?.departamento ?? []
          const deptArr = Array.isArray(depts) ? depts : [depts]

          for (const dept of deptArr) {
            const epArr = [].concat(dept?.epigrafe ?? [])

            for (const ep of epArr) {
              const artArr = [].concat(ep?.item ?? [])

              for (const art of artArr) {
                const titulo: string = art?.titulo ?? ''
                const url: string    = art?.url_html ?? art?.url_pdf ?? ''
                const lower = titulo.toLowerCase()
                const relevant = KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))
                if (relevant) {
                  items.push({ date: dateStr, title: titulo, url })
                }
              }
            }
          }
        }
      } catch (dayErr) {
        console.error(`[BOE] Error fetching ${dateStr}:`, dayErr)
      }
    }

    if (items.length === 0) {
      await sendTelegram(TG_TOKEN, TG_CHAT,
        '📰 <b>Agente BOE Semanal</b>\n\n✅ Sin novedades relevantes para autónomos esta semana.')
      return c.json({ ok: true, items: 0 })
    }

    // Resumen IA
    const rawLines = items.slice(0, 30).map(it => `[${it.date}] ${it.title}`).join('\n')
    let resumen = rawLines

    if (OR_KEY) {
      try {
        const llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OR_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://diabolus-crm.vercel.app',
          },
          body: JSON.stringify({
            model: 'openai/gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content:
                  'Eres un asesor fiscal español especialista en autónomos y pymes. ' +
                  'Analiza estas entradas del BOE y devuelve un resumen ejecutivo directo. ' +
                  'Prioriza: cotizaciones RETA, IRPF, IVA, facturación electrónica, plazos AEAT. ' +
                  'Cita el tipo de norma cuando lo tengas (RD, Orden, Resolución). ' +
                  'Máximo 5 puntos clave con emoji. Sin introducción, solo los puntos. ' +
                  'Si algo es urgente márcalo con 🔴.',
              },
              { role: 'user', content: rawLines },
            ],
            max_tokens: 800,
            temperature: 0.1,
          }),
        })
        const llmJson: any = await llmRes.json()
        const content = llmJson.choices?.[0]?.message?.content
        if (content) resumen = content
      } catch (llmErr) {
        console.error('[BOE] LLM error:', llmErr)
      }
    }

    // Semana de referencia
    const fechaFin   = today.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', timeZone: 'Europe/Madrid' })
    const msg =
      `📰 <b>BOE Semanal — ${items.length} novedades autónomos</b>\n` +
      `<i>Semana hasta ${fechaFin}</i>\n\n` +
      `${resumen}\n\n` +
      `<i>Fuente: boe.es | Diabolus Agente BOE</i>`

    await sendTelegram(TG_TOKEN, TG_CHAT, msg)
    return c.json({ ok: true, items: items.length })

  } catch (err: any) {
    console.error('[BOE Semanal]', err)
    return c.json({ error: err.message }, 500)
  }
})

async function sendTelegram(token: string, chatId: string, text: string) {
  if (!token) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  })
}

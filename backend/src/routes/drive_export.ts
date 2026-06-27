import { Hono } from 'hono'

export const driveExportRoute = new Hono()

/**
 * GET /api/internal/drive-export
 * Genera datos de cierre mensual para todos los salones activos.
 * Llamado por el subagente de Tasklet para subir a Google Drive.
 *
 * Query params:
 *   month=YYYY-MM  (opcional — por defecto mes anterior)
 *   secret=...     (alternativa al header)
 */
driveExportRoute.get('/', async (c) => {
  const secret   = c.req.header('x-internal-secret') || c.req.query('secret') || ''
  const expected = (c.env as any)?.INTERNAL_SECRET || 'diabolus_internal_2026'
  if (secret !== expected) return c.json({ error: 'Forbidden' }, 403)

  const SB_URL = (c.env as any)?.SUPABASE_URL || 'https://emygbvxkhfbwyhbapaae.supabase.co'
  const SB_KEY = (c.env as any)?.SUPABASE_SERVICE_ROLE_KEY || ''

  const sb = (path: string) =>
    fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: {
        apikey:        SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
      },
    }).then(r => r.json())

  // Determinar mes a exportar (por defecto: mes anterior)
  let monthParam = c.req.query('month') || ''
  if (!monthParam) {
    const now   = new Date()
    const y     = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
    const m     = now.getMonth() === 0 ? 12 : now.getMonth()
    monthParam  = `${y}-${String(m).padStart(2, '0')}`
  }

  const [year, month] = monthParam.split('-').map(Number)
  const start = new Date(year, month - 1, 1).toISOString()
  const end   = new Date(year, month, 1).toISOString()

  try {
    // Obtener todos los salones activos
    const salons = await sb('salons?select=id,name,plan,is_active&is_active=eq.true')
    const safeArr = (v: any) => (Array.isArray(v) ? v : [])

    const results = await Promise.all(
      safeArr(salons).map(async (salon: any) => {
        const [txRaw, invoicesRaw] = await Promise.all([
          sb(
            `transactions?select=id,type,amount,description,category,date,created_at` +
            `&salon_id=eq.${salon.id}` +
            `&date=gte.${start}&date=lt.${end}` +
            `&order=date.asc`
          ),
          sb(
            `invoices?select=id,number,status,total,tax_amount,concept,issue_date,due_date,client_id` +
            `&salon_id=eq.${salon.id}` +
            `&issue_date=gte.${start}&issue_date=lt.${end}` +
            `&order=issue_date.asc`
          ),
        ])

        const transactions = safeArr(txRaw)
        const invoices     = safeArr(invoicesRaw)

        // Resumen financiero
        const ingresos = transactions
          .filter((t: any) => t.type === 'income')
          .reduce((s: number, t: any) => s + (parseFloat(t.amount) || 0), 0)

        const gastos = transactions
          .filter((t: any) => t.type === 'expense')
          .reduce((s: number, t: any) => s + (parseFloat(t.amount) || 0), 0)

        const cobradas = invoices
          .filter((i: any) => i.status === 'paid')
          .reduce((s: number, i: any) => s + (parseFloat(i.total) || 0), 0)

        const pendientes = invoices
          .filter((i: any) => i.status === 'pending')
          .reduce((s: number, i: any) => s + (parseFloat(i.total) || 0), 0)

        const vencidas = invoices
          .filter((i: any) => i.status === 'overdue')
          .reduce((s: number, i: any) => s + (parseFloat(i.total) || 0), 0)

        return {
          salon_id:   salon.id,
          salon_name: salon.name,
          plan:       salon.plan,
          month:      monthParam,
          resumen: {
            ingresos:   Math.round(ingresos   * 100) / 100,
            gastos:     Math.round(gastos     * 100) / 100,
            balance:    Math.round((ingresos - gastos) * 100) / 100,
            cobradas:   Math.round(cobradas   * 100) / 100,
            pendientes: Math.round(pendientes * 100) / 100,
            vencidas:   Math.round(vencidas   * 100) / 100,
          },
          transactions: transactions.map((t: any) => ({
            fecha:       t.date?.slice(0, 10) || '',
            tipo:        t.type,
            concepto:    t.description || '',
            categoria:   t.category || '',
            importe:     parseFloat(t.amount) || 0,
          })),
          invoices: invoices.map((i: any) => ({
            numero:      i.number || '',
            estado:      i.status,
            concepto:    i.concept || '',
            emision:     i.issue_date?.slice(0, 10) || '',
            vencimiento: i.due_date?.slice(0, 10) || '',
            total:       parseFloat(i.total) || 0,
            iva:         parseFloat(i.tax_amount) || 0,
          })),
        }
      })
    )

    return c.json({ ok: true, month: monthParam, salons: results })
  } catch (err: any) {
    console.error('[DriveExport] Error:', err)
    return c.json({ error: err.message }, 500)
  }
})

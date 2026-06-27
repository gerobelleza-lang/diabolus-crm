// @ts-nocheck
// ─── Numeración configurable de facturas ────────────────────────────────────
// Tabla requerida en Supabase (ejecutar una vez):
//
// CREATE TABLE IF NOT EXISTS invoice_numbering (
//   salon_id     uuid PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
//   prefix       text    NOT NULL DEFAULT 'FAC',
//   separator    text    NOT NULL DEFAULT '-',
//   include_year boolean NOT NULL DEFAULT true,
//   pad_digits   int     NOT NULL DEFAULT 4,
//   next_number  int     NOT NULL DEFAULT 1,
//   updated_at   timestamptz DEFAULT now()
// );
//
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string }
export const invoiceNumberingRoutes = new Hono<{ Variables: Variables }>()

// ─── Formatear número de factura ─────────────────────────────────────────────
function formatInvoiceNumber(config: {
  prefix: string
  separator: string
  include_year: boolean
  pad_digits: number
  next_number: number
}): string {
  const { prefix, separator, include_year, pad_digits, next_number } = config
  const seq = String(next_number).padStart(pad_digits, '0')
  if (include_year) {
    const year = new Date().getFullYear()
    return `${prefix}${separator}${year}${separator}${seq}`
  }
  return `${prefix}${separator}${seq}`
}

// ─── Config por defecto ───────────────────────────────────────────────────────
function defaultConfig(salonId: string) {
  return { salon_id: salonId, prefix: 'FAC', separator: '-', include_year: true, pad_digits: 4, next_number: 1 }
}

// ─── Leer config de Supabase ──────────────────────────────────────────────────
async function getConfig(salonId: string) {
  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase.from('invoice_numbering').select('*').eq('salon_id', salonId).single()
    return data || defaultConfig(salonId)
  } catch {
    return defaultConfig(salonId)
  }
}

// ─── Incrementar contador (fire and forget seguro) ────────────────────────────
export async function incrementInvoiceCounter(salonId: string): Promise<void> {
  try {
    const supabase = getSupabaseAdmin()
    const cfg = await getConfig(salonId)
    await supabase
      .from('invoice_numbering')
      .upsert(
        { ...cfg, salon_id: salonId, next_number: cfg.next_number + 1, updated_at: new Date().toISOString() },
        { onConflict: 'salon_id' }
      )
  } catch { /* silencioso */ }
}

// ─── Reservar siguiente número (preview + incrementa) ─────────────────────────
// Usar SOLO cuando el frontend no envía número (backend genera y reserva)
export async function reserveNextInvoiceNumber(salonId: string): Promise<string> {
  try {
    const cfg = await getConfig(salonId)
    const formatted = formatInvoiceNumber(cfg)
    await incrementInvoiceCounter(salonId)
    return formatted
  } catch {
    return `FAC-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`
  }
}

// ─── GET /api/invoices/numbering — leer config ────────────────────────────────
invoiceNumberingRoutes.get('/numbering', async (c) => {
  const salonId = c.get('salonId')
  const cfg = await getConfig(salonId)
  return c.json({ config: cfg, preview: formatInvoiceNumber(cfg) })
})

// ─── POST /api/invoices/numbering — guardar config ────────────────────────────
invoiceNumberingRoutes.post('/numbering', async (c) => {
  const salonId = c.get('salonId')
  const body = await c.req.json().catch(() => ({}))
  const supabase = getSupabaseAdmin()
  const current = await getConfig(salonId)
  const payload: Record<string, any> = {
    salon_id:     salonId,
    prefix:       (body.prefix !== undefined)      ? String(body.prefix).toUpperCase().slice(0, 10)    : current.prefix,
    separator:    (body.separator !== undefined)    ? String(body.separator).slice(0, 3)               : current.separator,
    include_year: (body.include_year !== undefined) ? Boolean(body.include_year)                       : current.include_year,
    pad_digits:   (body.pad_digits !== undefined)   ? Math.max(1, Math.min(8, Number(body.pad_digits))) : current.pad_digits,
    next_number:  (body.next_number !== undefined)  ? Math.max(1, Number(body.next_number))             : current.next_number,
    updated_at:   new Date().toISOString(),
  }
  try {
    const { data, error } = await supabase
      .from('invoice_numbering')
      .upsert(payload, { onConflict: 'salon_id' })
      .select()
      .single()
    if (error) throw error
    return c.json({ ok: true, saved: true, config: data, preview: formatInvoiceNumber(data as any) })
  } catch {
    // tabla aún no existe → devolver preview calculado
    const preview = formatInvoiceNumber(payload as any)
    return c.json({ ok: true, saved: false, preview, note: 'Tabla invoice_numbering pendiente de crear en Supabase' })
  }
})

// ─── GET /api/invoices/next-number — preview SIN incrementar ──────────────────
// El frontend lo usa para pre-rellenar el campo; el contador sube al crear la factura
invoiceNumberingRoutes.get('/next-number', async (c) => {
  const salonId = c.get('salonId')
  const cfg = await getConfig(salonId)
  return c.json({ number: formatInvoiceNumber(cfg) })
})

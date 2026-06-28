import { z } from 'zod'

// ── Auth ─────────────────────────────────────────────────────────────────────
export const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Contraseña mínima 6 caracteres'),
})

export const registerSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Contraseña mínima 6 caracteres'),
  nombre: z.string().min(1, 'Nombre requerido').max(100).optional(),
})

// ── Clients ──────────────────────────────────────────────────────────────────
export const createClientSchema = z.object({
  name: z.string().min(1, 'Nombre requerido').max(200),
  phone: z.string().max(20).optional().nullable(),
  email: z.string().email().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
})

export const updateClientSchema = createClientSchema.partial()

// ── Transactions ─────────────────────────────────────────────────────────────
export const createTransactionSchema = z.object({
  type: z.enum(['income', 'expense']),
  amount: z.number().positive('Cantidad debe ser positiva'),
  description: z.string().min(1, 'Descripción requerida').max(500),
  category_id: z.string().uuid().optional().nullable(),
  date: z.string().optional(),
  client_id: z.string().uuid().optional().nullable(),
  invoice_id: z.string().uuid().optional().nullable(),
})

// ── Invoices ─────────────────────────────────────────────────────────────────
export const createInvoiceSchema = z.object({
  client_id: z.string().uuid('Client ID inválido'),
  items: z.array(z.object({
    description: z.string().min(1),
    quantity: z.number().positive(),
    unit_price: z.number().min(0),
    iva_rate: z.number().min(0).max(100).optional(),
  })).min(1, 'Al menos un item requerido'),
  notes: z.string().max(2000).optional().nullable(),
  due_date: z.string().optional().nullable(),
  status: z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']).optional(),
})

// ── Agent Chat ───────────────────────────────────────────────────────────────
export const agentChatSchema = z.object({
  message: z.string().min(1, 'Mensaje requerido').max(2000),
  brain_tier: z.enum(['rapida', 'inteligente', 'brillante']).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
})

// ── Waitlist ─────────────────────────────────────────────────────────────────
export const waitlistSchema = z.object({
  nombre: z.string().min(1, 'Nombre requerido').max(100),
  email: z.string().email('Email inválido'),
  empresa: z.string().max(200).optional(),
})

// ── Cazador Config ───────────────────────────────────────────────────────────
export const cazadorConfigSchema = z.object({
  warning_days: z.array(z.number().int().positive()).optional(),
  templates: z.record(z.string(), z.string()).optional(),
  active: z.boolean().optional(),
})

// ── Categories ───────────────────────────────────────────────────────────────
export const categorySchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['income', 'expense']).optional(),
  color: z.string().max(20).optional(),
})

// ── TTS ──────────────────────────────────────────────────────────────────────
export const ttsSchema = z.object({
  text: z.string().min(1).max(1000),
  voice: z.string().optional(),
  speed: z.number().min(0.25).max(4).optional(),
  hd: z.boolean().optional(),
})

// ── Validator helper ─────────────────────────────────────────────────────────
type ValidationOk<T> = { ok: true; data: T; error?: undefined }
type ValidationFail = { ok: false; data?: undefined; error: string }

export function validate<T>(schema: z.ZodType<T>, data: unknown): ValidationOk<T> | ValidationFail {
  const result = schema.safeParse(data)
  if (result.success) {
    return { ok: true, data: result.data }
  }
  const messages = result.error.issues.map((i: any) => i.message).join('; ')
  return { ok: false, error: messages }
}

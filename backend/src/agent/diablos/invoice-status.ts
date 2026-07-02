/**
 * 🔐 INVOICE_STATUS — Fuente única de verdad
 *
 * Constraint BD: invoices_status_check → CHECK (status IN ('draft', 'sent', 'paid'))
 *
 * Reglas:
 * - "vencida" NO es status almacenado. Se DERIVA de: status='sent' AND due_date < now()
 * - "pendiente" (español) → mapea a 'sent' (la factura está enviada/pendiente de pago)
 * - "pagada" (español) → mapea a 'paid'
 * - "anulada"/"cancelled" → DIFERIDO. Será factura rectificativa con VeriFactu. 
 *   NO añadir al constraint sin migración explícita aprobada por Miguel.
 *
 * Importado por: facturador, confirmation, guardian, cazador, cobrador, contable
 * NINGÚN Diablo debe usar strings hardcodeados para invoices.status.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS VALUES (constraint BD)
// ═══════════════════════════════════════════════════════════════════════════════

export const INVOICE_STATUS = {
  DRAFT: 'draft',
  SENT:  'sent',
  PAID:  'paid',
} as const

export type InvoiceStatus = typeof INVOICE_STATUS[keyof typeof INVOICE_STATUS]

/** Todos los valores válidos para el CHECK constraint */
export const VALID_STATUSES: readonly InvoiceStatus[] = [
  INVOICE_STATUS.DRAFT,
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.PAID,
]

// ═══════════════════════════════════════════════════════════════════════════════
// SPANISH → DB MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

/** Mapeo español → valor BD. "vencida" y "anulada" son DERIVADOS, no status. */
const SPANISH_MAP: Record<string, InvoiceStatus | null> = {
  // Directos
  'draft':      INVOICE_STATUS.DRAFT,
  'sent':       INVOICE_STATUS.SENT,
  'paid':       INVOICE_STATUS.PAID,
  // Español → DB
  'borrador':   INVOICE_STATUS.DRAFT,
  'pendiente':  INVOICE_STATUS.SENT,
  'enviada':    INVOICE_STATUS.SENT,
  'pagada':     INVOICE_STATUS.PAID,
  'pagado':     INVOICE_STATUS.PAID,
  'cobrada':    INVOICE_STATUS.PAID,
  // Derivados — NO se almacenan
  'vencida':    null,
  'anulada':    null,
  'cancelada':  null,
  'cancelled':  null,
}

export interface StatusMapResult {
  /** null si el estado es derivado y no se puede almacenar */
  dbStatus: InvoiceStatus | null
  /** true si el input es un estado derivado (vencida, anulada) */
  isDerived: boolean
  /** Mensaje de error amigable para estados derivados */
  derivedError: string | null
}

/**
 * Mapea un estado en español/inglés al valor BD.
 * Retorna null + error descriptivo si es un estado derivado.
 */
export function mapStatusToDB(input: string): StatusMapResult {
  const normalized = input.trim().toLowerCase()
  
  if (!(normalized in SPANISH_MAP)) {
    return {
      dbStatus: null,
      isDerived: false,
      derivedError: `❌ Estado "${input}" no reconocido. Estados válidos: borrador, pendiente/enviada, pagada.`,
    }
  }

  const mapped = SPANISH_MAP[normalized]
  
  if (mapped === null) {
    // Es derivado — ofrecer alternativa según Miguel (condición 2)
    if (normalized === 'vencida') {
      return {
        dbStatus: null,
        isDerived: true,
        derivedError:
          `⚠️ "Vencida" no es un estado que se guarde — se calcula automáticamente ` +
          `cuando una factura enviada supera su fecha de vencimiento.\n\n` +
          `¿Quieres ver tus facturas vencidas? Dime "facturas vencidas" y te las muestro.`,
      }
    }
    // anulada / cancelada
    return {
      dbStatus: null,
      isDerived: true,
      derivedError:
        `⚠️ La anulación de facturas se gestionará mediante factura rectificativa ` +
        `(requisito VeriFactu). Por ahora no es posible anular directamente.\n\n` +
        `Si necesitas marcarla como no válida, contacta a Miguel.`,
    }
  }

  return { dbStatus: mapped, isDerived: false, derivedError: null }
}

/**
 * Valida que un valor es un status válido para la BD.
 * Uso: antes de cualquier INSERT/UPDATE a invoices.status
 */
export function isValidDBStatus(value: string): value is InvoiceStatus {
  return (VALID_STATUSES as readonly string[]).includes(value)
}

/**
 * Status activos (no pagados) — para queries de facturas "pendientes"
 * NUNCA incluye 'pending' (no existe en la BD)
 */
export const ACTIVE_STATUSES: readonly InvoiceStatus[] = [
  INVOICE_STATUS.DRAFT,
  INVOICE_STATUS.SENT,
]

/**
 * Status para facturas "vencidas" — derivación correcta
 * WHERE status = 'sent' AND due_date < now()
 */
export const OVERDUE_QUERY_STATUS = INVOICE_STATUS.SENT

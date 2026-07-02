/**
 * 🔐 DOCUMENT_STATUS — Fuente única de verdad para documents.status
 *
 * Constraint BD: documents_status_check → CHECK (status IN ('draft', 'sent', 'accepted', 'rejected'))
 *
 * Patrón INVOICE_STATUS: módulo centralizado, importado por Escribano y confirmation.
 * NINGÚN Diablo debe usar strings hardcodeados para documents.status.
 */

export const DOCUMENT_STATUS = {
  DRAFT:    'draft',
  SENT:     'sent',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
} as const

export type DocumentStatus = typeof DOCUMENT_STATUS[keyof typeof DOCUMENT_STATUS]

export const VALID_DOC_STATUSES: readonly DocumentStatus[] = [
  DOCUMENT_STATUS.DRAFT,
  DOCUMENT_STATUS.SENT,
  DOCUMENT_STATUS.ACCEPTED,
  DOCUMENT_STATUS.REJECTED,
]

export const DOCUMENT_TYPES = {
  ALBARAN:      'albaran',
  PRESUPUESTO:  'presupuesto',
} as const

export type DocumentType = typeof DOCUMENT_TYPES[keyof typeof DOCUMENT_TYPES]

export const VALID_DOC_TYPES: readonly DocumentType[] = [
  DOCUMENT_TYPES.ALBARAN,
  DOCUMENT_TYPES.PRESUPUESTO,
]

/** Mapeo español → DB */
const STATUS_MAP: Record<string, DocumentStatus | null> = {
  'draft':      DOCUMENT_STATUS.DRAFT,
  'sent':       DOCUMENT_STATUS.SENT,
  'accepted':   DOCUMENT_STATUS.ACCEPTED,
  'rejected':   DOCUMENT_STATUS.REJECTED,
  'borrador':   DOCUMENT_STATUS.DRAFT,
  'enviado':    DOCUMENT_STATUS.SENT,
  'enviada':    DOCUMENT_STATUS.SENT,
  'aceptado':   DOCUMENT_STATUS.ACCEPTED,
  'aceptada':   DOCUMENT_STATUS.ACCEPTED,
  'rechazado':  DOCUMENT_STATUS.REJECTED,
  'rechazada':  DOCUMENT_STATUS.REJECTED,
}

export function mapDocStatusToDB(input: string): DocumentStatus | null {
  return STATUS_MAP[input.trim().toLowerCase()] ?? null
}

export function isValidDocStatus(value: string): value is DocumentStatus {
  return (VALID_DOC_STATUSES as readonly string[]).includes(value)
}

export function isValidDocType(value: string): value is DocumentType {
  return (VALID_DOC_TYPES as readonly string[]).includes(value)
}

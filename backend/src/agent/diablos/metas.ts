/**
 * diablos/metas.ts — Diablo metadata & types
 * Separate file to avoid circular dependencies with index.ts
 */

import type { AgentInput } from '../core'

// ─── Diablo types ──────────────────────────────────────────────────────────

export type DiabloName =
  | 'facturador'
  | 'cobrador'
  | 'contable'
  | 'closer'
  | 'cazador'
  | 'abogado'
  | 'escribano'
  | 'guardian'
  | 'confesor'

export interface DiabloMeta {
  name: DiabloName
  emoji: string
  displayName: string
  description: string
  temperature: number
}

export interface DiabloResponse {
  replyText?: string
  card?: any // ConfirmationCard
  needsInfo?: string
  source?: 'photo' | 'text'
  camposDudosos?: string[]
  confianza?: 'alta' | 'media' | 'baja'
  routing?: { level: string; model: string; label: string; estimatedCost: string }
}

export interface IntentClassification {
  diablo: DiabloName | 'diablilla'
  intent: string
  confidence: number
}

export interface DiabloHandler {
  meta: DiabloMeta
  handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse>
}

// ─── Diablo tag for chat UI ────────────────────────────────────────────────

export const DIABLO_TAGS: Record<DiabloName, string> = {
  facturador: '🧾 vía El Facturador',
  cobrador:   '💰 vía El Cobrador',
  contable:   '📊 vía El Contable',
  closer:     '🤝 vía El Closer',
  cazador:    '🏹 vía El Cazador',
  abogado:    '⚖️ vía El Abogado',
  escribano:  '📜 vía El Escribano',
  guardian:   '🛡️ vía El Guardián',
  confesor:   '🪞 vía El Confesor',
}

export const DIABLO_METAS: Record<DiabloName, DiabloMeta> = {
  facturador: {
    name: 'facturador', emoji: '🧾', displayName: 'El Facturador',
    description: 'Crea y envía tus facturas', temperature: 0.2,
  },
  cobrador: {
    name: 'cobrador', emoji: '💰', displayName: 'El Cobrador',
    description: 'Persigue los pagos pendientes', temperature: 0.3,
  },
  contable: {
    name: 'contable', emoji: '📊', displayName: 'El Contable',
    description: 'Registra ingresos y gastos', temperature: 0.1,
  },
  closer: {
    name: 'closer', emoji: '🤝', displayName: 'El Closer',
    description: 'Gestiona tu cartera de clientes', temperature: 0.2,
  },
  cazador: {
    name: 'cazador', emoji: '🏹', displayName: 'El Cazador',
    description: 'Trae leads nuevos', temperature: 0.4,
  },
  abogado: {
    name: 'abogado', emoji: '⚖️', displayName: 'El Abogado',
    description: 'Asesoría legal española', temperature: 0.1,
  },
  escribano: {
    name: 'escribano', emoji: '📜', displayName: 'El Escribano',
    description: 'Albaranes y presupuestos', temperature: 0.2,
  },
  guardian: {
    name: 'guardian', emoji: '🛡️', displayName: 'El Guardián',
    description: 'Vigila riesgos y alertas', temperature: 0.3,
  },
  confesor: {
    name: 'confesor', emoji: '🪞', displayName: 'El Confesor',
    description: 'Te guía con la app', temperature: 0.7,
  },
}

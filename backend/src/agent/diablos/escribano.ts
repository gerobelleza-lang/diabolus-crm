/**
 * 📜 El Escribano — Documenta todo.
 *
 * Maneja: albaranes, contratos, presupuestos (vía parser intent crear_albaran).
 * La lógica principal vive en routes/albaran.ts y routes/documents.ts.
 */

import { DIABLO_METAS } from './index'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const userInput = (input.text || '').trim()

  if (classification.intent === 'crear_albaran') {
    // The albaran creation is handled by the existing route
    // From chat, we guide the user to use the albaran endpoint
    return {
      replyText: [
        '📜 Para crear un albarán necesito:',
        '• Cliente (nombre)',
        '• Descripción del servicio/producto',
        '• Cantidad e importe',
        '',
        'Ej: "albarán para López por 3 cajas de material a 50€"',
        '',
        'O puedes crearlo desde el panel de documentos en el dashboard.',
      ].join('\n'),
    }
  }

  return {
    replyText: '📜 Dime qué documento necesitas: albarán, contrato o presupuesto. Ej: "albarán para López 500€ instalación".',
  }
}

export const EscribanoDiablo: DiabloHandler = {
  meta: DIABLO_METAS.escribano,
  handle,
}

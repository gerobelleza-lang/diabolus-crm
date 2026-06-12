// ROUTER — decide por qué nivel se resuelve cada consulta.
// Nivel 0: parser determinista (0€)
// Nivel 1: modelo pequeño, 1 acción
// Nivel 2: modelo pequeño, tools encadenadas (multi-paso)
// Nivel 3: modelo grande (análisis/comparación/predicción)
// Cada decisión queda loggeada con coste estimado para medir el objetivo: <0,002€/consulta media.

import { parseDeterministic, normalize } from './parser.js';
import type { RouteDecision } from './types.js';

const ANALYSIS_MARKERS = [
  'como va', 'cuanto llevo', 'compara', 'comparacion', 'analiza', 'analisis',
  'predice', 'prediccion', 'tendencia', 'trimestre', 'vs', 'frente a',
  'mejor mes', 'peor mes', 'resumen del', 'evolucion',
];

const MULTI_STEP_MARKERS = [' y ', ' luego ', ' despues ', ' ademas ', ', '];

const ACTION_VERBS = [
  'apunta', 'crea', 'factura', 'registra', 'cobra', 'manda', 'envia',
  'recuerda', 'avisa', 'ingresa', 'gasta', 'prepara', 'genera',
];

/** Coste estimado por nivel en euros (para métricas, no facturación) */
export const LEVEL_COST: Record<0 | 1 | 2 | 3, number> = {
  0: 0,
  1: 0.001,
  2: 0.003,
  3: 0.02,
};

export function route(input: string): RouteDecision {
  // Nivel 0: ¿lo resuelve el parser sin ambigüedad?
  const parsed = parseDeterministic(input);
  if (parsed) {
    return { level: 0, reason: 'parser determinista: patrón exacto', toolCall: parsed.toolCall };
  }

  const text = normalize(input);

  // Nivel 3: consultas de análisis/comparación → modelo grande
  for (const marker of ANALYSIS_MARKERS) {
    if (text.includes(marker)) {
      return { level: 3, reason: `análisis detectado ("${marker.trim()}")` };
    }
  }

  // Nivel 2: multi-paso → varios verbos de acción o conectores
  const verbCount = ACTION_VERBS.filter((v) => text.includes(v)).length;
  const hasConnector = MULTI_STEP_MARKERS.some((m) => text.includes(m));
  if (verbCount >= 2 || (verbCount >= 1 && hasConnector)) {
    return { level: 2, reason: `multi-paso (verbos: ${verbCount}, conector: ${hasConnector})` };
  }

  // Nivel 1: todo lo demás → modelo pequeño con tools
  return { level: 1, reason: 'frase natural simple' };
}

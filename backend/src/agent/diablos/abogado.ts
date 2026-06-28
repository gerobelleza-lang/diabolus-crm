/**
 * ⚖️ El Abogado — Legislación española real.
 *
 * Especialista en derecho fiscal, laboral, mercantil y LOPD/RGPD
 * para autónomos y PYMEs españolas.
 *
 * Temp: 0.1 (máxima precisión legal)
 * max_tokens: 2000 (respuestas completas con citas)
 */

import { DIABLO_METAS } from './index'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'
import { routeToLLM, callOpenRouter } from '../llm-router'
import { getSalonAIConfig } from '../memory'
import type { BrainTier } from '../memory'

const ABOGADO_SYSTEM_PROMPT = `Eres El Abogado de Diabolus. Asesor legal digital para autónomos y PYMEs en España.

REGLAS ABSOLUTAS:
1. Cita SIEMPRE el artículo, ley o Real Decreto exacto. Formato: "Art. 164 Ley 37/1992 del IVA"
2. Si no conoces la norma exacta: "Consulta esto con un abogado colegiado antes de actuar"
3. NUNCA inventes artículos, números de ley o fechas de BOE
4. Distingue entre obligación legal y recomendación práctica

ESTILO:
- Asesor directo que va al grano, no profesor universitario
- Primero la respuesta práctica, luego la base legal
- Si hay plazo, dilo claro: "Tienes hasta el 20 de julio"
- Si hay sanción, cuantifícala: "Multa de 150€ a 6.000€"

ÁREAS DE CONOCIMIENTO:
- IVA: tipos, exenciones, modelos 303/390, régimen simplificado, recargo equivalencia
- IRPF: estimación directa/objetiva, retenciones, modelo 130/131
- Seguridad Social: RETA, cuota autónomos, tarifa plana, pluriactividad
- Facturación: requisitos legales, conservación, factura electrónica
- VeriFactu: calendario de implantación obligatoria
- LOPD/RGPD: registro actividades, consentimiento, delegado protección datos
- Contratos laborales: tipos, bonificaciones, despido, finiquito
- Mercantil: constitución SL, responsabilidad autónomo, herencias empresa

CONTEXTO NORMATIVO ACTUAL:
- Cotización autónomos por ingresos reales (RD-ley 13/2022)
- Ley Crea y Crece: factura electrónica B2B obligatoria (en implantación)
- Kit Digital: ayudas para digitalización (hasta 12.000€ segmento I)`

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const userInput = (input.text || '').trim()
  const { tenantId } = input

  try {
    const aiConfig = await getSalonAIConfig(tenantId)
    const brainTier: BrainTier = aiConfig.brain_tier || 'rapida'
    const routing = routeToLLM(0.5, userInput, false, brainTier)

    const response = await callOpenRouter(
      routing.model,
      userInput,
      ABOGADO_SYSTEM_PROMPT,
      { temperature: 0.1, max_tokens: 2000 }
    )

    return {
      replyText: response,
      routing: {
        level: routing.level,
        model: routing.model,
        label: '⚖️ El Abogado',
        estimatedCost: `€${routing.estimatedCost}`,
      },
    }
  } catch {
    return { replyText: 'No pude consultar la base legal ahora. Inténtalo en un momento.' }
  }
}

export const AbogadoDiablo: DiabloHandler = {
  meta: DIABLO_METAS.abogado,
  handle,
}

/**
 * LLM Router — L0→L1→L2→L3
 *
 * Decisión de qué modelo usar basada en complejidad de query
 * L0: Parser deterministic (€0.00, instant)
 * L1: Haiku (€0.001, para queries simple)
 * L2: Sonnet + tools (€0.005, para acciones)
 * L3: GPT-4 (€0.02, análisis complejo)
 */

export interface RoutingDecision {
  level: 'L0' | 'L1' | 'L2' | 'L3'
  model: string
  rationale: string
  estimatedCost: number
}

/**
 * Decide qué nivel de LLM usar basado en:
 * - Confianza del parser L0
 * - Complejidad de la query
 * - Necesidad de tools externos
 */
export function routeToLLM(
  parserConfidence: number,
  userInput: string,
  needsTools: boolean
): RoutingDecision {
  // L0 is confident enough
  if (parserConfidence > 0.85 && !needsTools) {
    return {
      level: 'L0',
      model: 'parser',
      rationale: 'Parser L0 confident (>85%). No tools needed.',
      estimatedCost: 0
    }
  }

  // Simple query, slight doubts
  if (parserConfidence > 0.7 && userInput.length < 100) {
    return {
      level: 'L1',
      model: 'anthropic/claude-haiku-4.5',
      rationale: 'Parser semi-confident (70-85%). Simple query (<100 chars).',
      estimatedCost: 0.001
    }
  }

  // Needs to execute actions (create/update)
  if (needsTools || userInput.includes('crear') || userInput.includes('crear')) {
    return {
      level: 'L2',
      model: 'anthropic/claude-sonnet-4.5',
      rationale: 'Tools needed or action requested. Use Sonnet.',
      estimatedCost: 0.005
    }
  }

  // Complex analysis (report, summary, insights)
  if (
    userInput.includes('analiza') ||
    userInput.includes('analizar') ||
    userInput.includes('resumen') ||
    userInput.includes('insights') ||
    userInput.length > 200
  ) {
    return {
      level: 'L3',
      model: 'openai/gpt-4-turbo',
      rationale: 'Complex analysis or long input. Use GPT-4.',
      estimatedCost: 0.02
    }
  }

  // Default: use Sonnet for safety
  return {
    level: 'L2',
    model: 'anthropic/claude-sonnet-4.5',
    rationale: 'Default to Sonnet for balanced accuracy/cost.',
    estimatedCost: 0.005
  }
}

/**
 * Llama OpenRouter con el modelo decidido
 */
export async function callOpenRouter(
  model: string,
  userMessage: string,
  systemPrompt?: string
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set. Fallback to L0 parser.')
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://diabolus.crm',
      'X-Title': 'Diabolus CRM'
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: userMessage }
      ],
      temperature: 0.2,
      max_tokens: 800
    })
  })

  if (!response.ok) {
    throw new Error(`OpenRouter error: ${response.statusText}`)
  }

  const data = (await response.json()) as any
  return data.choices?.[0]?.message?.content || 'No response from LLM'
}

/**
 * System prompt para Diabolus — Agente Principal
 * Actualizado jun-2026 con prompt de producto definitivo
 */
export const DIABOLUS_SYSTEM_PROMPT = `# QUIÉN SOY

Soy el Agente Ejecutor de Diabolus. Solo ejecuto comandos dentro de la app. NO soy ChatGPT. No respondo preguntas de cultura general, no doy consejos, no explico conceptos. Solo ejecuto acciones y respondo consultas de la app. Soy rápido, preciso y directo.

# MI ALCANCE — LO QUE EJECUTO

## 💰 TESORERÍA (ingresos y gastos)
- Registrar cobro / ingreso
- Registrar gasto / pago
- Consultar balance del día, semana o mes
- Ver total cobrado o gastado hoy / esta semana / este mes

## 🧾 FACTURAS
- Crear factura borrador
- Enviar factura por email
- Cambiar estado de factura (pagada, pendiente, cancelada)
- Ver facturas pendientes o vencidas

## 👥 CLIENTES
- Crear nuevo cliente
- Buscar cliente existente
- Ver cuánto debe un cliente

## ⚡ RECORDATORIOS (Cazador)
- Enviar recordatorio de cobro a un cliente
- Ver quién me debe y cuánto

## 📄 DOCUMENTOS / CONTRATOS
- Para generar contratos: el usuario va a Módulos > Documentos

# FUERA DE MI ALCANCE → REDIRIGIR SIEMPRE

Si el usuario pregunta algo fuera de mi alcance, respondo con una frase corta y redirijo:
- Preguntas legales, dudas sobre leyes o contratos → "Para eso está el Agente Legal en Módulos > Legal."
- Conflictos o problemas con clientes → "No gestiono conflictos. Para asesoramiento: Módulos > Legal."
- Preguntas de negocio genéricas, marketing, consejos → "Solo ejecuto acciones en Diabolus. ¿Registramos algo?"
- Cualquier cosa que no sea una acción de la app → redirigir brevemente, sin explicaciones largas.

# NORMAS OBLIGATORIAS DE REGISTRO (CRÍTICO)

## Al registrar un INGRESO o COBRO:
Antes de mostrar la tarjeta de confirmación, SIEMPRE necesito estos 3 datos:
1. **Importe** (€) — obligatorio. Si falta, pregunto.
2. **Concepto** — OBLIGATORIO. Qué servicio o producto (ej: "corte de pelo", "color completo", "manicura francesa"). NUNCA uso "Servicio" como concepto por defecto. Si falta, pregunto.
3. **¿Con IVA incluido o sin IVA?** — Si el usuario no lo especifica, asumo IVA 21% incluido y lo muestro en la confirmación para que pueda corregir.
4. **Cliente** — opcional. Si no lo dice, registro como "Cliente general".

Ejemplo de lo que pregunto si falta concepto:
"¿De qué servicio? Y dime si los 29€ llevan IVA incluido o son base imponible."

## Al registrar un GASTO:
SIEMPRE necesito:
1. **Importe** (€) — obligatorio
2. **Concepto** — OBLIGATORIO. Qué es el gasto (ej: "tinte Wella", "alquiler local", "electricidad"). NUNCA uso "Gasto" como concepto por defecto. Si falta, pregunto.
3. Categoría — la asigno automáticamente y la muestro en la confirmación.

## Al crear una FACTURA:
1. Cliente — obligatorio (busco en la base de datos)
2. Concepto / servicio — obligatorio
3. Importe — obligatorio
4. IVA — por defecto 21%, lo muestro en la confirmación

# CONFIRMACIÓN ANTES DE ACTUAR (INNEGOCIABLE)

TODA acción que escribe o envía datos requiere confirmación explícita del usuario.
Formato de propuesta de confirmación:
"✅ Voy a registrar:
• Ingreso: 45€
• Concepto: Manicura francesa
• IVA: 21% incluido (base 37,19€ + 7,81€ IVA)
• Cliente: María García
¿Confirmas?"

NUNCA digo "hecho", "guardado" ni "enviado" antes de que el usuario confirme Y la acción se ejecute realmente. Esta regla no se rompe jamás.

# CONSULTAS → RESPUESTA INMEDIATA (sin confirmación)

Balance, cobros del día, gastos, deudores, facturas vencidas → respondo directo con datos reales. Sin rodeos.

# TONO Y ESTILO

Directo y muy breve. El usuario está entre cliente y cliente. Sin tutoriales. Sin presentaciones en cada mensaje. Máximo 3 líneas por respuesta de acción. Las respuestas de consulta pueden ser un poco más largas si los datos lo requieren.`

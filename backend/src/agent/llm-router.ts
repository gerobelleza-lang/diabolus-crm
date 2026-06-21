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
export const DIABOLUS_SYSTEM_PROMPT = `# IDENTIDAD

Eres el asistente financiero y operativo de Diabolus para un negocio de servicios en España (sobre todo salones de belleza, estética y bienestar). Gestionas la tesorería del usuario HABLANDO: él te habla en lenguaje natural y tú ejecutas la acción real — pidiéndole siempre permiso antes de tocar nada. Conoces su negocio en tiempo real: cuánto entra, cuánto sale y quién le debe.

# REGLAS DE ORO (innegociables)

1. CONFIRMACIÓN ANTES DE ACTUAR. Toda acción que ESCRIBE o ENVÍA (registrar, crear, modificar, enviar) se PROPONE primero y solo se ejecuta tras la confirmación explícita del usuario. NUNCA digas "hecho", "guardado" ni "enviado" antes de que el usuario confirme y la acción se haya ejecutado de verdad. Esta regla es el alma del producto: no se rompe jamás.

2. LAS CONSULTAS SON INMEDIATAS. Balance, deudores y facturas vencidas se responden al momento, sin confirmación.

3. NUNCA INVENTES DATOS. Si falta algo imprescindible (importe, cliente, email, concepto), pregúntalo en una sola frase. No supongas. Y en especial: NUNCA inventes un importe — si una foto no se lee con seguridad, déjalo en blanco y pídelo. Un número inventado en un registro financiero es inaceptable.

4. USA DATOS REALES. Consulta los registros reales del negocio (facturas, clientes, transacciones). No te inventes saldos ni cifras; si no hay dato, dilo.

5. AL GRANO. Respuestas cortas y directas. Sin tutoriales, sin florituras. Hablas a una persona ocupada entre cliente y cliente.

# CÓMO RAZONAS (en cada mensaje)

1. Entiende la intención del usuario en lenguaje natural.
2. Elige la acción correcta y rellena sus datos desde el mensaje y, si hace falta, desde la base de datos real.
3. ¿Falta un dato imprescindible? Pregúntalo (una frase) antes de proponer nada.
4. ¿Es una consulta? Responde directo. ¿Es escritura o envío? Propón una confirmación clara —qué acción, sobre qué, con qué datos— y espera el OK. En los envíos, muestra el TEXTO EXACTO que vas a mandar.
5. Solo tras el OK y la ejecución real, confirma que está hecho.

# QUÉ HACES

— ACCIONES (requieren confirmación) —

1. REGISTRAR INGRESO. "cobré 150 de Ana por corte" → importe, cliente, concepto.
2. REGISTRAR GASTO. "gasté 80 en tinte" → importe, concepto; sugiere la categoría de la lista estándar.
3. LEER TICKET POR FOTO. El usuario manda una foto → extrae importe, concepto, proveedor y fecha → propón confirmación. NUNCA inventes el importe; si no se lee claro, pídelo.
4. CREAR CLIENTE. "nuevo cliente Ana García, tel 612345678" → nombre, teléfono, email, NIF.
5. CREAR FACTURA (BORRADOR). "crea factura para Ana por 150" → busca el cliente, prepara líneas, IVA y totales. Preparas un BORRADOR; NO es emisión oficial.
6. ENVIAR FACTURA POR EMAIL. "mándale la factura a Ana" → desde noreply@diabolus.es; muestra qué se envía antes de mandarlo.
7. CAMBIAR ESTADO DE FACTURA. "la factura de Ana está pagada" → localiza la factura, actualiza el estado. Si hay varias y es ambiguo, pregunta cuál.
8. ENVIAR RECORDATORIO DE COBRO. "manda recordatorio a Ana" → busca su factura pendiente, prepara el mensaje, MUÉSTRALO (preview) y, tras el OK, envía por WhatsApp o email.

— CONSULTAS (inmediatas, sin confirmación) —

9. BALANCE DEL MES. "¿cuánto tengo?" → ingresos, gastos y balance neto del mes.
10. QUIÉN DEBE. "¿quién me debe?" → clientes con facturas pendientes, importes y vencimientos.
11. FACTURAS VENCIDAS. Las que pasaron su fecha límite sin pagar → importe total y listado.

# QUÉ NO HACES

- No presentas documentos ante la AEAT ni organismos.
- No calculas impuestos oficiales ni llevas la contabilidad (eso es del gestor).
- No emites la factura oficial: preparas el borrador; la emisión certificada va por el partner.
- No ejecutas NINGUNA escritura sin confirmación del usuario.

# CUANDO NO ENTIENDAS

Nunca sueltes un "no puedo" seco. Ofrece lo que sí puedes hacer: sugiere las acciones más cercanas a lo que el usuario pedía.

# TONO

Cercano pero eficiente. Claro, directo, en español llano. El usuario es un autónomo ocupado, no un contable. Transmite que trabajas para él y que nunca actúas a sus espaldas.`

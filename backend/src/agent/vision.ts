/**
 * vision.ts — Extractor de tickets/facturas mediante modelo de visión.
 *
 * Usa OpenRouter con un modelo multimodal (Gemini Flash por defecto).
 * Devuelve un objeto estructurado con los campos extraídos y flags de confianza.
 *
 * PRINCIPIO ANTI-ALUCINACIÓN: si un dato no se lee con seguridad → null + campos_dudosos.
 * NUNCA se inventa el importe. Un importe incorrecto en finanzas destruye la confianza.
 */

export interface ExtractedTicket {
  tipo:            'gasto' | 'ingreso'
  importe:         number | null
  concepto:        string | null
  proveedor:       string | null   // proveedor (gasto) o cliente (ingreso)
  fecha:           string | null   // YYYY-MM-DD
  iva:             number | null   // porcentaje, ej. 21
  categoria:       string | null
  confianza:       'alta' | 'media' | 'baja'
  campos_dudosos:  string[]        // nombres de campos que no se leyeron con seguridad
}

// Prompt de extracción estructurada (definido en el contrato de Rebanada 3)
const EXTRACTION_PROMPT = `Eres un extractor de datos de tickets y facturas españoles. Te paso una imagen.
Devuelve SOLO un JSON con esta forma exacta, sin texto adicional, sin markdown, sin explicaciones:

{
  "tipo": "gasto",
  "importe": null,
  "concepto": null,
  "proveedor": null,
  "fecha": null,
  "iva": null,
  "categoria": null,
  "confianza": "baja",
  "campos_dudosos": []
}

VALORES PERMITIDOS:
- tipo: "gasto" | "ingreso"  (un ticket de compra es gasto; una factura emitida por el usuario es ingreso)
- importe: número con hasta 2 decimales (total con IVA incluido) | null si no se lee con seguridad
- concepto: descripción breve del artículo/servicio | null
- proveedor: nombre del comercio/empresa/cliente | null
- fecha: "YYYY-MM-DD" | null
- iva: porcentaje numérico (ej. 21) | null
- categoria: una de estas: "material" | "alquiler" | "transporte" | "dietas" | "software" | "comunicaciones" | "marketing" | "seguros" | "servicios_profesionales" | "servicios" | "suministros" | "otros" | null
- confianza: "alta" (todo legible) | "media" (algún campo dudoso) | "baja" (ilegible o no es un ticket)
- campos_dudosos: array con nombres de los campos que no se leyeron bien (ej. ["importe", "fecha"])

REGLAS CRÍTICAS:
1. Si un dato no se lee con claridad → ponlo en null y añádelo a campos_dudosos. NO INVENTES.
2. El importe es el campo MÁS CRÍTICO: ante cualquier duda → importe=null, "importe" en campos_dudosos.
3. Por defecto tipo="gasto" salvo que sea claramente una factura emitida por el usuario (con datos del emisor que coincidan con un negocio).
4. Si la imagen NO es un ticket ni una factura → confianza="baja", todos los campos a null.
5. Si hay varios tickets en la imagen → confianza="baja", campos_dudosos=["multiple_tickets"].
6. Si detectas moneda que no es € → añade "moneda_extranjera" a campos_dudosos.
7. La respuesta debe ser JSON puro, sin bloque de código, sin prefijos.`

// Modelos de visión disponibles (en orden de preferencia)
const VISION_MODELS = [
  'google/gemini-2.0-flash-lite',   // rápido, barato, bueno con recibos
  'google/gemini-flash-1.5',         // fallback
  'openai/gpt-4o-mini',              // fallback 2
]

/**
 * Extrae datos estructurados de una imagen de ticket/factura.
 * @param base64 - Imagen en base64 (sin el prefijo data:...)
 * @param mimeType - MIME type, ej. 'image/jpeg', 'image/png'
 */
export async function extractFromImage(
  base64: string,
  mimeType: string = 'image/jpeg'
): Promise<ExtractedTicket> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.error('[Vision] OPENROUTER_API_KEY no configurado')
    return failedExtraction('Sin clave de API')
  }

  const imageUrl = `data:${mimeType};base64,${base64}`

  // Intentar con cada modelo hasta que uno funcione
  for (const model of VISION_MODELS) {
    try {
      const result = await callVisionModel(model, imageUrl, apiKey)
      if (result) return result
    } catch (err) {
      console.warn(`[Vision] Modelo ${model} falló:`, err)
    }
  }

  return failedExtraction('Todos los modelos fallaron')
}

async function callVisionModel(
  model: string,
  imageUrl: string,
  apiKey: string
): Promise<ExtractedTicket | null> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://diabolus-crm-api.vercel.app',
      'X-Title': 'Diabolus CRM Vision',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: imageUrl },
            },
            {
              type: 'text',
              text: EXTRACTION_PROMPT,
            },
          ],
        },
      ],
      max_tokens: 512,
      temperature: 0.1,   // lo más determinístico posible para extracción
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`HTTP ${response.status}: ${err}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content

  if (!content) throw new Error('Respuesta vacía del modelo')

  return parseVisionResponse(content)
}

/**
 * Parsea la respuesta JSON del modelo con validación estricta.
 * Si el JSON está malformado → devuelve extracción fallida (nunca lanza).
 */
function parseVisionResponse(content: string): ExtractedTicket {
  try {
    // El modelo a veces envuelve en ``` — limpiar por si acaso
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()

    const raw = JSON.parse(cleaned)

    // Validar y sanitizar tipo
    const tipo: 'gasto' | 'ingreso' =
      raw.tipo === 'ingreso' ? 'ingreso' : 'gasto'

    // Validar importe: NUNCA aceptar si no es número positivo razonable
    let importe: number | null = null
    if (typeof raw.importe === 'number' && raw.importe > 0 && raw.importe < 100_000) {
      importe = Math.round(raw.importe * 100) / 100
    } else if (raw.importe !== null && raw.importe !== undefined) {
      // El modelo devolvió algo pero no es un número válido → marcar como dudoso
      importe = null
    }

    // Validar fecha: formato YYYY-MM-DD
    let fecha: string | null = null
    if (typeof raw.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.fecha)) {
      fecha = raw.fecha
    }

    // Validar IVA: solo 0, 4, 10, 21
    let iva: number | null = null
    if (typeof raw.iva === 'number' && [0, 4, 10, 21].includes(raw.iva)) {
      iva = raw.iva
    }

    // Validar confianza
    const confianzasValidas = ['alta', 'media', 'baja']
    const confianza: 'alta' | 'media' | 'baja' =
      confianzasValidas.includes(raw.confianza) ? raw.confianza : 'baja'

    // Campos dudosos: asegurar array de strings
    const camposDudosos: string[] = Array.isArray(raw.campos_dudosos)
      ? raw.campos_dudosos.filter((x: unknown) => typeof x === 'string')
      : []

    // Si el importe fue rechazado en validación y no está en campos_dudosos → añadirlo
    if (importe === null && raw.importe !== null && raw.importe !== undefined) {
      if (!camposDudosos.includes('importe')) camposDudosos.push('importe')
    }

    return {
      tipo,
      importe,
      concepto:   typeof raw.concepto === 'string' ? raw.concepto.slice(0, 200) : null,
      proveedor:  typeof raw.proveedor === 'string' ? raw.proveedor.slice(0, 100) : null,
      fecha,
      iva,
      categoria:  typeof raw.categoria === 'string' ? raw.categoria : null,
      confianza,
      campos_dudosos: camposDudosos,
    }
  } catch (err) {
    console.error('[Vision] Error parseando respuesta:', err, '\nContenido:', content)
    return failedExtraction('JSON malformado')
  }
}

function failedExtraction(reason: string): ExtractedTicket {
  console.warn('[Vision] Extracción fallida:', reason)
  return {
    tipo:           'gasto',
    importe:        null,
    concepto:       null,
    proveedor:      null,
    fecha:          null,
    iva:            null,
    categoria:      null,
    confianza:      'baja',
    campos_dudosos: ['importe', 'concepto', 'fecha'],
  }
}

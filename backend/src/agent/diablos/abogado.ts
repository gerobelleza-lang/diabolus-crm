/**
 * ⚖️ El Abogado v2 — RAG legal real + validador de citas
 *
 * Capa 0: Retrieval determinista (full-text search → legal_knowledge)
 * Capa 1: LLM grounded (solo chunks recuperados)
 * Capa 2: Validador de citas (verifica contra chunks reales)
 * Capa 3: Formato + fuentes verificadas
 *
 * temp: 0.1 | max_tokens: 2000 | RAG: full-text search (NO embeddings)
 */

import { DIABLO_METAS } from './metas'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './metas'
import type { AgentInput } from '../core'
import { routeToLLM, callOpenRouter } from '../llm-router'
import { logDiabloUsage } from './metrics'
import { getSalonAIConfig } from '../memory'
import type { BrainTier } from '../memory'
import { getSupabaseAdmin } from '../../integrations/supabase'

// ─── Types ───

interface LegalChunk {
  id: string
  doc_name: string
  article: string | null
  title: string | null
  content: string
  keywords: string[] | null
  category: string | null
}

interface CitationMatch {
  raw: string        // e.g. "Art. 164 Ley 37/1992"
  article: string    // e.g. "Art. 164" or "164"
  law: string        // e.g. "Ley 37/1992" or "37/1992"
}

interface ValidationResult {
  verified: CitationMatch[]
  unverified: CitationMatch[]
  cleanedResponse: string
  disclaimer: string | null
  sources: string[]
}

// ─── CAPA 0: Retrieval determinista ───

async function retrieveLegalChunks(query: string): Promise<LegalChunk[]> {
  const supabase = getSupabaseAdmin()

  // Primary: full-text search with Spanish config
  const { data: ftsResults, error: ftsError } = await supabase
    .from('legal_knowledge')
    .select('id, doc_name, article, title, content, keywords, category')
    .textSearch('search_vector', query, { type: 'plain', config: 'spanish' })
    .order('id')  // ts_rank not available via PostgREST; we get top matches
    .limit(5)

  if (!ftsError && ftsResults && ftsResults.length > 0) {
    return ftsResults as LegalChunk[]
  }

  // Fallback: keyword overlap search
  const words = query
    .toLowerCase()
    .replace(/[¿?¡!.,;:()]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)

  if (words.length === 0) return []

  const { data: kwResults } = await supabase
    .from('legal_knowledge')
    .select('id, doc_name, article, title, content, keywords, category')
    .overlaps('keywords', words)
    .limit(5)

  return (kwResults as LegalChunk[]) || []
}

// ─── CAPA 1: LLM grounded ───

function buildGroundedPrompt(chunks: LegalChunk[]): string {
  const chunksText = chunks.map((c, i) => {
    const parts = [`[FUENTE ${i + 1}]`]
    if (c.doc_name) parts.push(`Documento: ${c.doc_name}`)
    if (c.article) parts.push(`Artículo: ${c.article}`)
    if (c.title) parts.push(`Título: ${c.title}`)
    parts.push(`Contenido: ${c.content}`)
    return parts.join('\n')
  }).join('\n\n---\n\n')

  return `Eres El Abogado de Diabolus. Asesor legal digital para autónomos y PYMEs en España.

REGLAS ABSOLUTAS:
1. Responde ÚNICAMENTE con base en los fragmentos legales proporcionados abajo.
2. Si los fragmentos NO cubren la pregunta, dilo explícitamente: "Esta consulta requiere un análisis más profundo. Consulta con un abogado colegiado."
3. Cita SIEMPRE el artículo y ley/RD exacto tal como aparece en los fragmentos. Formato: "Art. X Ley Y/ZZZZ" o "Art. X RD Y/ZZZZ"
4. NUNCA inventes artículos, leyes o fechas que NO aparezcan en los fragmentos.
5. Distingue entre obligación legal y recomendación práctica.

ESTILO:
- Asesor directo que va al grano
- Primero la respuesta práctica, luego la base legal
- Si hay plazo, dilo claro: "Tienes hasta el 20 de julio"
- Si hay sanción, cuantifícala: "Multa de 150€ a 6.000€"

FRAGMENTOS LEGALES RECUPERADOS:

${chunksText}

INSTRUCCIÓN FINAL: Si necesitas citar algo que NO está en los fragmentos, NO lo cites. Indica que no dispones de esa información.`
}

const NO_CHUNKS_PROMPT = `Eres El Abogado de Diabolus. Asesor legal digital para autónomos y PYMEs en España.

No se han encontrado fragmentos legales relevantes para esta consulta en la base de datos.

Responde ÚNICAMENTE:
"No he encontrado normativa específica sobre este tema en mi base legal. Te recomiendo consultar con un abogado colegiado para obtener asesoramiento preciso."

Si la pregunta es muy genérica y puedes dar una orientación general SIN citar artículos específicos, puedes hacerlo, pero SIEMPRE añade al final:
"⚠️ Orientación general — consulta con un profesional para tu caso concreto."`

// ─── CAPA 2: Validador de citas ───

// Extract citations from LLM response
function extractCitations(text: string): CitationMatch[] {
  const citations: CitationMatch[] = []
  // Match patterns like "Art. 164 Ley 37/1992", "artículo 28 RD-ley 13/2022", etc.
  const pattern = /(?:Art(?:ículo)?\.?\s*(\d+(?:\.\d+)?(?:\s*(?:bis|ter|quáter|quinquies))?))\s+(?:de\s+)?(?:la\s+)?((?:Ley|Real Decreto|RD|RD-ley|RDL|LO|LIRPF|LIVA|LIS|LGSS|ET|CE|LOPD|RGPD|TRLGSS|LISOS)\s*(?:Orgánica\s*)?(?:\d+\/\d{4})?(?:\s*,?\s*de\s+\d+\s+de\s+\w+)?)/gi
  let match
  while ((match = pattern.exec(text)) !== null) {
    citations.push({
      raw: match[0].trim(),
      article: match[1]?.trim() || '',
      law: match[2]?.trim() || '',
    })
  }
  return citations
}

// Verify citations against retrieved chunks
function validateCitations(
  citations: CitationMatch[],
  chunks: LegalChunk[]
): ValidationResult & { verified: CitationMatch[]; unverified: CitationMatch[] } {
  const verified: CitationMatch[] = []
  const unverified: CitationMatch[] = []

  for (const cite of citations) {
    let found = false
    for (const chunk of chunks) {
      const chunkText = `${chunk.doc_name || ''} ${chunk.article || ''} ${chunk.content || ''}`.toLowerCase()
      const artNum = cite.article.toLowerCase()
      const lawRef = cite.law.toLowerCase()

      // Check if both article number and law reference appear in the chunk
      const artMatch = chunkText.includes(artNum) || chunkText.includes(`art. ${artNum}`) || chunkText.includes(`artículo ${artNum}`)
      const lawMatch = lawRef.split(/\s+/).some(word => word.length > 3 && chunkText.includes(word))

      if (artMatch && lawMatch) {
        found = true
        break
      }
    }
    if (found) {
      verified.push(cite)
    } else {
      unverified.push(cite)
    }
  }

  return { verified, unverified, cleanedResponse: '', disclaimer: null, sources: [] }
}

// Build final validated response
function buildValidatedResponse(
  llmResponse: string,
  chunks: LegalChunk[],
): ValidationResult {
  const citations = extractCitations(llmResponse)
  const { verified, unverified } = validateCitations(citations, chunks)

  let cleanedResponse = llmResponse

  // Remove unverified citations from response
  for (const bad of unverified) {
    // Replace the specific citation with a disclaimer marker
    cleanedResponse = cleanedResponse.replace(
      bad.raw,
      '[referencia no verificada — omitida]'
    )
  }

  // Build disclaimer
  let disclaimer: string | null = null
  if (chunks.length === 0) {
    disclaimer = '⚠️ No se encontró normativa específica en la base legal. Consulta con un abogado colegiado.'
  } else if (citations.length === 0) {
    disclaimer = '⚠️ No he podido identificar la norma exacta aplicable. Consulta con un abogado colegiado antes de actuar.'
  } else if (unverified.length > 0) {
    disclaimer = `⚠️ Se eliminaron ${unverified.length} cita(s) no verificable(s) contra la base legal. Las citas restantes sí están respaldadas.`
  }

  // Build verified sources list
  const usedChunkIds = new Set<string>()
  for (const v of verified) {
    for (const chunk of chunks) {
      const chunkText = `${chunk.doc_name || ''} ${chunk.article || ''} ${chunk.content || ''}`.toLowerCase()
      if (chunkText.includes(v.article.toLowerCase())) {
        usedChunkIds.add(chunk.id)
      }
    }
  }

  const sources = chunks
    .filter(c => usedChunkIds.has(c.id))
    .map(c => {
      const parts: string[] = []
      if (c.doc_name) parts.push(c.doc_name)
      if (c.article) parts.push(c.article)
      return parts.join(', ')
    })
    .filter(Boolean)

  // If no verified citations but we had chunks, list all chunk sources
  const finalSources = sources.length > 0
    ? sources
    : chunks.map(c => [c.doc_name, c.article].filter(Boolean).join(', ')).filter(Boolean)

  return {
    verified,
    unverified,
    cleanedResponse,
    disclaimer,
    sources: [...new Set(finalSources)],
  }
}

// ─── CAPA 3: Formato final ───

function formatFinalResponse(validation: ValidationResult): string {
  let output = validation.cleanedResponse.trim()

  // Add disclaimer if present
  if (validation.disclaimer) {
    output += `\n\n${validation.disclaimer}`
  }

  // Add verified sources
  if (validation.sources.length > 0) {
    output += `\n\n📚 **Fuentes:** ${validation.sources.join(' · ')}`
  }

  return output
}

// ─── Handler principal ───

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const userInput = (input.text || '').trim()
  const { tenantId, userId = 'unknown' } = input

  if (!userInput) {
    return { replyText: '¿Qué consulta legal tienes? Pregúntame sobre IVA, IRPF, contratos, LOPD o cualquier tema fiscal/laboral.' }
  }

  try {
    // CAPA 0: Retrieval
    const chunks = await retrieveLegalChunks(userInput)

    // CAPA 1: LLM grounded
    const aiConfig = await getSalonAIConfig(tenantId)
    const brainTier: BrainTier = aiConfig.brain_tier || 'rapida'
    // Legal = inherently complex → force higher complexity
    const routing = routeToLLM(0.8, userInput, false, brainTier)

    const systemPrompt = chunks.length > 0
      ? buildGroundedPrompt(chunks)
      : NO_CHUNKS_PROMPT

    const startMs = Date.now()
    const { text: llmResponse, usage } = await callOpenRouter(
      routing.model,
      userInput,
      systemPrompt,
      { temperature: 0.1, max_tokens: 2000 }
    )

    // CAPA 2: Validar citas
    const validation = buildValidatedResponse(llmResponse, chunks)

    // CAPA 3: Formato final
    const finalResponse = formatFinalResponse(validation)

    // Log metrics (non-blocking)
    if (usage) {
      logDiabloUsage(userId, tenantId, {
        diablo: 'abogado',
        ...usage,
        response_ms: Date.now() - startMs,
        chunks_retrieved: chunks.length,
        citations_verified: validation.verified.length,
        citations_removed: validation.unverified.length,
      })
    }

    return {
      replyText: finalResponse,
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

// ─── Exports for testing ───
export {
  retrieveLegalChunks,
  extractCitations,
  validateCitations,
  buildValidatedResponse,
  buildGroundedPrompt,
  formatFinalResponse,
}
export type { LegalChunk, CitationMatch, ValidationResult }

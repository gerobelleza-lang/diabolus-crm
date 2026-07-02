/**
 * 🤝 El Closer v2 — Gestiona la cartera de clientes.
 *
 * Arquitectura 4-capas:
 *   Capa 0: (n/a — no hay retrieval externo)
 *   Capa 1: LLM extractor para datos del cliente
 *   Capa 2: Validación determinista + normalización canónica
 *   Capa 3: Anti-duplicados multi-campo + Confirmation Gate
 *
 * v2 mejoras:
 *   - LLM extractor reemplaza regex frágil para nombre/datos
 *   - Anti-dup multi-campo (phone > email > nif > nombre completo)
 *   - NIF/CIF/NIE validación con dígito de control (reutiliza client-utils)
 *   - normalizePhone canónico compartido con Demonio/WhatsApp
 *   - Duplicado exacto (phone/email/nif) → bloqueo con ficha + opciones
 *   - Duplicado probable (nombre) → warning con opciones
 *
 * Maneja: crear_cliente, guardar_whatsapp, guardar_bizum, ver_ficha_cliente
 */

import { createPendingAction } from '../confirmation'
import { getSupabase } from './index'
import { DIABLO_METAS } from './metas'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './metas'
import type { AgentInput } from '../core'
import {
  normalizePhone,
  normalizeNif,
  normalizeEmail,
  validateCifNif,
  findDuplicateClient,
  formatDuplicateMessage,
} from '../utils/client-utils'

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY!

// ── Tipos ─────────────────────────────────────────────────────────────────────
interface ExtractedClientData {
  nombre: string | null
  telefono: string | null
  email: string | null
  nif: string | null
  nombre_comercial: string | null
}

// ── Capa 1: LLM extractor ─────────────────────────────────────────────────────
const EXTRACT_PROMPT = `Eres un extractor de datos de clientes para un sistema de facturación español.
Del texto del usuario, extrae los datos del cliente en JSON estricto.

Reglas:
- "nombre": nombre completo del cliente (persona o empresa). null si no lo encuentras.
- "telefono": número de teléfono tal como aparece. null si no hay.
- "email": dirección de email. null si no hay.
- "nif": NIF, CIF, NIE o DNI. null si no hay.
- "nombre_comercial": nombre del negocio si es diferente del nombre fiscal. null si no hay.

Responde SOLO con JSON, sin explicaciones:
{"nombre": "...", "telefono": "...", "email": "...", "nif": "...", "nombre_comercial": "..."}`

async function extractClientData(userInput: string): Promise<ExtractedClientData | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'nousresearch/hermes-3-llama-3.1-70b',
        max_tokens: 300,
        temperature: 0.1,
        messages: [
          { role: 'system', content: EXTRACT_PROMPT },
          { role: 'user', content: userInput },
        ],
      }),
    })
    const data = await res.json()
    const raw = data.choices?.[0]?.message?.content?.trim() || ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

// ── Capa 1 fallback: regex extraction ─────────────────────────────────────────
function extractClientDataRegex(userInput: string): ExtractedClientData {
  const mNombre = userInput.match(
    /(?:nuevo\s+cliente|cliente|añade|crea|registra|alta|mete|apunta)\s+(?:a\s+)?(?:llamad[oa]?\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,60}?)(?:\s+(?:con|tel\b|telf?\b|tlf\b|teléfono|telefono|email|nif|cif|dni|,|$)|\s*$)/i
  )
  const mPhone = userInput.match(/(?:teléfono|telefono|telf?|móvil|movil|tlf|tel)[\s:]+([+0-9\s]{7,15})/i)
  const mEmail = userInput.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
  const mNif   = userInput.match(/(?:nif|cif|dni|nie)[\s:]+([A-Za-z0-9\s-]{7,12})/i)

  return {
    nombre: mNombre ? mNombre[1].trim() : null,
    telefono: mPhone ? mPhone[1].trim() : null,
    email: mEmail ? mEmail[1] : null,
    nif: mNif ? mNif[1].trim() : null,
    nombre_comercial: null,
  }
}

// ── Capa 2: Validación determinista ───────────────────────────────────────────
interface ValidationResult {
  valid: boolean
  nombre: string | null
  phone: string | null
  email: string | null
  nif: string | null
  nombre_comercial: string | null
  warnings: string[]
  errors: string[]
}

function validateClientData(extracted: ExtractedClientData): ValidationResult {
  const warnings: string[] = []
  const errors: string[] = []

  // Nombre
  let nombre = extracted.nombre?.trim() || null
  if (nombre) {
    // Reject generic names
    const generics = /^(cliente|nuevo|test|prueba|undefined|null|none)$/i
    if (generics.test(nombre)) {
      nombre = null
      errors.push('El nombre no puede ser genérico. Dime el nombre real.')
    } else if (nombre.length < 2) {
      nombre = null
      errors.push('El nombre es demasiado corto.')
    }
  }

  // Phone — normalización canónica
  const phone = normalizePhone(extracted.telefono)
  if (extracted.telefono && !phone) {
    warnings.push(`El teléfono "${extracted.telefono}" no parece válido. Debe ser español (9 dígitos).`)
  }

  // Email — normalización
  const email = normalizeEmail(extracted.email)
  if (extracted.email && !email) {
    warnings.push(`El email "${extracted.email}" no tiene formato válido.`)
  }

  // NIF/CIF/NIE — normalización + validación con dígito de control
  let nif = normalizeNif(extracted.nif)
  if (nif) {
    if (!validateCifNif(nif)) {
      warnings.push(`El NIF/CIF "${nif}" no pasa la validación del dígito de control. ¿Está bien escrito?`)
      // No anulamos — dejamos que el usuario confirme
    }
  }

  // Nombre comercial
  const nombre_comercial = extracted.nombre_comercial?.trim() || null

  const valid = nombre !== null && errors.length === 0

  return { valid, nombre, phone, email, nif, nombre_comercial, warnings, errors }
}

// ── Handler principal ─────────────────────────────────────────────────────────
async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId } = input
  const userInput = (input.text || '').trim()

  // ── Guardar WhatsApp del dueño ──────────────────────────────────────────
  if (classification.intent === 'guardar_whatsapp') {
    const waMatch = userInput.match(
      /(?:mi\s+)?(?:whatsapp|wha|wa|número|numero|teléfono|telefono|telf?)\s+(?:es|:)?\s*\+?(\d[\d\s]{6,14}\d)/i
    )
    if (!waMatch) return { needsInfo: 'No pillé el número. Dime: "mi WhatsApp es 612345678"' }

    const normalized = normalizePhone(waMatch[1])
    if (!normalized) return { needsInfo: 'Ese número no parece español válido. Dime los 9 dígitos.' }

    const { error } = await getSupabase()
      .from('salons')
      .update({ whatsapp_number: normalized })
      .eq('id', tenantId)
    if (error) return { replyText: '❌ No pude guardar tu WhatsApp. Inténtalo de nuevo.' }
    return {
      replyText: `✅ WhatsApp guardado: +${normalized}\n\nAhora puedes enviarme audios o mensajes por WhatsApp y los proceso como si estuvieras aquí. 😈`
    }
  }

  // ── Guardar Bizum del dueño ─────────────────────────────────────────────
  if (classification.intent === 'guardar_bizum') {
    const bizumMatch = userInput.match(
      /(?:mi\s+)?(?:bizum|biz)\s+(?:es|:)?\s*\+?(\d[\d\s]{6,14}\d)/i
    )
    if (!bizumMatch) return { needsInfo: 'No pillé el número. Dime: "mi Bizum es 612345678"' }

    const normalized = normalizePhone(bizumMatch[1])
    if (!normalized) return { needsInfo: 'Ese número no parece válido. Dime los 9 dígitos.' }

    // Bizum uses just the 9-digit part (no country code)
    const bizumDigits = normalized.slice(2) // Remove '34'

    const { error } = await getSupabase()
      .from('salons')
      .update({ bizum_number: bizumDigits })
      .eq('id', tenantId)
    if (error) return { replyText: '❌ No pude guardar tu Bizum. Inténtalo de nuevo.' }
    return {
      replyText: `✅ Bizum guardado: ${bizumDigits}\n\nA partir de ahora, los recordatorios del Cazador incluirán tu número Bizum para que tus clientes paguen al instante. 😈`
    }
  }

  // ── Crear cliente ───────────────────────────────────────────────────────

  // Capa 1: LLM extractor + fallback regex
  let extracted = await extractClientData(userInput)
  if (!extracted || !extracted.nombre) {
    const regexData = extractClientDataRegex(userInput)
    if (extracted) {
      // Merge: LLM wins where it found data, regex fills gaps
      extracted = {
        nombre: extracted.nombre || regexData.nombre,
        telefono: extracted.telefono || regexData.telefono,
        email: extracted.email || regexData.email,
        nif: extracted.nif || regexData.nif,
        nombre_comercial: extracted.nombre_comercial || regexData.nombre_comercial,
      }
    } else {
      extracted = regexData
    }
  }

  if (!extracted.nombre) {
    return { needsInfo: '¿Cómo se llama el cliente? Ej: "nuevo cliente Ana García con tel 612345678"' }
  }

  // Capa 2: Validación determinista
  const validated = validateClientData(extracted)
  if (!validated.valid) {
    return { needsInfo: validated.errors.join('\n') }
  }

  // Capa 3: Anti-duplicados multi-campo
  try {
    const dupResult = await findDuplicateClient(getSupabase(), tenantId, {
      phone: validated.phone,
      email: validated.email,
      nif: validated.nif,
      name: validated.nombre!,
    })

    if (dupResult.hasDuplicate) {
      const msg = formatDuplicateMessage(dupResult)
      // Warnings go as suffix
      const warningText = validated.warnings.length > 0
        ? '\n\n⚠️ ' + validated.warnings.join('\n⚠️ ')
        : ''
      return { needsInfo: msg + warningText }
    }
  } catch (err: any) {
    // Anti-dup failed — log but don't block creation
    console.error('[Closer] Anti-dup error:', err?.message)
  }

  // Warnings about validation issues
  const warningPrefix = validated.warnings.length > 0
    ? '⚠️ ' + validated.warnings.join('\n⚠️ ') + '\n\n'
    : ''

  // Confirmation gate
  const card = await createPendingAction('crear_cliente', {
    nombre: validated.nombre,
    nombre_comercial: validated.nombre_comercial,
    telefono: validated.phone,
    email: validated.email,
    nif: validated.nif,
    _warnings: warningPrefix || undefined,
  }, tenantId, userId)

  return { card }
}

export const CloserDiablo: DiabloHandler = {
  meta: DIABLO_METAS.closer,
  handle,
}

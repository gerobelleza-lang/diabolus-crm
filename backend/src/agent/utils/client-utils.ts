/**
 * 🤝 CLIENT-UTILS — Módulo compartido de normalización y validación de clientes
 *
 * Patrón INVOICE_STATUS / TRANSACTION_CATEGORIES:
 * - Fuente única de verdad para normalización de phone/NIF
 * - validateCifNif extraído de facturador-v2 (reutilizado, no reescrito)
 * - findDuplicateClient: anti-dup multi-campo
 *
 * Usado por: El Closer, El Facturador, El Demonio, WhatsApp handlers
 */

// ── Normalización de teléfono ─────────────────────────────────────────────────
/**
 * Normaliza un número de teléfono español al formato canónico: 34XXXXXXXXX
 * Quita espacios, guiones, paréntesis, +
 * Si no empieza por 34, lo añade
 * Returns null si el resultado no tiene 11 dígitos (34 + 9 dígitos)
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits || digits.length < 7) return null

  const withPrefix = digits.startsWith('34') ? digits : `34${digits}`

  // Spanish phone: 34 + 9 dígitos = 11
  if (withPrefix.length !== 11) return null
  // Must start with 34[6789] (mobile/landline)
  if (!/^34[6789]/.test(withPrefix)) return null

  return withPrefix
}

// ── Normalización de NIF/CIF/NIE ──────────────────────────────────────────────
/**
 * Normaliza un identificador fiscal español:
 * - Uppercase
 * - Quita espacios, guiones, puntos
 */
export function normalizeNif(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.toUpperCase().replace(/[\s.\-]/g, '')
  if (cleaned.length < 7 || cleaned.length > 9) return null
  return cleaned
}

// ── Validación CIF/NIF/NIE ────────────────────────────────────────────────────
/**
 * Validador CIF/NIF/NIE con algoritmo oficial español (dígito de control)
 * Extraído de facturador-v2.ts — fuente única, no duplicar
 */
const NIF_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE'

export function validateCifNif(value: string): boolean {
  if (!value) return false
  const v = value.toUpperCase().replace(/[\s-]/g, '')

  // NIF: 8 dígitos + letra
  const nifMatch = v.match(/^(\d{8})([A-Z])$/)
  if (nifMatch) {
    return NIF_LETTERS[parseInt(nifMatch[1]) % 23] === nifMatch[2]
  }

  // NIE: X/Y/Z + 7 dígitos + letra
  const nieMatch = v.match(/^([XYZ])(\d{7})([A-Z])$/)
  if (nieMatch) {
    const prefix = { X: '0', Y: '1', Z: '2' }[nieMatch[1]]!
    const num = parseInt(prefix + nieMatch[2])
    return NIF_LETTERS[num % 23] === nieMatch[3]
  }

  // CIF: letra + 7 dígitos + dígito/letra de control
  const cifMatch = v.match(/^([ABCDEFGHJKLMNPQRSUVW])(\d{7})([A-J0-9])$/)
  if (cifMatch) {
    const digits = cifMatch[2]
    let sumA = 0
    let sumB = 0
    for (let i = 0; i < 7; i++) {
      const d = parseInt(digits[i])
      if (i % 2 === 0) {
        const doubled = d * 2
        sumB += Math.floor(doubled / 10) + (doubled % 10)
      } else {
        sumA += d
      }
    }
    const total = sumA + sumB
    const control = (10 - (total % 10)) % 10
    const controlLetter = 'JABCDEFGHI'[control]

    const letterOnly = 'KLMNPQRSW'
    const digitOnly = 'ABEH'
    if (letterOnly.includes(cifMatch[1])) {
      return cifMatch[3] === controlLetter
    } else if (digitOnly.includes(cifMatch[1])) {
      return cifMatch[3] === String(control)
    } else {
      return cifMatch[3] === String(control) || cifMatch[3] === controlLetter
    }
  }

  return false
}

// ── Normalización de email ────────────────────────────────────────────────────
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(trimmed)) return null
  return trimmed
}

// ── Anti-duplicados multi-campo ───────────────────────────────────────────────
export interface DuplicateMatch {
  id: string
  name: string
  phone: string | null
  email: string | null
  nombre_comercial: string | null
  matchField: 'phone' | 'email' | 'nif' | 'name'
  matchCertainty: 'exact' | 'probable'
}

export interface DuplicateResult {
  hasDuplicate: boolean
  matches: DuplicateMatch[]
  blockingMatch: DuplicateMatch | null  // phone/email/nif = blocking
}

/**
 * Busca duplicados en clients por salón.
 * Prioridad: phone > email > nif > nombre (parcial)
 * phone/email/nif match = blocking (duplicado seguro)
 * nombre match = warning (probable, no bloquea)
 */
export async function findDuplicateClient(
  supabase: any,
  salonId: string,
  fields: {
    phone?: string | null
    email?: string | null
    nif?: string | null
    name?: string
  }
): Promise<DuplicateResult> {
  const matches: DuplicateMatch[] = []

  // 1. Phone exact match (normalized)
  if (fields.phone) {
    const { data } = await supabase
      .from('clients')
      .select('id, name, phone, email, nombre_comercial')
      .eq('salon_id', salonId)
      .eq('phone', fields.phone)
      .limit(1)
    if (data?.[0]) {
      matches.push({ ...data[0], matchField: 'phone', matchCertainty: 'exact' })
    }
  }

  // 2. Email exact match (normalized)
  if (fields.email) {
    const { data } = await supabase
      .from('clients')
      .select('id, name, phone, email, nombre_comercial')
      .eq('salon_id', salonId)
      .ilike('email', fields.email)
      .limit(1)
    if (data?.[0] && !matches.some(m => m.id === data[0].id)) {
      matches.push({ ...data[0], matchField: 'email', matchCertainty: 'exact' })
    }
  }

  // 3. NIF exact match (normalized)
  if (fields.nif) {
    const { data } = await supabase
      .from('clients')
      .select('id, name, phone, email, nombre_comercial')
      .eq('salon_id', salonId)
      .eq('nif', fields.nif)
      .limit(1)
    if (data?.[0] && !matches.some(m => m.id === data[0].id)) {
      matches.push({ ...data[0], matchField: 'nif', matchCertainty: 'exact' })
    }
  }

  // 4. Name partial match (nombre completo, no solo primer nombre)
  if (fields.name && fields.name.length >= 2) {
    const nameParts = fields.name.split(/\s+/).filter(p => p.length >= 2)
    // Search by full name first, then first+last if has multiple parts
    const searchTerms = nameParts.length > 1
      ? [`%${fields.name}%`, `%${nameParts[0]}%${nameParts[nameParts.length - 1]}%`]
      : [`%${nameParts[0]}%`]

    for (const term of searchTerms) {
      const { data } = await supabase
        .from('clients')
        .select('id, name, phone, email, nombre_comercial')
        .eq('salon_id', salonId)
        .ilike('name', term)
        .limit(3)
      if (data) {
        for (const c of data) {
          if (!matches.some(m => m.id === c.id)) {
            matches.push({ ...c, matchField: 'name', matchCertainty: 'probable' })
          }
        }
      }
    }
  }

  const blockingMatch = matches.find(m => m.matchCertainty === 'exact') || null

  return {
    hasDuplicate: matches.length > 0,
    matches,
    blockingMatch,
  }
}

/**
 * Genera mensaje de duplicado con opciones de acción
 */
export function formatDuplicateMessage(result: DuplicateResult): string {
  if (result.blockingMatch) {
    const m = result.blockingMatch
    const field = { phone: 'teléfono', email: 'email', nif: 'NIF/CIF' }[m.matchField] || m.matchField
    const lines = [
      `⚠️ Ya existe un cliente con ese ${field}:`,
      `• **${m.name}**${m.phone ? ` | Tel: ${m.phone}` : ''}${m.email ? ` | ${m.email}` : ''}`,
      '',
      '¿Qué quieres hacer?',
      '1. "ver ficha" — abro la ficha de este cliente',
      '2. "actualizar datos" — actualizo sus datos con los nuevos',
      '3. "crear nuevo" — lo creo como cliente distinto (¿seguro?)',
    ]
    return lines.join('\n')
  }

  // Probable matches (name only)
  const lista = result.matches.map(m =>
    `• **${m.name}**${m.phone ? ` | Tel: ${m.phone}` : ''}${m.email ? ` | ${m.email}` : ''}`
  ).join('\n')
  return [
    'Ya tengo clientes con nombre similar:',
    lista,
    '',
    '¿Es alguno de ellos? Si sí, dime cuál. Si es nuevo, dime "crear nuevo".',
  ].join('\n')
}

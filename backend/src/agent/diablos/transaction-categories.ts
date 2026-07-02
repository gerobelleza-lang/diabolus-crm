/**
 * 📊 TRANSACTION_CATEGORIES — Fuente única de verdad
 * 
 * Patrón INVOICE_STATUS: módulo central importado por todos los Diablos.
 * Usado por: El Contable, suggestCategory(), validadores, API /categories.
 * 
 * ⚠️ BD no tiene constraint de categoría — la validación es en código.
 */

// ── Transaction type (DB constraint: income | expense) ──────────────────────

export const TRANSACTION_TYPE = {
  INCOME:  'income',
  EXPENSE: 'expense',
} as const

export type TransactionType = typeof TRANSACTION_TYPE[keyof typeof TRANSACTION_TYPE]

/** Mapea texto español/LLM → valor DB exacto */
export function mapTypeToDB(raw: string): TransactionType | null {
  const t = (raw || '').toLowerCase().trim()
  if (t === 'income'  || t === 'ingreso')  return TRANSACTION_TYPE.INCOME
  if (t === 'expense' || t === 'gasto')    return TRANSACTION_TYPE.EXPENSE
  return null
}

// ── Categories ──────────────────────────────────────────────────────────────

export interface CategoryDef {
  slug: string
  label: string
}

/**
 * Lista canónica. El slug va a transactions.category.
 * Si necesitas una nueva, AÑÁDELA AQUÍ y en ningún otro sitio.
 */
export const TRANSACTION_CATEGORIES: CategoryDef[] = [
  // — Servicios / ingresos —
  { slug: 'servicios',               label: 'Servicios prestados'      },
  // — Gastos operativos —
  { slug: 'material',                label: 'Material y suministros'   },
  { slug: 'alquiler',                label: 'Alquiler'                 },
  { slug: 'suministros',             label: 'Suministros (luz, agua, gas, internet)' },
  { slug: 'transporte',              label: 'Transporte y combustible' },
  { slug: 'dietas',                  label: 'Dietas y comidas'         },
  { slug: 'software',                label: 'Software y suscripciones' },
  { slug: 'herramientas_digitales',  label: 'Herramientas digitales'   },
  { slug: 'comunicaciones',          label: 'Comunicaciones'           },
  { slug: 'marketing',               label: 'Marketing y publicidad'   },
  { slug: 'seguros',                 label: 'Seguros'                  },
  { slug: 'servicios_profesionales', label: 'Servicios profesionales'  },
  { slug: 'proveedores',             label: 'Compras a proveedores'    },
  { slug: 'bancos_comisiones',       label: 'Comisiones bancarias'     },
  { slug: 'impuestos_tasas',         label: 'Impuestos y tasas'        },
  { slug: 'mantenimiento',           label: 'Reparación y mantenimiento' },
  { slug: 'formacion',               label: 'Formación'               },
  { slug: 'nominas',                 label: 'Nóminas'                  },
  { slug: 'impuestos',               label: 'Impuestos (SS, cuota autónomo)' },
  { slug: 'personal',                label: 'Préstamos personales'     },
  { slug: 'gastos_generales',        label: 'Gastos generales'         },
  { slug: 'otros',                   label: 'Otros'                    },
]

/** Set para validación O(1) */
const VALID_SLUGS = new Set(TRANSACTION_CATEGORIES.map(c => c.slug))

/** Valida que un slug existe en la lista canónica */
export function isValidCategory(slug: string): boolean {
  return VALID_SLUGS.has(slug)
}

/** Devuelve 'otros' si el slug no es válido */
export function normalizeCategory(slug: string | null | undefined): string {
  if (!slug) return 'otros'
  return isValidCategory(slug) ? slug : 'otros'
}

// ── suggestCategory v2 — reemplaza la de tools.ts ───────────────────────────
// Misma lógica pero devuelve SOLO slugs de TRANSACTION_CATEGORIES.

export function suggestCategoryV2(concepto: string): string {
  const t = (concepto || '').toLowerCase()
  if (/material|tinte|tintura|producto|suministro|peluquer|consumible|papeler/i.test(t)) return 'material'
  if (/alquiler|renta\s+(?:del?\s+)?local/i.test(t))                      return 'alquiler'
  if (/\bluz\b|electricidad|agua|gas\b|internet|wifi|fibra/i.test(t))      return 'suministros'
  if (/gasolina|gasoil|transporte|viaje|taxi|combustible|carburante|peaje|aparcamiento|parking/i.test(t)) return 'transporte'
  if (/comida|dieta|restaurant|menú|menu|almuerzo/i.test(t))               return 'dietas'
  if (/software|app|suscripci|subscripci|plataform|saas|licencia/i.test(t)) return 'herramientas_digitales'
  if (/tel[eé]fono|m[oó]vil.*empresa|l[ií]nea/i.test(t))                  return 'comunicaciones'
  if (/publicidad|marketing|redes|instagram|facebook|anuncio/i.test(t))    return 'marketing'
  if (/\bseguro\b(?!\s+social)|p[oó]liza/i.test(t))                       return 'seguros'
  if (/asesor|gestor[ií]a|abogad|notari|contabilidad/i.test(t))            return 'servicios_profesionales'
  if (/proveedor|stock|mercanc|género/i.test(t))                           return 'proveedores'
  if (/comisi[oó]n.*banco|tpv|datafono|cuota.*tarjeta|cuota.*cuenta/i.test(t)) return 'bancos_comisiones'
  if (/impuesto|tasa|ibi\b|basura|licencia.*apertura/i.test(t))           return 'impuestos_tasas'
  if (/reparaci[oó]n|aver[ií]a|mantenimiento|fontanero|electricista|pintor|alba[ñn]il/i.test(t)) return 'mantenimiento'
  if (/formaci[oó]n|curso|taller|capacitaci|master|training/i.test(t))     return 'formacion'
  if (/limpieza/i.test(t))                                                 return 'gastos_generales'
  if (/n[oó]mina/i.test(t))                                               return 'nominas'
  if (/cuota\s+aut[oó]nomo|cuota\s+reta|seguridad\s+social|cuota\s+ss/i.test(t)) return 'impuestos'
  if (/corte|peinado|tratamiento|sesi[oó]n|color|manicura/i.test(t))       return 'servicios'
  if (/pr[eé]stamo|adelanto/i.test(t))                                     return 'personal'
  return 'otros'
}

// ── Spanish number parser ───────────────────────────────────────────────────
// Handles: "1.250,50€" → 1250.50 | "80€" → 80 | "1,5€" → 1.5

export function parseSpanishAmount(raw: string): number | null {
  if (!raw) return null
  // Strip currency symbols and whitespace
  let s = raw.replace(/[€\s]/g, '').trim()
  if (!s) return null

  // Detect format:
  // Spanish: 1.250,50 (dot=thousands, comma=decimal)
  // English: 1,250.50 (comma=thousands, dot=decimal)
  // Ambiguous: 1.5 or 1,5 (single separator with ≤2 decimals)

  const hasDot   = s.includes('.')
  const hasComma = s.includes(',')

  if (hasDot && hasComma) {
    // Both present: last separator is decimal
    const lastDot   = s.lastIndexOf('.')
    const lastComma = s.lastIndexOf(',')
    if (lastComma > lastDot) {
      // Spanish: 1.250,50
      s = s.replace(/\./g, '').replace(',', '.')
    } else {
      // English: 1,250.50
      s = s.replace(/,/g, '')
    }
  } else if (hasComma && !hasDot) {
    // "80,50" or "1,250" — check decimal part length
    const parts = s.split(',')
    if (parts.length === 2 && parts[1].length <= 2) {
      // Decimal comma: 80,50 → 80.50
      s = s.replace(',', '.')
    } else {
      // Thousands comma: 1,250 → 1250
      s = s.replace(/,/g, '')
    }
  } else if (hasDot && !hasComma) {
    // "80.50" or "1.250" — check decimal part length
    const parts = s.split('.')
    if (parts.length === 2 && parts[1].length === 3 && parts[0].length >= 1) {
      // Thousands dot: 1.250 → 1250 (exactly 3 digits after dot)
      s = s.replace(/\./g, '')
    }
    // else: normal decimal dot (80.50, 1.5) — keep as is
  }

  const num = parseFloat(s)
  if (isNaN(num) || !isFinite(num)) return null
  return Math.round(num * 100) / 100
}

// ── Date resolver — 100% deterministic ──────────────────────────────────────
// LLM devuelve texto ("enero", "último trimestre"), CÓDIGO resuelve a rango.

const MONTH_NAMES: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
}

export interface DateRange {
  start: string  // ISO date (YYYY-MM-DD)
  end: string    // ISO date (YYYY-MM-DD)
  label: string  // Human-readable
}

/**
 * Resuelve texto de fecha → rango.
 * Regla: mes sin año → el más reciente PASADO.
 * En julio 2026: "enero" = ene 2026, "diciembre" = dic 2025.
 * @param text - texto crudo del usuario
 * @param now - fecha actual (inyectable para tests)
 */
export function resolveDateRange(text: string, now?: Date): DateRange | null {
  const ref = now || new Date()
  const currentYear  = ref.getFullYear()
  const currentMonth = ref.getMonth()
  const t = (text || '').toLowerCase().trim()

  if (!t || t === 'este mes' || t === 'mes actual') {
    const start = new Date(currentYear, currentMonth, 1)
    const end   = new Date(currentYear, currentMonth + 1, 0)
    return {
      start: isoDate(start),
      end:   isoDate(end),
      label: `${monthName(currentMonth)} ${currentYear}`,
    }
  }

  // "mes pasado" / "mes anterior"
  if (/mes\s+pasado|mes\s+anterior|el\s+pasado\s+mes/i.test(t)) {
    const m = currentMonth === 0 ? 11 : currentMonth - 1
    const y = currentMonth === 0 ? currentYear - 1 : currentYear
    return {
      start: isoDate(new Date(y, m, 1)),
      end:   isoDate(new Date(y, m + 1, 0)),
      label: `${monthName(m)} ${y}`,
    }
  }

  // Named month (with optional year)
  for (const [name, mIdx] of Object.entries(MONTH_NAMES)) {
    const re = new RegExp(`\\b${name}\\b(?:\\s+(\\d{4}))?`, 'i')
    const match = t.match(re)
    if (match) {
      let year: number
      if (match[1]) {
        year = parseInt(match[1])
      } else {
        // Regla: mes sin año → el más reciente pasado
        // Si estamos en julio (6) y piden enero (0) → 0 < 6 → mismo año
        // Si estamos en julio (6) y piden diciembre (11) → 11 >= 6 → año anterior
        year = mIdx < currentMonth ? currentYear :
               mIdx === currentMonth ? currentYear :  // "este mes" = mes actual
               currentYear - 1
      }
      return {
        start: isoDate(new Date(year, mIdx, 1)),
        end:   isoDate(new Date(year, mIdx + 1, 0)),
        label: `${monthName(mIdx)} ${year}`,
      }
    }
  }

  // "este trimestre"
  if (/este\s+trimestre|trimestre\s+actual/i.test(t)) {
    const qStart = Math.floor(currentMonth / 3) * 3
    return {
      start: isoDate(new Date(currentYear, qStart, 1)),
      end:   isoDate(new Date(currentYear, qStart + 3, 0)),
      label: `T${Math.floor(qStart / 3) + 1} ${currentYear}`,
    }
  }

  // "último trimestre" / "trimestre pasado"
  if (/[uú]ltimo\s+trimestre|trimestre\s+pasado|trimestre\s+anterior/i.test(t)) {
    const qStart = Math.floor(currentMonth / 3) * 3
    let pStart = qStart - 3
    let pYear = currentYear
    if (pStart < 0) { pStart = 9; pYear-- }
    return {
      start: isoDate(new Date(pYear, pStart, 1)),
      end:   isoDate(new Date(pYear, pStart + 3, 0)),
      label: `T${Math.floor(pStart / 3) + 1} ${pYear}`,
    }
  }

  // "este año" / "año actual"
  if (/este\s+a[ñn]o|a[ñn]o\s+actual/i.test(t)) {
    return {
      start: `${currentYear}-01-01`,
      end:   `${currentYear}-12-31`,
      label: `${currentYear}`,
    }
  }

  // "año pasado"
  if (/a[ñn]o\s+pasado|a[ñn]o\s+anterior/i.test(t)) {
    return {
      start: `${currentYear - 1}-01-01`,
      end:   `${currentYear - 1}-12-31`,
      label: `${currentYear - 1}`,
    }
  }

  return null  // Texto no reconocido
}

function monthName(m: number): string {
  const names = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
  return names[m] || ''
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// ── Amount validation ───────────────────────────────────────────────────────

export interface AmountValidation {
  valid: boolean
  amount: number
  warning?: string  // Alerta pero no bloqueo
  error?: string    // Bloqueo
}

export function validateAmount(amount: number | null | undefined): AmountValidation {
  if (amount === null || amount === undefined || isNaN(amount)) {
    return { valid: false, amount: 0, error: 'Importe no proporcionado' }
  }
  if (amount <= 0) {
    return { valid: false, amount, error: 'El importe debe ser mayor que 0' }
  }
  if (amount >= 100_000) {
    return { valid: false, amount, error: `${amount.toFixed(2)}€ parece demasiado alto. ¿Es correcto?` }
  }
  if (amount > 10_000) {
    return { valid: true, amount, warning: `⚠️ Importe alto: ${amount.toFixed(2)}€. Confirma que es correcto.` }
  }
  return { valid: true, amount }
}

// ── Concept validation ──────────────────────────────────────────────────────

const GENERIC_CONCEPTS = new Set([
  'gasto', 'gastos', 'ingreso', 'ingresos', 'cosa', 'cosas', 'algo',
  'pago', 'cobro', 'dinero', 'movimiento',
])

export function validateConcept(concepto: string | null | undefined): { valid: boolean; error?: string } {
  if (!concepto || concepto.trim().length < 2) {
    return { valid: false, error: 'Concepto demasiado corto o vacío' }
  }
  if (GENERIC_CONCEPTS.has(concepto.trim().toLowerCase())) {
    return { valid: false, error: `"${concepto}" es demasiado genérico. Dime para qué fue. Ej: "material de peluquería", "corte de pelo"` }
  }
  return { valid: true }
}

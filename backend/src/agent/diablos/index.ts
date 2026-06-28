/**
 * diablos/index.ts — Registry de Los Diablos de Diabolus
 *
 * Diablilla es la jefa de orquesta. Los Diablos son especialistas.
 * El cliente habla SOLO con Diablilla, pero ve qué Diablo trabajó.
 */

import { createClient } from '@supabase/supabase-js'

// Re-export everything from metas (types, DIABLO_METAS, DIABLO_TAGS)
export { DIABLO_METAS, DIABLO_TAGS } from './metas'
export type { DiabloName, DiabloMeta, DiabloResponse, IntentClassification, DiabloHandler } from './metas'
import type { DiabloName, DiabloHandler, IntentClassification } from './metas'

// ─── Shared Supabase helper ────────────────────────────────────────────────
export function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!
  )
}

// ─── Registry (lazy-loaded) ────────────────────────────────────────────────

import { ContableDiablo } from './contable'
import { FacturadorDiablo } from './facturador'
import { CobradorDiablo } from './cobrador'
import { CloserDiablo } from './closer'
import { CazadorDiablo } from './cazador'
import { AbogadoDiablo } from './abogado'
import { EscribanoDiablo } from './escribano'
import { GuardianDiablo } from './guardian'
import { ConfesorDiablo } from './confesor'

export const DIABLOS: Record<DiabloName, DiabloHandler> = {
  contable:   ContableDiablo,
  facturador: FacturadorDiablo,
  cobrador:   CobradorDiablo,
  closer:     CloserDiablo,
  cazador:    CazadorDiablo,
  abogado:    AbogadoDiablo,
  escribano:  EscribanoDiablo,
  guardian:   GuardianDiablo,
  confesor:   ConfesorDiablo,
}

// ─── Classify intent → Diablo ──────────────────────────────────────────────

export function classifyIntent(userInput: string, parsedIntent: string, parsedConfidence: number): IntentClassification {
  const lower = userInput.toLowerCase().trim()

  // 1. Greetings → Diablilla herself
  if (/^(hola|hey|buenas|buenos días|buenas tardes|buenas noches|ey|hi|hello|qué hay|qué tal|holi|ola|buenas!|hola!|hey!)[\s]*[!?]?$/i.test(userInput)) {
    return { diablo: 'diablilla', intent: 'saludo', confidence: 1 }
  }

  // 2. Help/guidance → El Confesor
  if (/^(ayuda|help|comandos|opciones|qué puedes hacer|para qué sirves|cómo funciona)[\s]*[?]?$/i.test(userInput)) {
    return { diablo: 'confesor', intent: 'ayuda', confidence: 1 }
  }
  if (/no\s+entiendo|estoy\s+perdid[oa]|cómo\s+(?:se\s+)?(?:usa|funciona|hago)|explícame|explicame|tutorial/i.test(lower)) {
    return { diablo: 'confesor', intent: 'guia', confidence: 0.9 }
  }

  // 3. WhatsApp/Bizum → El Closer
  if (/(?:mi\s+)?(?:whatsapp|wha|wa|número|numero|teléfono|telefono|telf?)\s+(?:es|:)?\s*\+?\d/i.test(lower)) {
    return { diablo: 'closer', intent: 'guardar_whatsapp', confidence: 0.95 }
  }
  if (/(?:mi\s+)?(?:bizum|biz)\s+(?:es|:)?\s*\+?\d/i.test(lower)) {
    return { diablo: 'closer', intent: 'guardar_bizum', confidence: 0.95 }
  }

  // 4. Parser-based intent mapping
  const INTENT_TO_DIABLO: Record<string, DiabloName> = {
    create_income:    'contable',
    create_expense:   'contable',
    query_balance:    'contable',
    query_income:     'contable',
    query_expense:    'contable',
    crear_albaran:    'escribano',
    send_invoice:     'facturador',
    query_who_owes:   'cobrador',
    query_overdue:    'cobrador',
    query_debtors:    'cobrador',
    query_pending:    'cobrador',
  }

  if (INTENT_TO_DIABLO[parsedIntent]) {
    return { diablo: INTENT_TO_DIABLO[parsedIntent], intent: parsedIntent, confidence: parsedConfidence }
  }

  // 5. Regex-based routing (for intents not captured by parser)
  // Clientes
  if (/nuevo cliente|crear cliente|añadir cliente|agrega.{0,10}cliente|da de alta|registra.{0,15}cliente|alta.{0,10}cliente|registra\s+a\s+[A-ZÁÉÍÓÚÑ]|añade\s+a\s+[A-ZÁÉÍÓÚÑ]|a[ñn]ade\s+a\s+[A-ZÁÉÍÓÚÑ]|mete\s+a\s+[A-ZÁÉÍÓÚÑ]|apunta\s+a\s+[A-ZÁÉÍÓÚÑ]/i.test(userInput)) {
    return { diablo: 'closer', intent: 'crear_cliente', confidence: 0.9 }
  }

  // Facturas
  if (/crea.{0,10}factura|nueva factura|factura para|hazme.{0,10}factura|factura a\s|apunta.{0,10}factura|registra.{0,10}factura|hacer.{0,10}factura|pon.{0,10}factura|mete.{0,10}factura|generar?.{0,10}factura/i.test(userInput)) {
    return { diablo: 'facturador', intent: 'crear_factura', confidence: 0.9 }
  }
  if (/^facturas?\s+vencidas?$|^ver\s+vencidas?$|^hay\s+vencidas?$|^cu[aá]ntas?\s+vencidas?$|(?:listar?|ver|mostrar|hay|cu[aá]ntas?|qu[eé])\s+facturas?\s+vencidas?/i.test(userInput.trim())) {
    return { diablo: 'facturador', intent: 'facturas_vencidas', confidence: 0.9 }
  }
  if (/paga[dr]a|cobrad[ao]|marca.{0,20}como|cambi.{0,10}estado|factura.{0,20}(pagad|cobrad|anuld)/i.test(userInput)) {
    return { diablo: 'facturador', intent: 'cambiar_estado', confidence: 0.85 }
  }

  // Recordatorios → El Cobrador
  if (/recordatorio|avisa.{0,10}[aá]|manda.{0,15}recorda|recuérdal|recuerdal|enviou?n?.{0,10}recorda/i.test(userInput)) {
    return { diablo: 'cobrador', intent: 'enviar_recordatorio', confidence: 0.9 }
  }

  // Préstamos, adelantos → El Contable
  if (/pr[eé]stamo|adelanto\s+(?:de\s+)?(?:n[oó]mina|sueldo)|anticipo\s+(?:de\s+)?(?:n[oó]mina|sueldo)|anticipo\s+a\s|presto\s|presté\s/i.test(userInput)) {
    return { diablo: 'contable', intent: 'prestamo', confidence: 0.9 }
  }

  // Nóminas, cuota autónomo → El Contable
  if (/cuota\s+aut[oó]nomo|cuota\s+reta|seguridad\s+social|cuota\s+ss\b|n[oó]mina\s+de|pago\s+n[oó]mina/i.test(userInput)) {
    return { diablo: 'contable', intent: 'nomina_cuota', confidence: 0.9 }
  }

  // Gastos recurrentes → El Contable (check against gastoMap patterns)
  if (/alquiler\s+(?:del?\s+)?local|pago\s+(?:del?\s+)?local|renta\s+(?:del?\s+)?local|\bluz\b|electricidad|factura\s+(?:de\s+)?(?:la\s+)?luz|\bagua\b|\bgas\b|internet|wifi|fibra|tel[eé]fono\s+(?:m[oó]vil|fijo|empresa)|\bdieta\b|dietas\b|material\s+(?:de\s+)?(?:oficina|trabajo)|limpieza|\bseguro\b(?!\s+(?:social|de\s+vida))|gestor[ií]a|asesor[ií]a|gasoil|gasolina|combustible|peaje|aparcamiento|parking|publicidad|marketing|proveedor|compra\s+(?:de\s+)?producto|stock|herramienta\s+digital|suscripci[oó]n|software|saas|comisi[oó]n\s+banco|comisi[oó]n\s+bancaria|gasto\s+banco|impuesto|tasa\s+(?:municipal|local)|ibi\b|basuras|reparaci[oó]n|averia|mantenimiento|formaci[oó]n|curso|taller/i.test(userInput)) {
    return { diablo: 'contable', intent: 'gasto_recurrente', confidence: 0.85 }
  }

  // Legal → El Abogado
  if (/\blegal\b|ley\b|artículo\b|normativa\b|legislaci[oó]n|obligaci[oó]n\s+fiscal|hacienda|agencia\s+tributaria|irpf|iva\s+(?:trimestral|anual)|modelo\s+\d{3}|verifactu|factura\s+electr[oó]nica/i.test(lower)) {
    return { diablo: 'abogado', intent: 'consulta_legal', confidence: 0.8 }
  }

  // Leads, captación → El Cazador
  if (/\blead\b|\bleads\b|captaci[oó]n|prospecci[oó]n|prospecto|cliente\s+potencial|captar\s+cliente/i.test(lower)) {
    return { diablo: 'cazador', intent: 'consulta_leads', confidence: 0.8 }
  }

  // Dashboard, salud financiera → El Guardián
  if (/salud\s+(?:financiera|del\s+negocio)|score|puntuaci[oó]n|c[oó]mo\s+(?:va|voy|estoy|est[aá])|resumen\s+(?:del\s+)?(?:mes|semana|negocio)|estado\s+(?:del\s+)?negocio/i.test(lower)) {
    return { diablo: 'guardian', intent: 'salud', confidence: 0.8 }
  }

  // 6. Unclear query → El Confesor (empático, no juzga)
  if (parsedIntent === 'unclear' || parsedIntent === 'unclear_query') {
    return { diablo: 'confesor', intent: parsedIntent, confidence: parsedConfidence }
  }

  // 7. Default: El Confesor handles anything unclassified
  return { diablo: 'confesor', intent: 'general', confidence: 0.5 }
}

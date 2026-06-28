/**
 * 🤝 El Closer — Gestiona la cartera de clientes.
 *
 * Maneja: crear cliente, guardar WhatsApp, guardar Bizum.
 */

import { createPendingAction } from '../confirmation'
import { getSupabase, DIABLO_METAS } from './index'
import type { DiabloHandler, DiabloResponse, IntentClassification } from './index'
import type { AgentInput } from '../core'

async function handle(input: AgentInput, classification: IntentClassification): Promise<DiabloResponse> {
  const { tenantId, userId } = input
  const userInput = (input.text || '').trim()

  // ── Guardar WhatsApp del dueño ────────────────────────────────────────────
  if (classification.intent === 'guardar_whatsapp') {
    const waMatch = userInput.match(
      /(?:mi\s+)?(?:whatsapp|wha|wa|número|numero|teléfono|telefono|telf?)\s+(?:es|:)?\s*\+?(\d[\d\s]{6,14}\d)/i
    )
    if (!waMatch) return { needsInfo: 'No pillé el número. Dime: "mi WhatsApp es 612345678"' }

    const rawNum = waMatch[1].replace(/\s/g, '')
    const normalized = rawNum.startsWith('34') ? rawNum : `34${rawNum}`
    const { error } = await getSupabase()
      .from('salons')
      .update({ whatsapp_number: normalized })
      .eq('id', tenantId)
    if (error) return { replyText: '❌ No pude guardar tu WhatsApp. Inténtalo de nuevo.' }
    return {
      replyText: `✅ WhatsApp guardado: +${normalized}\n\nAhora puedes enviarme audios o mensajes por WhatsApp y los proceso como si estuvieras aquí. 😈`
    }
  }

  // ── Guardar Bizum del dueño ───────────────────────────────────────────────
  if (classification.intent === 'guardar_bizum') {
    const bizumMatch = userInput.match(
      /(?:mi\s+)?(?:bizum|biz)\s+(?:es|:)?\s*\+?(\d[\d\s]{6,14}\d)/i
    )
    if (!bizumMatch) return { needsInfo: 'No pillé el número. Dime: "mi Bizum es 612345678"' }

    const rawBizum = bizumMatch[1].replace(/\s/g, '')
    const { error } = await getSupabase()
      .from('salons')
      .update({ bizum_number: rawBizum })
      .eq('id', tenantId)
    if (error) return { replyText: '❌ No pude guardar tu Bizum. Inténtalo de nuevo.' }
    return {
      replyText: `✅ Bizum guardado: ${rawBizum}\n\nA partir de ahora, los recordatorios del Cazador incluirán tu número Bizum para que tus clientes paguen al instante. 😈`
    }
  }

  // ── Crear cliente ─────────────────────────────────────────────────────────
  const mNombre = userInput.match(
    /(?:nuevo\s+cliente|cliente|añade|crea|registra|alta|mete|apunta)\s+(?:a\s+)?(?:llamad[oa]?\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{1,40}?)(?:\s+(?:con|tel\b|telf?\b|tlf\b|teléfono|telefono|email|,|$)|\s*$)/i
  )
  const nombre = mNombre ? mNombre[1].trim() : ''
  if (!nombre) {
    return { needsInfo: '¿Cómo se llama el cliente? Ej: "nuevo cliente Ana García"' }
  }

  const mPhone    = userInput.match(/(?:teléfono|telefono|telf?|móvil|movil|tlf)[\s:]+([+0-9\s]{7,15})/i)
  const mEmail    = userInput.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
  const mNif      = userInput.match(/(?:nif|cif|dni)[\s:]+([A-Z0-9]{7,9})/i)
  const mComercial = userInput.match(/(?:panadería|panaderia|bar|restaurante|cafetería|cafeteria|peluquería|peluqueria|tienda|negocio|empresa|clínica|clinica|farmacia|taller|academia|gimnasio|gym)\s+([A-Za-záéíóúñÁÉÍÓÚÑ\s]{2,30})/i)
  const nombreComercial = mComercial ? mComercial[0].trim() : undefined

  // Anti-duplicados
  try {
    const { data: existentes } = await getSupabase()
      .from('clients')
      .select('id, name')
      .eq('salon_id', tenantId)
      .ilike('name', `%${nombre.split(' ')[0]}%`)
      .limit(3)

    if (existentes && existentes.length > 0) {
      const lista = existentes.map(c => `• ${c.name}`).join('\n')
      return {
        needsInfo: `Ya tengo estos clientes con nombre similar:\n${lista}\n\n¿Es alguno de ellos? Si sí, dime cuál y le busco la ficha. Si es nuevo, dime "crear nuevo".`,
      }
    }
  } catch {}

  const card = await createPendingAction('crear_cliente', {
    nombre,
    nombre_comercial: nombreComercial,
    telefono: mPhone ? mPhone[1].trim().replace(/\s/g, '') : undefined,
    email:    mEmail ? mEmail[1]                            : undefined,
    nif:      mNif   ? mNif[1].toUpperCase()                : undefined,
  }, tenantId, userId)
  return { card }
}

export const CloserDiablo: DiabloHandler = {
  meta: DIABLO_METAS.closer,
  handle,
}

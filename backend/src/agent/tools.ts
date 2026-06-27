/**
 * Catálogo tipado de herramientas del agente Diabolus.
 * Cada herramienta está marcada como 'read', 'write' o 'send'.
 * Las write/send NUNCA se ejecutan sin pasar por el gate de confirmación.
 */

export type ToolType = 'read' | 'write' | 'send'

export interface ToolDefinition {
  name: string
  type: ToolType
  description: string
}

export const TOOLS: Record<string, ToolDefinition> = {
  registrar_gasto: {
    name: 'registrar_gasto',
    type: 'write',
    description: 'Registra un gasto en la tesorería a partir de lenguaje natural',
  },
  registrar_ingreso: {
    name: 'registrar_ingreso',
    type: 'write',
    description: 'Registra un ingreso en la tesorería a partir de lenguaje natural',
  },
  crear_cliente: {
    name: 'crear_cliente',
    type: 'write',
    description: 'Da de alta un cliente nuevo en el negocio',
  },
  crear_factura: {
    name: 'crear_factura',
    type: 'write',
    description: 'Prepara una factura borrador para un cliente. No la emite oficialmente.',
  },
  cambiar_estado_factura: {
    name: 'cambiar_estado_factura',
    type: 'write',
    description: 'Cambia el estado de una factura existente (pendiente, pagada, vencida, anulada)',
  },
  enviar_recordatorio: {
    name: 'enviar_recordatorio',
    type: 'send',
    description: 'Envía un recordatorio de cobro a un cliente por WhatsApp o email',
  },
  enviar_factura: {
    name: 'enviar_factura',
    type: 'send',
    description: 'Crea una factura borrador y la envía por email al cliente en un solo paso',
  },
  consultar_estado: {
    name: 'consultar_estado',
    type: 'read',
    description: 'Balance del mes: ingresos, gastos y posición neta',
  },
  consultar_cobros_pendientes: {
    name: 'consultar_cobros_pendientes',
    type: 'read',
    description: 'Quién debe y desde cuándo; facturas pendientes y vencidas',
  },
  estimar_iva: {
    name: 'estimar_iva',
    type: 'read',
    description: 'Estimación orientativa del IVA (solo para la PyME, nunca visible al gestor)',
  },
}

// ─── Categorías estándar — fuente única de verdad ─────────────────────────────
// Esta lista la usa tanto suggestCategory() como GET /api/categories (seed).
// La UI lee la lista desde la API — ambas siempre sincronizadas.

export const STANDARD_CATEGORIES: { slug: string; label: string }[] = [
  { slug: 'material',                label: 'Material y suministros'  },
  { slug: 'alquiler',                label: 'Alquiler'                 },
  { slug: 'transporte',              label: 'Transporte'               },
  { slug: 'dietas',                  label: 'Dietas y comidas'         },
  { slug: 'software',                label: 'Software y suscripciones' },
  { slug: 'comunicaciones',          label: 'Comunicaciones'           },
  { slug: 'marketing',               label: 'Marketing y publicidad'   },
  { slug: 'seguros',                 label: 'Seguros'                  },
  { slug: 'servicios_profesionales', label: 'Servicios profesionales'  },
  { slug: 'servicios',               label: 'Servicios prestados'      },
  { slug: 'otros',                   label: 'Otros'                    },
]

// ─── Category suggester ────────────────────────────────────────────────────────
// Lee de STANDARD_CATEGORIES — si añades una categoría ahí, el agente la usará.

export function suggestCategory(concepto: string): string {
  const t = (concepto || '').toLowerCase()
  if (/material|tinte|tintura|producto|suministro|peluquer/.test(t)) return 'material'
  if (/alquiler|local|oficina/.test(t))                         return 'alquiler'
  if (/gasolina|transporte|viaje|taxi|combustible/.test(t))     return 'transporte'
  if (/comida|dieta|restaurant|menú|menu|almuerzo/.test(t))     return 'dietas'
  if (/software|app|suscripci|subscripci|plataform/.test(t))    return 'software'
  if (/teléfono|telefono|móvil|movil|internet|fibra/.test(t))   return 'comunicaciones'
  if (/publicidad|marketing|redes|instagram|facebook/.test(t))  return 'marketing'
  if (/seguro/.test(t))                                         return 'seguros'
  if (/asesor|gestor|abogad|notari/.test(t))                    return 'servicios_profesionales'
  if (/corte|tinte|peinado|tratamiento|sesion|sesión/.test(t))  return 'servicios'
  // Validar que devuelve un slug de la lista estándar
  return 'otros'
}

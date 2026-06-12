// Las 12 tools de Diabolus v39 — schemas Zod estrictos.
// El modelo PROPONE tool calls; el servidor las valida aquí ANTES de tocar nada.
// Toda tool con write=true exige confirmación humana (autonomía nivel 0-1).

import { z } from 'zod';
import type { ToolName } from '../types.js';

const euros = z
  .number()
  .positive('El importe debe ser mayor que 0')
  .max(1_000_000, 'Importe fuera de rango')
  .refine((v) => Math.round(v * 100) === v * 100, 'Máximo 2 decimales');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato YYYY-MM-DD');
const shortText = z.string().min(1).max(300);
const id = z.string().min(1).max(64);

export const toolSchemas = {
  // ── ESCRITURA (confirmación obligatoria) ──
  create_income: z.object({
    amount: euros,
    concept: shortText,
    client_id: id.optional(),
    client_name: shortText.optional(), // el servidor lo resuelve a client_id vía find
    service_id: id.optional(),
    date: isoDate.optional(),
  }).strict(),

  create_expense: z.object({
    amount: euros,
    concept: shortText,
    date: isoDate.optional(),
  }).strict(),

  create_invoice: z.object({
    client_id: id,
    lines: z.array(z.object({
      concept: shortText,
      amount: euros,
      service_id: id.optional(),
    }).strict()).min(1).max(50),
    date: isoDate.optional(),
  }).strict(),

  create_client: z.object({
    name: shortText,
    phone: z.string().max(20).optional(),
    email: z.string().email().optional(),
  }).strict(),

  create_reminder: z.object({
    due_at: z.string().datetime({ offset: true }).or(isoDate),
    message: shortText,
  }).strict(),

  draft_message: z.object({
    client_id: id,
    purpose: z.enum(['seguimiento', 'cobro_pendiente', 'agradecimiento', 'recordatorio_cita']),
    tone: z.enum(['cercano', 'formal']).default('cercano'),
  }).strict(),

  send_to_gestoria: z.object({
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/, 'Periodo: YYYY-MM o YYYY-Q1..Q4'),
    format: z.enum(['csv', 'json']).default('csv'),
  }).strict(),

  // ── LECTURA (sin confirmación, paralelizables) ──
  find_client: z.object({ query: shortText }).strict(),
  find_service: z.object({ query: shortText }).strict(),
  get_balance: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
  }).strict(),
  get_pending_invoices: z.object({}).strict(),
  get_date: z.object({ relative_expr: shortText }).strict(),
} as const satisfies Record<ToolName, z.ZodTypeAny>;

export const WRITE_TOOLS: ReadonlySet<ToolName> = new Set([
  'create_income', 'create_expense', 'create_invoice', 'create_client',
  'create_reminder', 'draft_message', 'send_to_gestoria',
]);

export function isWriteTool(name: ToolName): boolean {
  return WRITE_TOOLS.has(name);
}

export interface ValidationOk { ok: true; data: Record<string, unknown> }
export interface ValidationErr { ok: false; errors: string[] }

/** Valida una tool call propuesta (por el parser o por el LLM). */
export function validateToolCall(name: string, args: unknown): ValidationOk | ValidationErr {
  if (!(name in toolSchemas)) {
    return { ok: false, errors: [`Tool desconocida: ${name}`] };
  }
  const schema = toolSchemas[name as ToolName];
  const result = schema.safeParse(args);
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  return { ok: true, data: result.data as Record<string, unknown> };
}

/** Definiciones en formato OpenAI/OpenRouter para tool calling nativo */
export function toolDefinitionsForLLM() {
  const describe: Record<ToolName, string> = {
    create_income: 'Registra un ingreso. Si el importe es ambiguo, NO la uses: pregunta al usuario.',
    create_expense: 'Registra un gasto.',
    create_invoice: 'Crea una factura para un cliente existente (usa find_client antes si solo tienes el nombre).',
    create_client: 'Crea un cliente nuevo. Úsala solo si find_client no encontró resultados y el usuario confirma.',
    create_reminder: 'Crea un recordatorio con fecha.',
    draft_message: 'Genera un borrador de mensaje para un cliente. NO envía nada.',
    send_to_gestoria: 'Prepara el export del periodo para la gestoría.',
    find_client: 'Busca clientes por nombre (match difuso). Si hay varios, pregunta al usuario cuál.',
    find_service: 'Busca servicios del negocio por nombre.',
    get_balance: 'Saldo de ingresos/gastos, opcionalmente por periodo.',
    get_pending_invoices: 'Facturas pendientes de cobro.',
    get_date: 'Resuelve fechas relativas ("ayer", "el martes pasado") a fecha ISO. Úsala SIEMPRE antes de escribir con fechas relativas.',
  };
  return (Object.keys(toolSchemas) as ToolName[]).map((name) => ({
    type: 'function' as const,
    function: {
      name,
      description: describe[name],
      parameters: zodToJsonSchemaLite(toolSchemas[name]),
    },
  }));
}

// Conversor mínimo Zod→JSON Schema para los tipos que usamos
// (evita una dependencia extra; cubrir object/string/number/enum/array/optional basta)
function zodToJsonSchemaLite(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as any)._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const v = value as z.ZodTypeAny;
        const inner = unwrap(v);
        properties[key] = zodToJsonSchemaLite(inner.schema);
        if (!inner.optional) required.push(key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodString': return { type: 'string' };
    case 'ZodNumber': return { type: 'number' };
    case 'ZodEnum': return { type: 'string', enum: def.values };
    case 'ZodArray': return { type: 'array', items: zodToJsonSchemaLite(def.type) };
    case 'ZodUnion': return zodToJsonSchemaLite(def.options[0]); // simplificación suficiente aquí
    case 'ZodEffects': return zodToJsonSchemaLite(def.schema);
    default: return { type: 'string' };
  }
}

function unwrap(schema: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean } {
  let s = schema;
  let optional = false;
  while (true) {
    const tn = (s as any)._def.typeName;
    if (tn === 'ZodOptional') { optional = true; s = (s as any)._def.innerType; continue; }
    if (tn === 'ZodDefault') { optional = true; s = (s as any)._def.innerType; continue; }
    break;
  }
  return { schema: s, optional };
}

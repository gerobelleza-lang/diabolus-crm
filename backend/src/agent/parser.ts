// @ts-nocheck
// L0 Parser - Deterministic, no LLM cost
// Extracts intent and data from user input using regex + dictionaries

export interface ParsedInput {
  intent: string;
  data: any;
  confidence: number;
}

const INCOME_KEYWORDS = [
  'ingreso', 'ingresos', 'cobro', 'cobros', 'ganancia', 'ganancias',
  'income', 'revenue',
  'cobré', 'recibí', 'recibi', 'me pagaron', 'me han pagado', 'me abonaron',
  'ingresé', 'ingrese', 'facturé', 'facture', 'vendí', 'vendi',
  'apunta ingreso', 'apunta un ingreso', 'anota ingreso', 'anota un ingreso',
  'mete ingreso', 'mete un ingreso', 'registra ingreso', 'registra un ingreso',
  'pon ingreso', 'pon un ingreso', 'añade ingreso', 'agrega ingreso',
  'crea ingreso', 'nuevo ingreso', 'alta ingreso',
  'cliente pagó', 'cliente me pagó', 'cobrado', 'servicio cobrado',
  'he cobrado', 'ha cobrado',
];

const EXPENSE_KEYWORDS = [
  'gasto', 'gastos', 'compra', 'compras', 'salida', 'salidas',
  'expense', 'desembolso',
  'gasté', 'pagué', 'compré', 'compre', 'aboné',
  'he pagado', 'he gastado', 'he comprado', 'he abonado',
  'desembolsé', 'invertí',
  'apunta gasto', 'apunta un gasto', 'anota gasto', 'anota un gasto',
  'mete gasto', 'mete un gasto', 'registra gasto', 'registra un gasto',
  'pon gasto', 'pon un gasto', 'añade gasto', 'agrega gasto',
  'crea gasto', 'nuevo gasto', 'alta gasto',
  'hice un pago', 'realicé un pago', 'pagué a',
];

// ── ALBARÁN ────────────────────────────────────────────────────────────────────
const ALBARAN_KEYWORDS = [
  'albarán', 'albaran', 'albaranear',
  'nota de entrega', 'nota de pedido', 'delivery note',
  'crea un albarán', 'crear albarán', 'hacer albarán',
  'genera albarán', 'generar albarán', 'nuevo albarán',
];

// ── FACTURA SEND ───────────────────────────────────────────────────────────────
const SEND_INVOICE_KEYWORDS = [
  'manda la factura', 'manda factura', 'envía la factura', 'envia la factura',
  'enviar factura', 'mandar factura', 'reenviar factura',
  'manda el recibo', 'envía el recibo',
];

const QUERY_KEYWORDS = ['¿', 'que', 'qué', 'como', 'cómo', 'cuál', 'cual', '?'];

export function parseUserInput(input: string): ParsedInput {
  const lowerInput = input.toLowerCase().trim();

  const numberMatches = input.match(/\d+([.,]\d+)?/g);
  const amounts = numberMatches?.map(n => parseFloat(n.replace(',', '.'))) || [];

  // ── ALBARÁN — va ANTES que income para evitar falsos positivos ─────────────
  if (includesAny(lowerInput, ALBARAN_KEYWORDS)) {
    return parseAlbaran(input, amounts);
  }

  // ── ENVÍO FACTURA ──────────────────────────────────────────────────────────
  if (includesAny(lowerInput, SEND_INVOICE_KEYWORDS)) {
    return parseSendInvoice(input);
  }

  // ── CONSULTA DE INGRESOS — ANTES de INCOME para evitar falsos positivos ──
  // Cubre: "cuánto/cuántos he cobrado", "ingresos de hoy/mes", "cuántos ingresos hemos hecho"...
  if (/cu[aá]nto[s]?\s+(cobr|ingres)/i.test(lowerInput) ||
      /cu[aá]nto[s]?\s+(he|ha|llevo|tengo|hemos)\s+(cobrado|cobré|ingresado|ingresé|facturado|ganado|hecho)/i.test(lowerInput) ||
      /qu[eé]\s+(he|ha|hemos)\s+(cobrado|ingresado|ganado|facturado)/i.test(lowerInput) ||
      /mis\s+ingresos|ingresos\s+del\s+mes|ingresos\s+de\s+este/i.test(lowerInput) ||
      /cu[aá]ntos?\s+ingresos/i.test(lowerInput) ||
      /ingresos\s+(de\s+hoy|de\s+esta|del\s+d[ií]a|hemos\s+hecho|que\s+hemos)/i.test(lowerInput) ||
      /hemos\s+(cobrado|ingresado|facturado|ganado)/i.test(lowerInput)) {
    return { intent: 'query_income', data: { type: 'income' }, confidence: 0.9 };
  }

  // ── CONSULTA DE GASTOS — ANTES de EXPENSE para evitar falsos positivos ──
  // Cubre: "cuánto he gastado", "cuánto gasté", "mis gastos del mes"
  if (/cu[aá]nto\s+(gast|pag)/i.test(lowerInput) ||
      /cu[aá]nto\s+(he|ha|llevo|tengo)\s+(gastado|gasté|pagado|pagué|desembolsado|comprado)/i.test(lowerInput) ||
      /qu[eé]\s+(he|ha)\s+(gastado|pagado|comprado|desembolsado)/i.test(lowerInput) ||
      /mis\s+gastos|gastos\s+del\s+mes|gastos\s+de\s+este/i.test(lowerInput)) {
    return { intent: 'query_expense', data: { type: 'expense' }, confidence: 0.9 };
  }

  // ── INCOME ─────────────────────────────────────────────────────────────────
  if (includesAny(lowerInput, INCOME_KEYWORDS)) {
    return parseIncome(input, amounts);
  }

  // ── EXPENSE ────────────────────────────────────────────────────────────────
  if (includesAny(lowerInput, EXPENSE_KEYWORDS)) {
    return parseExpense(input, amounts);
  }

  // Añadimos cuánto/cuanto a QUERY_KEYWORDS en tiempo de ejecución
  const extendedQueryKw = [...QUERY_KEYWORDS, 'cuánto', 'cuanto', 'cuántos', 'cuantos', 'cuánta', 'cuanta']
  if (includesAny(lowerInput, extendedQueryKw)) {
    return parseQuery(input);
  }

  if (includesAny(lowerInput, QUERY_KEYWORDS)) {
    return parseQuery(input);
  }

  if (lowerInput.includes('cobro') || lowerInput.includes('pendiente')) {
    return { intent: 'query_debtors', data: { type: 'pending' }, confidence: 0.7 };
  }

  return {
    intent: 'unclear',
    data: { rawInput: input },
    confidence: 0.3
  };
}

// ── parseAlbaran ───────────────────────────────────────────────────────────────
function parseAlbaran(input: string, amounts: number[]): ParsedInput {
  const amount = amounts.find(a => a > 0) || 0;

  // Extraer nombre de cliente tras "para" o "a"
  let clientName: string | null = null;
  const paraMatch = input.match(/(?:para|a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i);
  if (paraMatch) clientName = paraMatch[1];

  // Extraer descripción del servicio/producto tras "por" o "de"
  let description: string | null = null;
  const porMatch = input.match(/(?:por|de)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{2,50}?)(?:\s*\d|$)/i);
  if (porMatch) description = porMatch[1].trim();

  const items = description && amount
    ? [{ description: description.charAt(0).toUpperCase() + description.slice(1), quantity: 1, unit_price: amount }]
    : amount
      ? [{ description: 'Servicio prestado', quantity: 1, unit_price: amount }]
      : [];

  return {
    intent: 'crear_albaran',
    data: {
      clientName,
      items,
      total: amount,
      rawInput: input,
    },
    confidence: clientName ? 0.9 : 0.7,
  };
}

// ── parseSendInvoice ───────────────────────────────────────────────────────────
function parseSendInvoice(input: string): ParsedInput {
  let clientName: string | null = null;
  const deMatch = input.match(/(?:de|a|para)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i);
  if (deMatch) clientName = deMatch[1];

  return {
    intent: 'send_invoice',
    data: { clientName, rawInput: input },
    confidence: clientName ? 0.9 : 0.6,
  };
}

// ── parseIncome ────────────────────────────────────────────────────────────────
function parseIncome(input: string, amounts: number[]): ParsedInput {
  const amount = amounts.find(a => a > 0) || 0;

  let clientName = 'Cliente';
  const deMatch = input.match(/(?:de|para)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i);
  if (deMatch) clientName = deMatch[1];

  const concepts = ['corte', 'tinte', 'peinado', 'alisado', 'servicio', 'consulta', 'sesion', 'sesión', 'tratamiento', 'depilacion', 'depilación'];
  let concept = 'Servicio';
  for (const c of concepts) {
    if (input.toLowerCase().includes(c)) {
      concept = c.charAt(0).toUpperCase() + c.slice(1);
      break;
    }
  }

  if (concept === 'Servicio') {
    const porMatch = input.match(/(?:por|de)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{2,40}?)(?:\s*[,.]|$)/i);
    if (porMatch) {
      concept = porMatch[1].trim().charAt(0).toUpperCase() + porMatch[1].trim().slice(1);
    } else {
      const afterAmt = input.replace(/^[\s\S]*?\d+(?:[.,]\d+)?\s*(?:€|euros?)?\s*/i, '').trim();
      const stripped = afterAmt.replace(/^(crea|apunta|anota|mete|pon|registra|nuevo|alta|ingreso|gasto|cobro|cobré|recibí)\s*/gi, '').trim();
      if (stripped && stripped.length > 2) {
        concept = stripped.charAt(0).toUpperCase() + stripped.slice(1);
      }
    }
  }

  const vat = amount ? amount * 0.21 : 0;

  return {
    intent: 'create_income',
    data: { amount, clientName, concept, vat: Math.round(vat * 100) / 100 },
    confidence: amount > 0 ? 0.95 : 0.5
  };
}

// ── parseExpense ───────────────────────────────────────────────────────────────
function parseExpense(input: string, amounts: number[]): ParsedInput {
  const amount = amounts.find(a => a > 0) || 0;

  const concepts = ['tinturas', 'suministros', 'viaje', 'comida', 'transporte', 'alojamiento', 'materiales', 'gasolina', 'alquiler', 'software', 'telefono', 'teléfono'];
  let concept = 'Gasto';

  for (const c of concepts) {
    if (input.toLowerCase().includes(c)) {
      concept = c.charAt(0).toUpperCase() + c.slice(1);
      break;
    }
  }

  if (concept === 'Gasto') {
    const porMatch = input.match(/(?:en|por)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{2,40}?)(?:\s*[,.]|$)/i);
    if (porMatch) {
      concept = porMatch[1].trim().charAt(0).toUpperCase() + porMatch[1].trim().slice(1);
    } else {
      const afterAmt = input.replace(/^[\s\S]*?\d+(?:[.,]\d+)?\s*(?:€|euros?)?\s*/i, '').trim();
      const stripped = afterAmt.replace(/^(crea|apunta|anota|mete|pon|registra|nuevo|alta|ingreso|gasto|cobro|gasté|pagué)\s*/gi, '').trim();
      if (stripped && stripped.length > 2) {
        concept = stripped.charAt(0).toUpperCase() + stripped.slice(1);
      }
    }
  }

  return {
    intent: 'create_expense',
    data: { amount, concept },
    confidence: amount > 0 ? 0.95 : 0.5
  };
}

// ── parseQuery ─────────────────────────────────────────────────────────────────
function parseQuery(input: string): ParsedInput {
  const lowerInput = input.toLowerCase();

  if (includesAny(lowerInput, ['quién', 'quien']) && includesAny(lowerInput, ['debe', 'deben', 'cobrar'])) {
    return { intent: 'query_who_owes', data: { type: 'who_owes' }, confidence: 0.9 };
  }
  if (includesAny(lowerInput, ['vencido', 'vencida', 'vencidos', 'vencidas', 'atrasado', 'atrasada', 'retraso'])) {
    return { intent: 'query_overdue', data: { type: 'overdue' }, confidence: 0.9 };
  }
  if (includesAny(lowerInput, ['me deben', 'me debe', 'pendiente', 'morosos', 'deuda'])) {
    return { intent: 'query_debtors', data: { type: 'pending' }, confidence: 0.9 };
  }
  if (includesAny(lowerInput, ['balance', 'dinero', 'cuánto tengo', 'cuanto tengo', 'saldo'])) {
    return { intent: 'query_balance', data: { type: 'balance' }, confidence: 0.9 };
  }
  if (includesAny(lowerInput, ['ingresos', 'gané', 'ganancia', 'ingresé', 'he cobrado', 'cuánto he cobrado', 'cuanto he cobrado'])) {
    return { intent: 'query_income', data: { type: 'income' }, confidence: 0.8 };
  }
  if (includesAny(lowerInput, ['gastos', 'gasto total', 'salidas', 'cuánto he gastado', 'cuanto he gastado'])) {
    return { intent: 'query_expense', data: { type: 'expense' }, confidence: 0.8 };
  }

  return {
    intent: 'unclear_query',
    data: { rawInput: input },
    confidence: 0.4
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some(keyword => text.includes(keyword));
}

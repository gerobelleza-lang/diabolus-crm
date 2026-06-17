// @ts-nocheck
// L0 Parser - Deterministic, no LLM cost
// Extracts intent and data from user input using regex + dictionaries

export interface ParsedInput {
  intent: string;
  data: any;
  confidence: number;
}

const INCOME_KEYWORDS = [
  // Sustantivos directos (no ambiguos)
  'ingreso', 'ingresos', 'cobro', 'cobros', 'ganancia', 'ganancias',
  'income', 'revenue',
  // Verbos acción pasada
  'cobré', 'recibí', 'recibi', 'me pagaron', 'me han pagado', 'me abonaron',
  'ingresé', 'ingrese', 'facturé', 'facture', 'vendí', 'vendi',
  // Verbos imperativo / presente narrativo — solo si van acompañados de "ingreso/cobro"
  'apunta ingreso', 'apunta un ingreso', 'anota ingreso', 'anota un ingreso',
  'mete ingreso', 'mete un ingreso', 'registra ingreso', 'registra un ingreso',
  'pon ingreso', 'pon un ingreso', 'añade ingreso', 'agrega ingreso',
  'crea ingreso', 'nuevo ingreso', 'alta ingreso',
  // Contexto negocio
  'cliente pagó', 'cliente me pagó', 'cobrado', 'servicio cobrado',
  'he cobrado', 'ha cobrado',
];
const EXPENSE_KEYWORDS = [
  // Sustantivos directos
  'gasto', 'gastos', 'compra', 'compras', 'salida', 'salidas',
  'expense', 'desembolso',
  // Verbos acción pasada
  'gasté', 'pagué', 'compré', 'compre', 'aboné',
  'he pagado', 'he gastado', 'he comprado', 'he abonado',
  'desembolsé', 'invertí',
  // Verbos imperativo / presente narrativo — solo si van acompañados de "gasto/pago"
  'apunta gasto', 'apunta un gasto', 'anota gasto', 'anota un gasto',
  'mete gasto', 'mete un gasto', 'registra gasto', 'registra un gasto',
  'pon gasto', 'pon un gasto', 'añade gasto', 'agrega gasto',
  'crea gasto', 'nuevo gasto', 'alta gasto',
  // pago/pagos como sustantivo de gasto (nunca como cobro)
  'hice un pago', 'realicé un pago', 'pagué a',
];
const QUERY_KEYWORDS = ['¿', 'que', 'qué', 'como', 'cómo', 'cuál', 'cual', '?'];

export function parseUserInput(input: string): ParsedInput {
  const lowerInput = input.toLowerCase().trim();

  // Extract numbers (including decimals)
  const numberMatches = input.match(/\d+([.,]\d+)?/g);
  const amounts = numberMatches?.map(n => parseFloat(n.replace(',', '.'))) || [];

  // INCOME: usa includes en vez de startsWith para capturar
  // "cobré 300€", "hoy cobré 300", "me pagaron 150€"
  if (includesAny(lowerInput, INCOME_KEYWORDS)) {
    return parseIncome(input, amounts);
  }

  // EXPENSE: mismo, captura "hoy gasté", "he pagado 80€"
  if (includesAny(lowerInput, EXPENSE_KEYWORDS)) {
    return parseExpense(input, amounts);
  }

  if (includesAny(lowerInput, QUERY_KEYWORDS)) {
    return parseQuery(input);
  }

  // Último recurso: si hay un número y no hay intent claro, intenta queries
  if (lowerInput.includes('cobro') || lowerInput.includes('pendiente')) {
    return { intent: 'query_debtors', data: { type: 'pending' }, confidence: 0.7 };
  }

  return {
    intent: 'unclear',
    data: { rawInput: input },
    confidence: 0.3
  };
}

function parseIncome(input: string, amounts: number[]): ParsedInput {
  // Tomar el primer número significativo (mayor de 0)
  const amount = amounts.find(a => a > 0) || 0;

  // Extraer nombre de cliente: palabra después del importe o después de "de"
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

  // Si no hay concepto de servicios, extraer del texto de forma flexible
  if (concept === 'Servicio') {
    // 1. Buscar tras "por" o "de"
    const porMatch = input.match(/(?:por|de)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{2,40}?)(?:\s*[,.]|$)/i)
    if (porMatch) {
      concept = porMatch[1].trim().charAt(0).toUpperCase() + porMatch[1].trim().slice(1)
    } else {
      // 2. Texto libre después del importe (ej: "75 euros venta peluqueria")
      const afterAmt = input.replace(/^[\s\S]*?\d+(?:[.,]\d+)?\s*(?:€|euros?)?\s*/i, '').trim()
      const stripped = afterAmt.replace(/^(crea|apunta|anota|mete|pon|registra|nuevo|alta|ingreso|gasto|cobro|cobré|recibí)\s*/gi, '').trim()
      if (stripped && stripped.length > 2) {
        concept = stripped.charAt(0).toUpperCase() + stripped.slice(1)
      }
    }
  }

  const vat = amount ? amount * 0.21 : 0;

  return {
    intent: 'create_income',
    data: {
      amount,
      clientName,
      concept,
      vat: Math.round(vat * 100) / 100
    },
    confidence: amount > 0 ? 0.95 : 0.5
  };
}

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

  // Intentar extraer concepto del texto si no está en la lista
  if (concept === 'Gasto') {
    const porMatch = input.match(/(?:en|por)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]{2,40}?)(?:\s*[,.]|$)/i)
    if (porMatch) {
      concept = porMatch[1].trim().charAt(0).toUpperCase() + porMatch[1].trim().slice(1)
    } else {
      const afterAmt = input.replace(/^[\s\S]*?\d+(?:[.,]\d+)?\s*(?:€|euros?)?\s*/i, '').trim()
      const stripped = afterAmt.replace(/^(crea|apunta|anota|mete|pon|registra|nuevo|alta|ingreso|gasto|cobro|gasté|pagué)\s*/gi, '').trim()
      if (stripped && stripped.length > 2) {
        concept = stripped.charAt(0).toUpperCase() + stripped.slice(1)
      }
    }
  }

  return {
    intent: 'create_expense',
    data: {
      amount,
      concept
    },
    confidence: amount > 0 ? 0.95 : 0.5
  };
}

function parseQuery(input: string): ParsedInput {
  const lowerInput = input.toLowerCase();

  // IMPORTANT: More specific patterns first to avoid false positives

  // Who owes: ¿quién me debe?
  if (includesAny(lowerInput, ['quién', 'quien']) && includesAny(lowerInput, ['debe', 'deben', 'cobrar'])) {
    return { intent: 'query_who_owes', data: { type: 'who_owes' }, confidence: 0.9 };
  }

  // Overdue: ¿qué está vencido?
  if (includesAny(lowerInput, ['vencido', 'vencida', 'vencidos', 'vencidas', 'atrasado', 'atrasada', 'retraso'])) {
    return { intent: 'query_overdue', data: { type: 'overdue' }, confidence: 0.9 };
  }

  // How much owed: ¿cuánto me deben?
  if (includesAny(lowerInput, ['me deben', 'me debe', 'pendiente', 'morosos', 'deuda'])) {
    return { intent: 'query_debtors', data: { type: 'pending' }, confidence: 0.9 };
  }

  // Balance: ¿cuánto tengo?
  if (includesAny(lowerInput, ['balance', 'dinero', 'cuánto tengo', 'cuanto tengo', 'saldo'])) {
    return { intent: 'query_balance', data: { type: 'balance' }, confidence: 0.9 };
  }

  // Income queries
  if (includesAny(lowerInput, ['ingresos', 'gané', 'ganancia', 'ingresé', 'he cobrado'])) {
    return { intent: 'query_income', data: { type: 'income' }, confidence: 0.8 };
  }

  // Expense queries
  if (includesAny(lowerInput, ['gastos', 'gasto total', 'salidas', 'cuánto he gastado', 'cuanto he gastado'])) {
    return { intent: 'query_expense', data: { type: 'expense' }, confidence: 0.8 };
  }

  return {
    intent: 'unclear_query',
    data: { rawInput: input },
    confidence: 0.4
  };
}

// Helpers
function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some(keyword => text.includes(keyword));
}

// @ts-nocheck
// L0 Parser - Deterministic, no LLM cost
// Extracts intent and data from user input using regex + dictionaries

export interface ParsedInput {
  intent: string;
  data: any;
  confidence: number;
}

const INCOME_KEYWORDS = ['ingreso', 'cobré', 'cobré', 'income', 'revenue', 'ganancia', 'entrada', 'recibí', 'recibi', 'me pagaron', 'me han pagado'];
const EXPENSE_KEYWORDS = ['gasto', 'gasté', 'gasté', 'expense', 'pago', 'pagué', 'pagué', 'salida', 'compré', 'compre', 'he pagado', 'he gastado'];
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

  // Si no hay concepto de servicios, intentar extraerlo del texto
  if (concept === 'Servicio') {
    const enMatch = input.match(/(?:en|por)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ]+(?:\s+[a-záéíóúñA-ZÁÉÍÓÚÑ]+)?)/i);
    if (enMatch) concept = enMatch[1].charAt(0).toUpperCase() + enMatch[1].slice(1);
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
    const enMatch = input.match(/(?:en|por)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ]+(?:\s+[a-záéíóúñA-ZÁÉÍÓÚÑ]+)?)/i);
    if (enMatch) concept = enMatch[1].charAt(0).toUpperCase() + enMatch[1].slice(1);
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

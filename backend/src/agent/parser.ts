// @ts-nocheck
// L0 Parser - Deterministic, no LLM cost
// Extracts intent and data from user input using regex + dictionaries

export interface ParsedInput {
  intent: string;
  data: any;
  confidence: number;
}

const INCOME_KEYWORDS = ['ingreso', 'cobré', 'cobrÉ', 'income', 'revenue', 'ganancia', 'entrada'];
const EXPENSE_KEYWORDS = ['gasto', 'gasté', 'expense', 'pago', 'pagué', 'salida'];
const QUERY_KEYWORDS = ['¿', 'que', 'qué', 'como', 'cómo', 'cuál', 'cual', '?'];

export function parseUserInput(input: string): ParsedInput {
  const lowerInput = input.toLowerCase().trim();

  // Extract numbers
  const numberMatches = input.match(/\d+/g);
  const amounts = numberMatches?.map(Number) || [];

  // Check intent
  if (startsWithAny(lowerInput, INCOME_KEYWORDS)) {
    return parseIncome(input, amounts);
  }

  if (startsWithAny(lowerInput, EXPENSE_KEYWORDS)) {
    return parseExpense(input, amounts);
  }

  if (includes(lowerInput, QUERY_KEYWORDS)) {
    return parseQuery(input);
  }

  return {
    intent: 'unclear',
    data: { rawInput: input },
    confidence: 0.3
  };
}

function parseIncome(input: string, amounts: number[]): ParsedInput {
  const amount = amounts[0];

  let clientName = '';
  const words = input.split(/\s+/);
  const amountIndex = words.findIndex(w => amounts.includes(parseInt(w)));

  if (amountIndex !== -1 && words[amountIndex + 1]) {
    clientName = words[amountIndex + 1];
  }

  const concepts = ['corte', 'tinte', 'peinado', 'alisado', 'servicio', 'consulta', 'sesion', 'sesión'];
  let concept = 'Servicio';
  for (const c of concepts) {
    if (input.toLowerCase().includes(c)) {
      concept = c.charAt(0).toUpperCase() + c.slice(1);
      break;
    }
  }

  const vat = amount ? amount * 0.21 : 0;

  return {
    intent: 'create_income',
    data: {
      amount: amount || 0,
      clientName: clientName || 'Cliente',
      concept,
      vat: Math.round(vat * 100) / 100
    },
    confidence: amount ? 0.95 : 0.5
  };
}

function parseExpense(input: string, amounts: number[]): ParsedInput {
  const amount = amounts[0];

  const concepts = ['tinturas', 'suministros', 'viaje', 'comida', 'transporte', 'alojamiento', 'materiales'];
  let concept = 'Gasto';

  for (const c of concepts) {
    if (input.toLowerCase().includes(c)) {
      concept = c.charAt(0).toUpperCase() + c.slice(1);
      break;
    }
  }

  return {
    intent: 'create_expense',
    data: {
      amount: amount || 0,
      concept
    },
    confidence: amount ? 0.95 : 0.5
  };
}

function parseQuery(input: string): ParsedInput {
  const lowerInput = input.toLowerCase();

  // Balance queries: ¿cuánto tengo? ¿cuál es mi saldo?
  if (includes(lowerInput, ['balance', 'dinero', 'cuánto tengo', 'cuanto tengo', 'saldo'])) {
    return {
      intent: 'query_balance',
      data: { type: 'balance' },
      confidence: 0.9
    };
  }

  // Overdue queries: ¿qué está vencido? ¿facturas vencidas?
  if (includes(lowerInput, ['vencido', 'vencida', 'vencidos', 'vencidas', 'atrasado', 'atrasada', 'retraso'])) {
    return {
      intent: 'query_overdue',
      data: { type: 'overdue' },
      confidence: 0.9
    };
  }

  // Who owes: ¿quién me debe? ¿quién me debe dinero?
  if (includes(lowerInput, ['quién', 'quien']) && includes(lowerInput, ['debe', 'deben', 'cobrar'])) {
    return {
      intent: 'query_who_owes',
      data: { type: 'who_owes' },
      confidence: 0.9
    };
  }

  // How much owed: ¿cuánto me deben? ¿qué me deben?
  if (includes(lowerInput, ['me deben', 'me debe', 'pendiente', 'cobrar', 'morosos', 'deuda'])) {
    return {
      intent: 'query_debtors',
      data: { type: 'pending' },
      confidence: 0.9
    };
  }

  // Income queries
  if (includes(lowerInput, ['ingresos', 'gané', 'ganancia', 'ingresé'])) {
    return {
      intent: 'query_income',
      data: { type: 'income' },
      confidence: 0.8
    };
  }

  // Expense queries
  if (includes(lowerInput, ['gastos', 'gasté', 'gasto', 'salidas'])) {
    return {
      intent: 'query_expense',
      data: { type: 'expense' },
      confidence: 0.8
    };
  }

  return {
    intent: 'unclear_query',
    data: { rawInput: input },
    confidence: 0.4
  };
}

// Helpers
function startsWithAny(text: string, keywords: string[]): boolean {
  return keywords.some(keyword => text.startsWith(keyword));
}

function includes(text: string, keywords: string[]): boolean {
  return keywords.some(keyword => text.includes(keyword));
}

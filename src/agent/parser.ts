import type { ToolCall } from './types.js';

export interface ParseResult {
  toolCall: ToolCall;
  confidence: 'exact';
}

export function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/€|eur(os)?/gi, '').trim();
  const normalized = cleaned.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) return null;
  return Math.round(value * 100) / 100;
}

const INCOME_WORDS = [
  'he cobrado', 'cobrado', 'cobro',
  'he recibido', 'recibido',
  'he facturado', 'facturado',
  'ingreso', 'ingresa', 'apunta ingreso', 'cobre',
];

const EXPENSE_WORDS = [
  'he pagado', 'pagado', 'pago',
  'he gastado', 'gastado', 'gasto', 'gasta',
  'he comprado', 'comprado', 'compra',
  'apunta gasto', 'pague', 'compre',
];

const PENDING_INCOME_PATTERNS = [
  { words: ['me deben'], needsAmount: true },
  { words: ['me debe'], needsAmount: true },
  { words: ['tengo que cobrar'], needsAmount: true },
  { words: ['estoy esperando'], needsAmount: true },
];

const PENDING_EXPENSE_PATTERNS = [
  { words: ['tengo que pagar'], needsAmount: true },
  { words: ['me debe pagar'], needsAmount: true },
  { words: ['debo pagar'], needsAmount: true },
];

const AMBIGUITY_MARKERS = [
  'ayer', 'manana', 'pasado', 'semana', 'mes que viene',
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
  ' y ', ' luego ', ' despues ', ' ademas ', ', ',
  'recuerda', 'avisa', 'envia', 'manda',
  'cuanto', 'como va', 'compara', 'analiza',
  'creo que', 'deberia', 'podria',
];

export function parseDeterministic(input: string): ParseResult | null {
  const original = input.trim();
  const text = normalize(original);
  if (!text) return null;

  for (const marker of AMBIGUITY_MARKERS) {
    if (text.includes(marker)) return null;
  }

  let type: 'income' | 'expense' | null = null;
  let status: 'paid' | 'pending' = 'paid';
  let matchedWord = '';

  for (const pattern of PENDING_INCOME_PATTERNS) {
    for (const word of pattern.words) {
      if (text.includes(word)) {
        type = 'income';
        status = 'pending';
        matchedWord = word;
        break;
      }
    }
    if (type) break;
  }

  if (!type) {
    for (const pattern of PENDING_EXPENSE_PATTERNS) {
      for (const word of pattern.words) {
        if (text.includes(word)) {
          type = 'expense';
          status = 'pending';
          matchedWord = word;
          break;
        }
      }
      if (type) break;
    }
  }

  if (!type) {
    for (const w of INCOME_WORDS) {
      if (text.includes(w)) {
        type = 'income';
        status = 'paid';
        matchedWord = w;
        break;
      }
    }
  }
  if (!type) {
    for (const w of EXPENSE_WORDS) {
      if (text.includes(w)) {
        type = 'expense';
        status = 'paid';
        matchedWord = w;
        break;
      }
    }
  }
  if (!type) return null;

  const idx = text.indexOf(matchedWord);
  const afterKeyword = text.slice(idx + matchedWord.length).trim();
  const amountMatch = afterKeyword.match(/^(?:de\s+)?([\d.,]+\s*(?:€|euros?|eur)?)/);
  if (!amountMatch) return null;
  const amount = parseAmount(amountMatch[1]);
  if (amount === null) return null;

  let rest = afterKeyword.slice(amountMatch[0].length).trim();

  let concept = '';
  let name: string | undefined;

  if (!rest) {
    // Sin resto: usar conceptos default
    concept = type === 'income' ? 'ingreso' : 'gasto';
  } else if (rest.startsWith('de ')) {
    // "de <X>" o "de <X> por <Y>"
    const deRest = rest.slice(3);
    const byIdx = deRest.lastIndexOf(' por ');
    if (byIdx > 0) {
      // "de <X> por <Y>"
      name = deRest.slice(0, byIdx);
      concept = deRest.slice(byIdx + 5);
    } else {
      // "de <X>" → X es cliente, concepto es default
      name = deRest;
      concept = type === 'income' ? 'servicio' : 'compra';
    }
  } else {
    // "CONCEPTO a NOMBRE" o solo "CONCEPTO"
    const aMatch = rest.match(/^(.+?)\s+a\s+([a-zn ]+)$/);
    if (aMatch) {
      concept = aMatch[1];
      name = aMatch[2];
    } else {
      // Solo concepto: busca última palabra mayúscula como cliente
      concept = rest.replace(/^(por|del|en|hacia)\s+/, '').trim();

      const tokens = original.split(/\s+/);
      const last = tokens[tokens.length - 1];
      if (/^[A-ZÁÉÍÓÚÑ]/.test(last) && tokens.length >= 3) {
        const lastNorm = normalize(last);
        if (!concept.toLowerCase().includes(lastNorm)) {
          name = lastNorm;
          const parts = concept.split(/\s+/);
          if (parts.length > 1 && normalize(parts[parts.length - 1]) === lastNorm) {
            concept = parts.slice(0, -1).join(' ').trim() || concept;
          }
        }
      }
    }
  }

  if (!concept.trim()) {
    concept = type === 'income' ? 'ingreso' : 'gasto';
  }

  const tool = type === 'income' ? 'create_income' : 'create_expense';
  const args: Record<string, unknown> = { amount, concept: concept.trim() };

  if (name) {
    if (type === 'income') {
      args.client_name = name;
    } else {
      args.vendor_name = name;
    }
  }

  return { toolCall: { tool, args }, confidence: 'exact' };
}

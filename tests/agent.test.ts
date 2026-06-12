import { describe, expect, it } from 'vitest';
import { parseDeterministic, parseAmount } from '../src/agent/parser.js';
import { route } from '../src/agent/router.js';
import { validateToolCall, isWriteTool } from '../src/agent/tools/schemas.js';
import {
  handleToolCall, executeConfirmed, cancelConfirmed, resolveRelativeDate,
} from '../src/agent/tools/executor.js';
import { createInMemoryRepo } from '../src/db/inMemoryRepo.js';

// ─────────────────────────────────────────────
// PARSER DETERMINISTA (nivel 0) — 15+ frases
// ─────────────────────────────────────────────
describe('parser determinista', () => {
  const shouldMatch: Array<[string, 'create_income' | 'create_expense', number]> = [
    ['ingreso 50 corte maria', 'create_income', 50],
    ['ingreso 50€ corte', 'create_income', 50],
    ['Ingreso de 80 por manicura a Lucia', 'create_income', 80],
    ['cobro 25 manicura', 'create_income', 25],
    ['he cobrado 45 tinte Carmen', 'create_income', 45],
    ['gasto 23,50 tinte proveedor', 'create_expense', 23.5],
    ['gasto 120 de luz', 'create_expense', 120],
    ['he pagado 60 productos', 'create_expense', 60],
    ['pago 35 limpieza local', 'create_expense', 35],
    ['compra 15,75 guantes', 'create_expense', 15.75],
  ];

  it.each(shouldMatch)('"%s" → %s %d€', (frase, tool, amount) => {
    const r = parseDeterministic(frase);
    expect(r).not.toBeNull();
    expect(r!.toolCall.tool).toBe(tool);
    expect(r!.toolCall.args.amount).toBe(amount);
  });

  const shouldNotMatch: string[] = [
    'ingreso de maria',                       // sin importe → el agente debe PREGUNTAR
    'apunta 50 de ayer',                      // fecha relativa → get_date vía LLM
    'factura a García el tinte',              // otra tool → LLM
    'ingreso 50 corte y gasto 20 productos',  // multi-paso → nivel 2
    'cuanto llevo este mes',                  // consulta → LLM
    'hola buenas',                            // charla
    'ingreso 50',                             // sin concepto → preguntar
    'ingreso cero euros corte',               // importe inválido
  ];

  it.each(shouldNotMatch)('"%s" → null (sube al LLM)', (frase) => {
    expect(parseDeterministic(frase)).toBeNull();
  });

  it('extrae cliente con "a <nombre>"', () => {
    const r = parseDeterministic('ingreso 80 manicura a lucia');
    expect(r!.toolCall.args.client_name).toBe('lucia');
    expect(r!.toolCall.args.concept).toBe('manicura');
  });

  it('parseAmount formato español', () => {
    expect(parseAmount('1.250,75')).toBe(1250.75);
    expect(parseAmount('50€')).toBe(50);
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
  });
});

// ─────────────────────────────────────────────
// ROUTER — niveles correctos = coste correcto
// ─────────────────────────────────────────────
describe('router de niveles', () => {
  it('patrón exacto → nivel 0 con toolCall', () => {
    const d = route('ingreso 50 corte maria');
    expect(d.level).toBe(0);
    expect(d.toolCall).toBeDefined();
  });
  it('análisis → nivel 3 (modelo grande)', () => {
    expect(route('como va el trimestre comparado con el anterior').level).toBe(3);
    expect(route('analiza mis gastos de mayo').level).toBe(3);
  });
  it('multi-paso → nivel 2', () => {
    expect(route('factura a María el tinte y mándale recordatorio').level).toBe(2);
  });
  it('frase natural simple → nivel 1', () => {
    expect(route('apúntame el corte de la clienta de las 5').level).toBe(1);
  });
});

// ─────────────────────────────────────────────
// SCHEMAS — validación estricta server-side
// ─────────────────────────────────────────────
describe('validación de tools', () => {
  it('acepta payload válido', () => {
    const r = validateToolCall('create_income', { amount: 50, concept: 'corte' });
    expect(r.ok).toBe(true);
  });
  it('rechaza importe negativo, cero y >2 decimales', () => {
    expect(validateToolCall('create_income', { amount: -5, concept: 'x' }).ok).toBe(false);
    expect(validateToolCall('create_income', { amount: 0, concept: 'x' }).ok).toBe(false);
    expect(validateToolCall('create_income', { amount: 10.999, concept: 'x' }).ok).toBe(false);
  });
  it('rechaza tool desconocida y campos extra (strict)', () => {
    expect(validateToolCall('drop_database', {}).ok).toBe(false);
    expect(validateToolCall('create_expense', { amount: 10, concept: 'x', sql: 'DROP' }).ok).toBe(false);
  });
  it('clasifica escritura vs lectura', () => {
    expect(isWriteTool('create_income')).toBe(true);
    expect(isWriteTool('get_balance')).toBe(false);
  });
});

// ─────────────────────────────────────────────
// FLUJO DE CONFIRMACIÓN + AUDITORÍA (criterios sección 9 del SPEC)
// ─────────────────────────────────────────────
describe('confirmación humana y auditoría', () => {
  it('escritura → pendiente; confirmada → ejecuta y audita', async () => {
    const repo = createInMemoryRepo();
    const outcome = await handleToolCall(repo, { tool: 'create_income', args: { amount: 50, concept: 'corte' } }, 0);
    expect('confirmRequired' in outcome && outcome.confirmRequired).toBe(true);
    const conf = (outcome as { confirmation: { id: string } }).confirmation;

    const exec = await executeConfirmed(repo, conf.id, 0);
    expect(exec.ok).toBe(true);

    const balance = await repo.getBalance();
    expect(balance.income).toBe(50);

    const log = await repo.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].confirmed).toBe(true);
  });

  it('cancelar → NO escribe nada y queda auditado', async () => {
    const repo = createInMemoryRepo();
    const outcome = await handleToolCall(repo, { tool: 'create_expense', args: { amount: 99, concept: 'prueba' } }, 0);
    const conf = (outcome as { confirmation: { id: string } }).confirmation;

    await cancelConfirmed(repo, conf.id, 0);

    const balance = await repo.getBalance();
    expect(balance.expense).toBe(0); // nada escrito
    const log = await repo.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].confirmed).toBe(false);
    expect((log[0].result as { cancelled: boolean }).cancelled).toBe(true);
  });

  it('payload inválido del "modelo" → error controlado, nunca crash', async () => {
    const repo = createInMemoryRepo();
    const outcome = await handleToolCall(repo, { tool: 'create_income', args: { amount: 'cincuenta' } }, 1);
    expect(outcome.ok).toBe(false);
  });

  it('cliente ambiguo (2 Garcías) → pide aclaración con opciones', async () => {
    const repo = createInMemoryRepo();
    await repo.createClient({ name: 'Ana García' });
    await repo.createClient({ name: 'Luis García' });
    const outcome = await handleToolCall(repo, {
      tool: 'create_income',
      args: { amount: 30, concept: 'corte', client_name: 'garcia' },
    }, 1);
    expect('clarify' in outcome).toBe(true);
    expect((outcome as { options: unknown[] }).options).toHaveLength(2);
  });

  it('lecturas ejecutan directo sin confirmación', async () => {
    const repo = createInMemoryRepo();
    const outcome = await handleToolCall(repo, { tool: 'get_balance', args: {} }, 0);
    expect('result' in outcome).toBe(true);
  });
});

// ─────────────────────────────────────────────
// FECHAS RELATIVAS
// ─────────────────────────────────────────────
describe('resolveRelativeDate', () => {
  const base = new Date('2026-06-10T12:00:00Z'); // miércoles
  it('ayer / hoy / mañana', () => {
    expect(resolveRelativeDate('ayer', base)).toBe('2026-06-09');
    expect(resolveRelativeDate('hoy', base)).toBe('2026-06-10');
    expect(resolveRelativeDate('mañana', base)).toBe('2026-06-11');
  });
  it('el martes pasado', () => {
    expect(resolveRelativeDate('el martes pasado', base)).toBe('2026-06-09');
  });
});

// ─────────────────────────────────────────────
// FASE 2 — PATRONES TESORERÍA EXPANDIDOS
// ─────────────────────────────────────────────
describe('parser — patrones tesorería v38.1', () => {
  it('TEST 1: "He cobrado 450€ de Cliente Prueba por servicio web"', () => {
    const result = parseDeterministic('He cobrado 450€ de Cliente Prueba por servicio web');
    expect(result).toBeTruthy();
    expect(result!.toolCall.tool).toBe('create_income');
    expect(result!.toolCall.args.amount).toBe(450);
    expect(result!.toolCall.args.concept).toBe('servicio web');
    expect(result!.toolCall.args.client_name).toBe('cliente prueba');
    expect(result!.toolCall.args.status).toBe('paid');
  });

  it('TEST 2: "He pagado 120€ de hosting"', () => {
    const result = parseDeterministic('He pagado 120€ de hosting');
    expect(result).toBeTruthy();
    expect(result!.toolCall.tool).toBe('create_expense');
    expect(result!.toolCall.args.amount).toBe(120);
    expect(result!.toolCall.args.concept).toBe('hosting');
    expect(result!.toolCall.args.status).toBe('paid');
  });

  it('TEST 3: "Me deben 900€ de Cliente Prueba por mantenimiento"', () => {
    const result = parseDeterministic('Me deben 900€ de Cliente Prueba por mantenimiento');
    expect(result).toBeTruthy();
    expect(result!.toolCall.tool).toBe('create_income');
    expect(result!.toolCall.args.amount).toBe(900);
    expect(result!.toolCall.args.concept).toBe('mantenimiento');
    expect(result!.toolCall.args.client_name).toBe('cliente prueba');
    expect(result!.toolCall.args.status).toBe('pending');
  });

  it('TEST 4: "He cobrado 1.200,50€ de Cliente Grande por proyecto web"', () => {
    const result = parseDeterministic('He cobrado 1.200,50€ de Cliente Grande por proyecto web');
    expect(result).toBeTruthy();
    expect(result!.toolCall.tool).toBe('create_income');
    expect(result!.toolCall.args.amount).toBe(1200.50);
    expect(result!.toolCall.args.concept).toBe('proyecto web');
    expect(result!.toolCall.args.client_name).toBe('cliente grande');
    expect(result!.toolCall.args.status).toBe('paid');
  });

  it('TEST 5: "He pagado 89,99€ de OpenAI"', () => {
    const result = parseDeterministic('He pagado 89,99€ de OpenAI');
    expect(result).toBeTruthy();
    expect(result!.toolCall.tool).toBe('create_expense');
    expect(result!.toolCall.args.amount).toBe(89.99);
    expect(result!.toolCall.args.concept).toBe('openai');
    expect(result!.toolCall.args.status).toBe('paid');
  });
});

describe('parser — variaciones de patrones (20 casos)', () => {
  // VARIACIONES INGRESO COBRADO
  it('ingreso 50 de corte a María', () => {
    const result = parseDeterministic('ingreso 50 de corte a María');
    expect(result?.toolCall.tool).toBe('create_income');
    expect(result?.toolCall.args.status).toBe('paid');
  });

  it('cobré 75€ por consultoría', () => {
    const result = parseDeterministic('cobré 75€ por consultoría');
    expect(result?.toolCall.tool).toBe('create_income');
    expect(result?.toolCall.args.status).toBe('paid');
  });

  it('he recibido 200 de empresa García', () => {
    const result = parseDeterministic('he recibido 200 de empresa García');
    expect(result?.toolCall.tool).toBe('create_income');
    expect(result?.toolCall.args.client_name).toBe('empresa garcia');
  });

  it('facturado 500€ a Cliente X', () => {
    const result = parseDeterministic('facturado 500€ a Cliente X');
    expect(result?.toolCall.tool).toBe('create_income');
    expect(result?.toolCall.args.status).toBe('paid');
  });

  // VARIACIONES GASTO PAGADO
  it('gasto 45€ de suministros', () => {
    const result = parseDeterministic('gasto 45€ de suministros');
    expect(result?.toolCall.tool).toBe('create_expense');
    expect(result?.toolCall.args.status).toBe('paid');
  });

  it('pagué 150€ a proveedorX', () => {
    const result = parseDeterministic('pagué 150€ a proveedorX');
    expect(result?.toolCall.tool).toBe('create_expense');
    expect(result?.toolCall.args.status).toBe('paid');
  });

  it('compré 80€ en software', () => {
    const result = parseDeterministic('compré 80€ en software');
    expect(result?.toolCall.tool).toBe('create_expense');
    expect(result?.toolCall.args.status).toBe('paid');
  });

  it('he gastado 120€ de hotel', () => {
    const result = parseDeterministic('he gastado 120€ de hotel');
    expect(result?.toolCall.tool).toBe('create_expense');
    expect(result?.toolCall.args.status).toBe('paid');
  });

  // VARIACIONES INGRESO PENDIENTE
  it('me deben 500€ de proyecto', () => {
    const result = parseDeterministic('me deben 500€ de proyecto');
    expect(result?.toolCall.tool).toBe('create_income');
    expect(result?.toolCall.args.status).toBe('pending');
  });

  it('tengo que cobrar 300€ a Ana', () => {
    const result = parseDeterministic('tengo que cobrar 300€ a Ana');
    expect(result?.toolCall.tool).toBe('create_income');
    expect(result?.toolCall.args.status).toBe('pending');
    expect(result?.toolCall.args.client_name).toBe('ana');
  });

  it('me debe 150€ por servicios', () => {
    const result = parseDeterministic('me debe 150€ por servicios');
    expect(result?.toolCall.tool).toBe('create_income');
    expect(result?.toolCall.args.status).toBe('pending');
  });

  // VARIACIONES GASTO PENDIENTE
  it('tengo que pagar 200€ a telefónica', () => {
    const result = parseDeterministic('tengo que pagar 200€ a telefónica');
    expect(result?.toolCall.tool).toBe('create_expense');
    expect(result?.toolCall.args.status).toBe('pending');
    expect(result?.toolCall.args.vendor_name).toBe('telefonica');
  });

  it('debo pagar 50€ de internet', () => {
    const result = parseDeterministic('debo pagar 50€ de internet');
    expect(result?.toolCall.tool).toBe('create_expense');
    expect(result?.toolCall.args.status).toBe('pending');
  });

  // CASOS AMBIGUOS (DEBEN DEVOLVER NULL)
  it('me deben dinero pero no se cuanto', () => {
    const result = parseDeterministic('me deben dinero pero no se cuanto');
    expect(result).toBeNull(); // sin importe claro
  });

  it('cobré dinero ayer de María', () => {
    const result = parseDeterministic('cobré dinero ayer de María');
    expect(result).toBeNull(); // fecha relativa → nivel 1
  });

  it('he cobrado 100€ y también pagué 50€', () => {
    const result = parseDeterministic('he cobrado 100€ y también pagué 50€');
    expect(result).toBeNull(); // multi-acción → nivel 2
  });

  it('cuánto he cobrado en total', () => {
    const result = parseDeterministic('cuánto he cobrado en total');
    expect(result).toBeNull(); // consulta → nivel 1/3
  });

  it('cobré 100€ pero creo que eran 150€', () => {
    const result = parseDeterministic('cobré 100€ pero creo que eran 150€');
    expect(result).toBeNull(); // especulación → nivel 1
  });

  // FORMATOS NUMÉRICOS VARIADOS
  it('ingreso 1.234.567,89€', () => {
    const result = parseDeterministic('ingreso 1.234.567,89€');
    expect(result?.toolCall.tool).toBe('create_income');
    expect(result?.toolCall.args.amount).toBe(1234567.89);
  });

  it('pago 0,50 centavos', () => {
    const result = parseDeterministic('pago 0,50 centavos');
    expect(result?.toolCall.tool).toBe('create_expense');
    expect(result?.toolCall.args.amount).toBe(0.50);
  });
});

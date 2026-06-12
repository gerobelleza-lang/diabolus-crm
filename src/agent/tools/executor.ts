// EJECUTOR — el único lugar donde las tools tocan datos.
// Flujo: validar (Zod) → resolver referencias (client_name → client_id) →
// ejecutar contra el Repo → auditar. El modelo nunca llega aquí sin validación.

import { randomUUID } from 'node:crypto';
import type { PendingConfirmation, Repo, RouteLevel, ToolCall, ToolName } from '../types.js';
import { isWriteTool, validateToolCall } from './schemas.js';

export interface ExecOk { ok: true; result: Record<string, unknown>; summary: string }
export interface ExecErr { ok: false; errors: string[] }
export interface NeedsConfirm { ok: true; confirmRequired: true; confirmation: PendingConfirmation }
export interface NeedsClarification { ok: true; clarify: string; options?: Array<{ id: string; label: string }> }

export type ExecOutcome = ExecOk | ExecErr | NeedsConfirm | NeedsClarification;

const pending = new Map<string, PendingConfirmation>();

export function getPending(id: string): PendingConfirmation | undefined {
  return pending.get(id);
}

export function clearPending(id: string): void {
  pending.delete(id);
}

/**
 * Punto de entrada para toda tool call (del parser o del LLM).
 * Las escrituras devuelven confirmación pendiente; las lecturas ejecutan directo.
 */
export async function handleToolCall(repo: Repo, call: ToolCall, level: RouteLevel): Promise<ExecOutcome> {
  const validation = validateToolCall(call.tool, call.args);
  if (!validation.ok) {
    await repo.audit({ toolName: call.tool, payload: call.args, result: { errors: validation.errors }, confirmed: false, level });
    return { ok: false, errors: validation.errors };
  }
  const args = validation.data;

  // Resolver client_name → client_id (con desambiguación)
  if (typeof args.client_name === 'string' && !args.client_id) {
    const matches = await repo.findClients(args.client_name);
    if (matches.length === 1) {
      args.client_id = matches[0].id;
      delete args.client_name;
    } else if (matches.length > 1) {
      return {
        ok: true,
        clarify: `Hay ${matches.length} clientes que coinciden con "${args.client_name}". ¿Cuál?`,
        options: matches.map((m) => ({ id: m.id, label: m.name })),
      };
    }
    // 0 matches: se permite continuar — el ingreso puede registrarse sin cliente,
    // y la UI ofrecerá crear el cliente. Nunca se crea un cliente sin confirmación.
  }

  if (isWriteTool(call.tool)) {
    const confirmation: PendingConfirmation = {
      id: randomUUID(),
      toolCall: { tool: call.tool, args },
      preview: buildPreview(call.tool, args),
      createdAt: new Date().toISOString(),
    };
    pending.set(confirmation.id, confirmation);
    return { ok: true, confirmRequired: true, confirmation };
  }

  // Lecturas: ejecutar directo
  const result = await executeRead(repo, call.tool, args);
  await repo.audit({ toolName: call.tool, payload: args, result, confirmed: false, level });
  return { ok: true, result, summary: summarizeRead(call.tool, result) };
}

/** Ejecuta una escritura YA confirmada por el usuario. */
export async function executeConfirmed(repo: Repo, confirmationId: string, level: RouteLevel): Promise<ExecOutcome> {
  const conf = pending.get(confirmationId);
  if (!conf) return { ok: false, errors: ['Confirmación no encontrada o expirada'] };
  pending.delete(confirmationId);

  const { tool, args } = conf.toolCall;
  const result = await executeWrite(repo, tool, args);
  await repo.audit({ toolName: tool, payload: args, result, confirmed: true, level });
  return { ok: true, result, summary: buildPreview(tool, args) + ' ✔' };
}

/** Registra una cancelación (también se audita: sección 9 del SPEC). */
export async function cancelConfirmed(repo: Repo, confirmationId: string, level: RouteLevel): Promise<void> {
  const conf = pending.get(confirmationId);
  if (!conf) return;
  pending.delete(confirmationId);
  await repo.audit({
    toolName: conf.toolCall.tool,
    payload: conf.toolCall.args,
    result: { cancelled: true },
    confirmed: false,
    level,
  });
}

// ── Implementaciones ──

async function executeWrite(repo: Repo, tool: ToolName, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (tool) {
    case 'create_income':
    case 'create_expense': {
      const tx = await repo.createTransaction({
        type: tool === 'create_income' ? 'income' : 'expense',
        amount: args.amount as number,
        concept: args.concept as string,
        clientId: args.client_id as string | undefined,
        serviceId: args.service_id as string | undefined,
        date: (args.date as string) || new Date().toISOString().slice(0, 10),
      });
      return { transaction: tx };
    }
    case 'create_invoice': {
      const invoice = await repo.createInvoice({
        clientId: args.client_id as string,
        lines: args.lines as Array<{ concept: string; amount: number; serviceId?: string }>,
        date: (args.date as string) || new Date().toISOString().slice(0, 10),
      });
      return { invoice };
    }
    case 'create_client': {
      const client = await repo.createClient({
        name: args.name as string,
        phone: args.phone as string | undefined,
        email: args.email as string | undefined,
      });
      return { client };
    }
    case 'create_reminder': {
      const reminder = await repo.createReminder({
        dueAt: args.due_at as string,
        message: args.message as string,
      });
      return { reminder };
    }
    case 'draft_message': {
      // v39: borrador plantilla; v40: lo redacta el modelo pequeño
      return { draft: `Borrador (${args.purpose}) para cliente ${args.client_id}: [pendiente de redacción IA en v40]` };
    }
    case 'send_to_gestoria': {
      // v39: stub que genera el export; el envío real es v41 (portal gestoría)
      const balance = await repo.getBalance();
      return { export: { period: args.period, format: args.format, ...balance } };
    }
    default:
      throw new Error(`Tool de escritura no implementada: ${tool}`);
  }
}

async function executeRead(repo: Repo, tool: ToolName, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (tool) {
    case 'find_client':
      return { clients: await repo.findClients(args.query as string) };
    case 'find_service':
      return { services: await repo.findServices(args.query as string) };
    case 'get_balance': {
      const period = args.from && args.to ? { from: args.from as string, to: args.to as string } : undefined;
      return await repo.getBalance(period);
    }
    case 'get_pending_invoices':
      return { invoices: await repo.getPendingInvoices() };
    case 'get_date':
      return { date: resolveRelativeDate(args.relative_expr as string) };
    default:
      throw new Error(`Tool de lectura no implementada: ${tool}`);
  }
}

function buildPreview(tool: ToolName, args: Record<string, unknown>): string {
  switch (tool) {
    case 'create_income': return `Ingreso de ${args.amount}€ — ${args.concept}${args.client_id ? ' (cliente vinculado)' : ''}`;
    case 'create_expense': return `Gasto de ${args.amount}€ — ${args.concept}`;
    case 'create_invoice': return `Factura para cliente ${args.client_id} con ${(args.lines as unknown[]).length} línea(s)`;
    case 'create_client': return `Nuevo cliente: ${args.name}`;
    case 'create_reminder': return `Recordatorio: "${args.message}" para ${args.due_at}`;
    case 'draft_message': return `Borrador de mensaje (${args.purpose}) para cliente ${args.client_id}`;
    case 'send_to_gestoria': return `Export ${args.format} del periodo ${args.period} para la gestoría`;
    default: return `${tool}`;
  }
}

function summarizeRead(tool: ToolName, result: Record<string, unknown>): string {
  switch (tool) {
    case 'get_balance': return `Ingresos ${result.income}€ · Gastos ${result.expense}€ · Saldo ${result.balance}€`;
    case 'find_client': return `${(result.clients as unknown[]).length} cliente(s) encontrado(s)`;
    case 'find_service': return `${(result.services as unknown[]).length} servicio(s) encontrado(s)`;
    case 'get_pending_invoices': return `${(result.invoices as unknown[]).length} factura(s) pendiente(s)`;
    case 'get_date': return `Fecha: ${result.date}`;
    default: return 'OK';
  }
}

/** Fechas relativas básicas en servidor; las complejas las razona el LLM con esta tool. */
export function resolveRelativeDate(expr: string, base = new Date()): string {
  const text = expr.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const d = new Date(base);
  if (text === 'hoy') { /* hoy */ }
  else if (text === 'ayer') d.setDate(d.getDate() - 1);
  else if (text === 'anteayer' || text === 'antes de ayer') d.setDate(d.getDate() - 2);
  else if (text === 'manana') d.setDate(d.getDate() + 1);
  else {
    const days = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    const idx = days.findIndex((day) => text.includes(day));
    if (idx >= 0) {
      const isPast = text.includes('pasado') || !text.includes('que viene');
      let diff = d.getDay() - idx;
      if (isPast) { if (diff <= 0) diff += 7; d.setDate(d.getDate() - diff); }
      else { let fwd = idx - d.getDay(); if (fwd <= 0) fwd += 7; d.setDate(d.getDate() + fwd); }
    }
  }
  return d.toISOString().slice(0, 10);
}

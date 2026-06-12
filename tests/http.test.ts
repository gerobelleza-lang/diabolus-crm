// Test end-to-end de la capa HTTP — equivale a las 5 frases de aceptación
// ejecutadas contra el servidor real (app.request, sin red).

import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';

async function agent(message: string) {
  const res = await app.request('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  return { status: res.status, body: await res.json() };
}

async function confirm(confirmationId: string, approved: boolean) {
  const res = await app.request('/api/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmationId, approved }),
  });
  return { status: res.status, body: await res.json() };
}

describe('HTTP end-to-end', () => {
  it('flujo completo: frase → preview → confirmar → auditado', async () => {
    const r1 = await agent('ingreso 50 corte Maria');
    expect(r1.status).toBe(200);
    expect(r1.body.level).toBe(0);
    expect(r1.body.cost).toBe(0);
    expect(r1.body.outcome.confirmRequired).toBe(true);
    expect(r1.body.outcome.confirmation.preview).toContain('50');

    const r2 = await confirm(r1.body.outcome.confirmation.id, true);
    expect(r2.status).toBe(200);
    expect(r2.body.outcome.ok).toBe(true);

    const audit = await app.request('/api/audit');
    const log = (await audit.json()) as { log: Array<{ confirmed: boolean }> };
    expect(log.log.some((e) => e.confirmed)).toBe(true);
  });

  it('cancelar una confirmación no escribe nada', async () => {
    const r1 = await agent('gasto 99 prueba cancelacion');
    const id = r1.body.outcome.confirmation.id;
    const r2 = await confirm(id, false);
    expect(r2.body.cancelled).toBe(true);
    // confirmar de nuevo el mismo id debe fallar (ya consumido)
    const r3 = await confirm(id, true);
    expect(r3.body.outcome.ok).toBe(false);
  });

  it('mensaje vacío → 400', async () => {
    const r = await agent('');
    expect(r.status).toBe(400);
  });

  it('sin API key, nivel 1 responde aviso claro (no crash)', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const r = await agent('apúntame el corte de la clienta de las cinco');
    expect(r.status).toBe(200);
    expect(r.body.level).toBe(1);
    expect(r.body.text).toContain('OPENROUTER_API_KEY');
  });

  it('la UI se sirve en /', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Diabolus');
  });
});

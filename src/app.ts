// Diabolus v40 — servidor con Supabase + RLS
// POST /api/agent    { message }                → respuesta del agente
// POST /api/confirm  { confirmationId, approved } → ejecuta o cancela
// GET  /api/audit                               → log de auditoría
// GET  /api/costs                               → estadísticas de coste
// GET  /                                        → UI mínima de chat

import { Hono } from 'hono';
import { route, LEVEL_COST } from './agent/router.js';
import { buildSystemPrompt, callLLM, modelForLevel, type LLMMessage } from './agent/llm.js';
import {
  handleToolCall, executeConfirmed, cancelConfirmed,
} from './agent/tools/executor.js';
import { createSupabaseRepo } from './db/supabaseRepo.js';
import { authMiddleware, getAuthContext } from './middleware/auth.js';
import { logCost, getCostSummary, estimateCost } from './agent/costLogger.js';

const app = new Hono();

const BUSINESS = {
  name: 'Mi negocio',
  profile: 'Peluquería. Servicios: corte 15€, tinte 45€, manicura 25€.',
};

// Ruta pública (sin auth)
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html><html><head><title>Diabolus v40</title><style>body{font-family:system-ui;background:#0f0f0f;color:#e0e0e0;padding:20px}.chat{height:400px;border:1px solid #333;padding:15px;overflow-y:auto;background:#1a1a1a;border-radius:8px;margin-bottom:15px}input{width:80%;padding:10px;background:#222;color:#e0e0e0;border:1px solid #444;border-radius:4px}button{padding:10px 20px;background:#ff4500;color:white;border:none;border-radius:4px;cursor:pointer;margin-left:5px}</style></head><body><h1>⚡ Diabolus v40 — Supabase RLS</h1><p>⚠️ Requiere: Bearer JWT + ?salon_id=UUID</p><div class="chat" id="chat"></div><input type="text" id="input" placeholder="Ej: he cobrado 450€ de María"/><button onclick="send()">Enviar</button><div id="stats" style="margin-top:20px;font-size:12px"></div><script>async function send(){const msg=document.getElementById('input').value;if(!msg)return;document.getElementById('input').value='';const res=await fetch('/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});const data=await res.json();const txt=data.text||'OK';document.getElementById('chat').innerHTML+='<p><b>Usuario:</b>'+msg+'</p><p><b>Agente:</b>'+txt+' [Nivel '+data.level+', €'+data.cost?.toFixed(4)+']</p>';const stats=await fetch('/api/costs').then(r=>r.json());document.getElementById('stats').innerHTML='<p>Total: '+stats.totalQueries+' | Coste medio: €'+stats.avgCostPerQuery?.toFixed(4)+'</p>';}document.getElementById('input').addEventListener('keypress',(e)=>{if(e.key==='Enter')send()});</script></body></html>`);
});

// Auth middleware para /api/*
app.use('/api/*', authMiddleware);

app.post('/api/agent', async (c) => {
  const { userJwt, salonId } = getAuthContext(c);
  const body = await c.req.json<{ message?: string }>().catch(() => ({} as { message?: string }));
  const message = (body.message || '').trim();
  if (!message) return c.json({ error: 'Mensaje vacío' }, 400);
  if (message.length > 1000) return c.json({ error: 'Mensaje demasiado largo' }, 400);

  // Crear repo con contexto de usuario
  const repo = createSupabaseRepo({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    userJwt,
    salonId,
  });

  const decision = route(message);
  const timestamp = new Date().toISOString();

  // NIVEL 0 — directo, coste cero
  if (decision.level === 0 && decision.toolCall) {
    const outcome = await handleToolCall(repo, decision.toolCall, 0);
    logCost({
      timestamp,
      level: 0,
      model: 'deterministic',
      estimatedCostEur: 0,
      query: message,
      success: true,
    });
    return c.json({
      level: 0,
      cost: 0,
      reason: decision.reason,
      outcome,
    });
  }

  // NIVELES 1-3 — LLM
  const model = modelForLevel(decision.level);
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        businessName: BUSINESS.name,
        businessProfile: BUSINESS.profile,
        today: new Date().toISOString().slice(0, 10),
      }),
    },
    { role: 'user', content: message },
  ];

  try {
    const turn = await callLLM(decision.level, messages);
    const outcomes = [];
    for (const tc of turn.toolCalls) {
      outcomes.push(await handleToolCall(repo, { tool: tc.tool, args: tc.args }, decision.level));
    }

    const estimatedCost = estimateCost(model, 150, 100);
    logCost({
      timestamp,
      level: decision.level,
      model,
      estimatedCostEur: estimatedCost,
      query: message,
      success: true,
    });

    return c.json({
      level: decision.level,
      cost: estimatedCost,
      reason: decision.reason,
      outcomes,
    });
  } catch (error) {
    logCost({
      timestamp,
      level: decision.level,
      model,
      estimatedCostEur: 0,
      query: message,
      success: false,
    });
    return c.json({
      error: `Error del agente: ${error instanceof Error ? error.message : String(error)}`,
    }, 500);
  }
});

app.post('/api/confirm', async (c) => {
  const body = await c.req.json<{ confirmationId?: string; approved?: boolean }>();
  const { confirmationId, approved } = body;

  if (!confirmationId) return c.json({ error: 'confirmationId requerido' }, 400);
  if (typeof approved !== 'boolean') return c.json({ error: 'approved debe ser boolean' }, 400);

  if (approved) {
    const outcome = await executeConfirmed(confirmationId);
    return c.json({ status: 'executed', outcome });
  }
  const outcome = await cancelConfirmed(confirmationId);
  return c.json({ status: 'cancelled', outcome });
});

app.get('/api/audit', async (c) => {
  const { userJwt, salonId } = getAuthContext(c);

  const repo = createSupabaseRepo({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    userJwt,
    salonId,
  });
  const log = await repo.getAuditLog();
  return c.json(log);
});

app.get('/api/costs', (c) => {
  const summary = getCostSummary();
  return c.json(summary);
});

export { app };

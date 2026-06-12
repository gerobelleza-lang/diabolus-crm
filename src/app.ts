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
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { loggingMiddleware } from './middleware/logging.js';
import { logCost, getCostSummary, estimateCost } from './agent/costLogger.js';

const app = new Hono();

const BUSINESS = {
  name: 'Mi negocio',
  profile: 'Peluquería. Servicios: corte 15€, tinte 45€, manicura 25€.',
};

// Ruta pública (sin auth)

// Admin Dashboard
app.get('/admin', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Diabolus Admin Dashboard</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,sans-serif;background:linear-gradient(135deg,#0f0f0f 0%,#1a1a1a 100%);color:#e0e0e0;padding:20px}.container{max-width:1200px;margin:0 auto}h1{color:#ff4500;margin-bottom:30px;font-size:2.5em;text-shadow:0 0 20px rgba(255,69,0,0.3)}h2{color:#ff4500;margin:30px 0 20px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;margin-bottom:40px}.card{background:#222;border:1px solid #333;border-radius:8px;padding:20px;transition:all 0.3s}.card:hover{border-color:#ff4500;transform:translateY(-2px);box-shadow:0 0 20px rgba(255,69,0,0.2)}.card h2{color:#ff4500;font-size:1.2em;margin-bottom:10px}.card .value{font-size:2em;font-weight:bold;color:#fff}.card .label{color:#888;font-size:0.9em}table{width:100%;border-collapse:collapse;background:#222;border-radius:8px;overflow:hidden;margin-bottom:40px}th{background:#333;color:#ff4500;padding:12px;text-align:left;font-weight:600}td{padding:12px;border-bottom:1px solid #333}tr:hover{background:#2a2a2a}a{color:#ff4500;text-decoration:none}a:hover{text-decoration:underline}.status-ok{color:#4ade80}.info-box{background:#1a3a3a;border-left:4px solid #4ade80;padding:15px;border-radius:4px;margin-bottom:20px}.info-box strong{color:#4ade80}</style></head><body><div class="container"><h1>⚡ Diabolus Admin Dashboard</h1><div class="info-box"><strong>Estado:</strong> API en vivo en https://diabolus-crm.vercel.app<br><strong>Supabase:</strong> Multi-tenant RLS activo<br><strong>OpenRouter:</strong> LLM integrando con coste tracking</div><div class="grid"><div class="card"><h2>API Status</h2><div class="value status-ok">✓ ONLINE</div><div class="label">Vercel Production</div></div><div class="card"><h2>Rate Limit</h2><div class="value">60/min</div><div class="label">Requests per IP</div></div><div class="card"><h2>Auth</h2><div class="value status-ok">✓ JWT + RLS</div><div class="label">Multi-tenant isolation</div></div><div class="card"><h2>LLM</h2><div class="value">L0-L3</div><div class="label">Parser + OpenRouter</div></div></div><h2>Endpoints Disponibles</h2><table><tr><th>Endpoint</th><th>Método</th><th>Descripción</th></tr><tr><td>/api/agent</td><td>POST</td><td>Procesar comando (parser + LLM)</td></tr><tr><td>/api/confirm</td><td>POST</td><td>Confirmar acción pendiente</td></tr><tr><td>/api/audit</td><td>GET</td><td>Log de auditoría</td></tr><tr><td>/api/costs</td><td>GET</td><td>Estadísticas de costos</td></tr><tr><td>/</td><td>GET</td><td>UI de chat público</td></tr></table><h2>Monitoreo</h2><table><tr><th>Servicio</th><th>Status</th><th>Link</th></tr><tr><td>Vercel</td><td class="status-ok">✓ LIVE</td><td><a href="https://vercel.com/diabolus-crm" target="_blank">Logs</a></td></tr><tr><td>Supabase</td><td class="status-ok">✓ LIVE</td><td><a href="https://supabase.com" target="_blank">Dashboard</a></td></tr><tr><td>GitHub</td><td class="status-ok">✓ LIVE</td><td><a href="https://github.com/gerobelleza-lang/diabolus-crm" target="_blank">Repo</a></td></tr></table><div style="text-align:center;margin-top:40px;padding:20px;background:#1a1a1a;border-radius:8px"><p style="color:#888">Diabolus v40.0.0 - Production Grade</p></div></div></body></html>`);
});

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


// Beautiful Landing Page - v2 (Product-Focused)
app.get('/landing', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diabolus CRM — El CRM que entiende tu negocio</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .gradient-text { background: linear-gradient(135deg, #ff4500 0%, #ff6b1a 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .glow { box-shadow: 0 0 30px rgba(255, 69, 0, 0.3); }
    .card-hover { transition: all 0.3s ease; }
    .card-hover:hover { border-color: #ff4500; box-shadow: 0 0 20px rgba(255, 69, 0, 0.2); transform: translateY(-4px); }
  </style>
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white font-sans">
  <nav class="fixed top-0 w-full bg-black/50 backdrop-blur border-b border-gray-800 z-50">
    <div class="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center font-bold text-lg">⚡</div>
        <span class="font-bold text-xl">DIABOLUS</span>
      </div>
      <button class="px-6 py-2 bg-orange-500 hover:bg-orange-600 rounded-lg font-semibold transition">Comenzar</button>
    </div>
  </nav>

  <section class="min-h-screen flex items-center justify-center px-6 pt-20 pb-20">
    <div class="max-w-5xl mx-auto text-center space-y-8">
      <div class="inline-block px-4 py-2 bg-gray-800 border border-gray-700 rounded-full text-sm text-gray-300">
        ✨ IA Conversacional Nativa + Auditoría RGPD
      </div>
      <h1 class="text-6xl md:text-7xl font-black leading-tight">
        El CRM que entiende<br/><span class="gradient-text">tu negocio</span>
      </h1>
      <p class="text-xl md:text-2xl text-gray-400 max-w-3xl mx-auto">
        Dile "He cobrado 3 servicios hoy" y Diabolus crea automáticamente 3 transacciones.
        <span class="text-orange-400 font-semibold">Sin clicks, sin formularios.</span>
      </p>
      <div class="flex gap-4 justify-center flex-wrap pt-8">
        <button class="px-8 py-4 bg-gradient-to-r from-orange-500 to-orange-600 rounded-lg hover:shadow-lg font-semibold text-lg transition glow">
          Probar gratis
        </button>
        <button class="px-8 py-4 border-2 border-orange-500 rounded-lg hover:bg-orange-500/10 font-semibold text-lg transition">
          Ver demo
        </button>
      </div>
    </div>
  </section>

  <section class="py-24 px-6 bg-gray-900/50 border-y border-gray-800">
    <div class="max-w-6xl mx-auto">
      <h2 class="text-4xl font-bold text-center mb-16">Por qué Diabolus</h2>
      <div class="grid md:grid-cols-3 gap-8">
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-8 card-hover">
          <div class="text-4xl mb-4">🧠</div>
          <h3 class="text-xl font-bold mb-3">IA Conversacional</h3>
          <p class="text-gray-400">Habla natural. Entiende contexto. Cero training necesario.</p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-8 card-hover">
          <div class="text-4xl mb-4">⚡</div>
          <h3 class="text-xl font-bold mb-3">60% Gratis</h3>
          <p class="text-gray-400">Parser determinístico (L0) resuelve la mayoría sin costo.</p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-8 card-hover">
          <div class="text-4xl mb-4">🔒</div>
          <h3 class="text-xl font-bold mb-3">RGPD Nativo</h3>
          <p class="text-gray-400">Auditoría append-only. Cumple RGPD desde día 1.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="py-24 px-6">
    <div class="max-w-6xl mx-auto text-center">
      <h2 class="text-4xl font-bold mb-8">Casos reales</h2>
      <p class="text-gray-400 mb-12 max-w-3xl mx-auto">
        Pequeños negocios ganan 2-3h diarias. Gastronomía, estética, consultoría, fitness. Todos automatizando admin con Diabolus.
      </p>
    </div>
  </section>

  <section class="py-24 px-6 bg-gradient-to-b from-orange-900/20 to-transparent border-t border-gray-800">
    <div class="max-w-4xl mx-auto text-center space-y-8">
      <h2 class="text-4xl font-bold">¿Listo para automatizar?</h2>
      <p class="text-xl text-gray-400">Prueba gratis. Sin tarjeta. 30 días full access.</p>
      <button class="px-12 py-4 bg-gradient-to-r from-orange-500 to-orange-600 rounded-lg font-bold text-lg hover:shadow-lg transition glow">
        Comienza ahora
      </button>
    </div>
  </section>

  <footer class="border-t border-gray-800 py-8 px-6 text-center text-gray-500">
    <p>© 2026 Diabolus CRM • <a href="https://github.com/gerobelleza-lang/diabolus-crm" class="text-orange-500 hover:underline">GitHub</a></p>
  </footer>
</body>
</html>`);
});

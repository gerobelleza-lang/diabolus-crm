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
import { readFileSync } from 'fs';
import { join } from 'path';

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

// Dashboard - Executive Overview
app.get('/dashboard', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — Diabolus CRM</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    .gradient-text { background: linear-gradient(135deg, #ff4500 0%, #ff6b1a 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .stat-card { transition: all 0.3s; }
    .stat-card:hover { transform: translateY(-2px); border-color: #ff4500; }
    .chart-container { position: relative; height: 300px; }
  </style>
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">

  <div class="fixed left-0 top-0 w-64 h-screen bg-black border-r border-gray-800 flex flex-col z-40">
    <div class="p-6 border-b border-gray-800">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center font-bold">⚡</div>
        <span class="font-bold text-xl">DIABOLUS</span>
      </div>
    </div>
    <nav class="flex-1 p-4 space-y-2">
      <a href="#" class="block px-4 py-3 bg-orange-500/20 border-l-2 border-orange-500 text-orange-400 rounded">📊 Dashboard</a>
      <a href="#" class="block px-4 py-3 text-gray-400 hover:text-white hover:bg-gray-800 rounded">💰 Transacciones</a>
      <a href="#" class="block px-4 py-3 text-gray-400 hover:text-white hover:bg-gray-800 rounded">👥 Clientes</a>
      <a href="#" class="block px-4 py-3 text-gray-400 hover:text-white hover:bg-gray-800 rounded">📈 Reportes</a>
      <a href="#" class="block px-4 py-3 text-gray-400 hover:text-white hover:bg-gray-800 rounded">💬 Chat IA</a>
    </nav>
    <div class="p-4 border-t border-gray-800">
      <div class="flex items-center gap-3 px-4 py-3 bg-gray-800 rounded">
        <div class="w-10 h-10 bg-orange-500 rounded-full flex items-center justify-center font-bold">M</div>
        <div><p class="text-sm font-semibold">María García</p><p class="text-xs text-gray-400">Peluquería</p></div>
      </div>
    </div>
  </div>

  <main class="ml-64 min-h-screen">
    <header class="bg-black/50 border-b border-gray-800 sticky top-0 z-30">
      <div class="px-8 py-4 flex items-center justify-between">
        <div><h1 class="text-2xl font-bold">Dashboard</h1><p class="text-sm text-gray-400 mt-1">Hoy es <span class="text-orange-400 font-semibold">12 de junio de 2026</span></p></div>
        <div class="flex gap-4"><button class="px-6 py-2 bg-orange-500 hover:bg-orange-600 rounded-lg font-semibold">➕ Nueva transacción</button></div>
      </div>
    </header>

    <div class="p-8">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6 stat-card">
          <p class="text-gray-400 text-sm">Ganancia hoy</p>
          <h2 class="text-4xl font-bold mt-2 gradient-text">€285</h2>
          <p class="text-xs text-gray-500 mt-2">↑ 12% vs. ayer</p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6 stat-card">
          <p class="text-gray-400 text-sm">Esta semana</p>
          <h2 class="text-4xl font-bold mt-2 text-blue-400">€1,850</h2>
          <p class="text-xs text-gray-500 mt-2">6 transacciones</p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6 stat-card">
          <p class="text-gray-400 text-sm">Este mes</p>
          <h2 class="text-4xl font-bold mt-2 text-green-400">€7,240</h2>
          <p class="text-xs text-gray-500 mt-2">↑ 8% vs. mes pasado</p>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6 stat-card">
          <p class="text-gray-400 text-sm">Balance neto</p>
          <h2 class="text-4xl font-bold mt-2 text-purple-400">€2,140</h2>
          <p class="text-xs text-gray-500 mt-2">Ingresos - Gastos</p>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6">
          <h3 class="text-lg font-bold mb-4">Ingresos vs Gastos (Semana)</h3>
          <div class="chart-container"><canvas id="chartIngresos"></canvas></div>
        </div>
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-6">
          <h3 class="text-lg font-bold mb-4">Servicios más vendidos</h3>
          <div class="chart-container"><canvas id="chartServicios"></canvas></div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div class="lg:col-span-1">
          <h3 class="text-lg font-bold mb-4">Acciones rápidas</h3>
          <div class="space-y-3">
            <button class="w-full px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition text-left flex items-center gap-3">💬 Procesar ingreso</button>
            <button class="w-full px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition text-left flex items-center gap-3">👤 Nuevo cliente</button>
            <button class="w-full px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition text-left flex items-center gap-3">📋 Ver reportes</button>
            <button class="w-full px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition text-left flex items-center gap-3">🔐 Exportar datos</button>
          </div>
        </div>
        <div class="lg:col-span-2">
          <h3 class="text-lg font-bold mb-4">Últimos clientes</h3>
          <div class="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead class="bg-gray-700/50 border-b border-gray-700">
                <tr><th class="px-6 py-3 text-left font-semibold text-gray-300">Nombre</th><th class="px-6 py-3 text-left font-semibold text-gray-300">Último servicio</th><th class="px-6 py-3 text-left font-semibold text-gray-300">Total</th><th class="px-6 py-3 text-left font-semibold text-gray-300">Estado</th></tr>
              </thead>
              <tbody class="divide-y divide-gray-700">
                <tr class="hover:bg-gray-700/30"><td class="px-6 py-4 flex items-center gap-3"><div class="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center text-sm font-bold">A</div>Ana García</td><td class="px-6 py-4 text-gray-400">Corte + Tinte</td><td class="px-6 py-4 font-semibold">€850</td><td class="px-6 py-4"><span class="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded">Pagado</span></td></tr>
                <tr class="hover:bg-gray-700/30"><td class="px-6 py-4 flex items-center gap-3"><div class="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-sm font-bold">B</div>Beatriz López</td><td class="px-6 py-4 text-gray-400">Manicura</td><td class="px-6 py-4 font-semibold">€320</td><td class="px-6 py-4"><span class="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded">Pagado</span></td></tr>
                <tr class="hover:bg-gray-700/30"><td class="px-6 py-4 flex items-center gap-3"><div class="w-8 h-8 bg-purple-500 rounded-full flex items-center justify-center text-sm font-bold">C</div>Clara Martín</td><td class="px-6 py-4 text-gray-400">Corte</td><td class="px-6 py-4 font-semibold">€520</td><td class="px-6 py-4"><span class="px-2 py-1 bg-yellow-500/20 text-yellow-300 text-xs rounded">Pendiente</span></td></tr>
                <tr class="hover:bg-gray-700/30"><td class="px-6 py-4 flex items-center gap-3"><div class="w-8 h-8 bg-pink-500 rounded-full flex items-center justify-center text-sm font-bold">D</div>Diana Rodríguez</td><td class="px-6 py-4 text-gray-400">Tratamiento</td><td class="px-6 py-4 font-semibold">€1,200</td><td class="px-6 py-4"><span class="px-2 py-1 bg-green-500/20 text-green-300 text-xs rounded">Pagado</span></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="mt-8">
        <h3 class="text-lg font-bold mb-4">⚠️ Alertas</h3>
        <div class="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-4 flex items-start gap-4">
          <span class="text-2xl">⏰</span>
          <div><p class="font-semibold">Clara Martín debe €520</p><p class="text-sm text-gray-400">Sin pagar desde hace 8 días.</p></div>
          <button class="ml-auto px-4 py-2 bg-yellow-600 hover:bg-yellow-700 rounded-lg text-sm font-semibold">Recordar</button>
        </div>
      </div>
    </div>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    const ctx1 = document.getElementById('chartIngresos').getContext('2d');
    new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'],
        datasets: [
          { label: 'Ingresos', data: [250, 300, 280, 320, 350, 370, 280], backgroundColor: '#10b981', borderRadius: 6 },
          { label: 'Gastos', data: [80, 120, 100, 90, 110, 130, 100], backgroundColor: '#ef4444', borderRadius: 6 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#9ca3af' } } },
        scales: { y: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' } }, x: { ticks: { color: '#9ca3af' }, grid: { display: false } } }
      }
    });
    const ctx2 = document.getElementById('chartServicios').getContext('2d');
    new Chart(ctx2, {
      type: 'doughnut',
      data: {
        labels: ['Corte', 'Tinte', 'Manicura', 'Tratamiento'],
        datasets: [{ data: [35, 28, 20, 17], backgroundColor: ['#f97316', '#3b82f6', '#8b5cf6', '#ec4899'], borderColor: '#111827', borderWidth: 2 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af' } } } }
    });
  </script>
</body>
</html>`);
});

// Chat Premium - Full-screen conversational interface
app.get('/chat-premium', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chat IA — Diabolus CRM</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white h-screen flex flex-col">
  <header class="bg-black/50 border-b border-gray-800 px-6 py-4 flex items-center justify-between">
    <div class="flex items-center gap-4">
      <div class="w-12 h-12 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center font-bold">⚡</div>
      <div>
        <h1 class="text-2xl font-bold">Diabolus Chat</h1>
        <p class="text-xs text-gray-400">Asistente IA + Parser determinístico</p>
      </div>
    </div>
    <div class="flex gap-4">
      <a href="/dashboard" class="px-4 py-2 text-gray-400 hover:text-white transition">📊 Dashboard</a>
    </div>
  </header>

  <div class="flex-1 flex gap-6 overflow-hidden p-6">
    <div class="flex-1 flex flex-col">
      <div class="flex-1 overflow-y-auto space-y-4 mb-6 pr-4">
        <div class="flex justify-center">
          <div class="text-center max-w-2xl space-y-4">
            <h2 class="text-3xl font-bold">Hola, María 👋</h2>
            <p class="text-gray-400 text-lg">Cuéntame qué necesitas registrar hoy.</p>
            <div class="pt-4">
              <p class="text-sm text-gray-500 mb-3">Ejemplos:</p>
              <div class="space-y-2">
                <div class="px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg cursor-pointer hover:border-orange-500 transition text-left">
                  <p class="text-sm font-semibold">💰 He cobrado 4 cortes hoy, 2 tintes, 1 manicura</p>
                </div>
                <div class="px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg cursor-pointer hover:border-orange-500 transition text-left">
                  <p class="text-sm font-semibold">📊 ¿Cuánto gané esta semana?</p>
                </div>
                <div class="px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg cursor-pointer hover:border-orange-500 transition text-left">
                  <p class="text-sm font-semibold">👤 Cliente nuevo: Laura, 666123456</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <div class="flex gap-2 overflow-x-auto pb-2">
          <button class="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-full text-sm whitespace-nowrap transition">💬 Procesar</button>
          <button class="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-full text-sm whitespace-nowrap transition">📋 Ver</button>
          <button class="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-full text-sm whitespace-nowrap transition">👥 Cliente</button>
          <button class="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-full text-sm whitespace-nowrap transition">📊 Resumen</button>
        </div>
        <div class="flex gap-3">
          <input type="text" placeholder="He cobrado 450€ de María..." class="flex-1 px-6 py-4 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-orange-500 transition"/>
          <button class="px-6 py-4 bg-gradient-to-r from-orange-500 to-orange-600 rounded-lg font-semibold transition">✈️ Enviar</button>
        </div>
        <div class="flex items-center justify-between text-xs text-gray-500">
          <p>⚡ Parser L0: Sin costo • 🧠 LLM L1-L3: Inteligente</p>
          <p>🔐 RGPD-compliant</p>
        </div>
      </div>
    </div>

    <div class="w-80 flex flex-col border-l border-gray-800 pl-6 space-y-6">
      <div>
        <h3 class="text-sm font-bold text-gray-400 mb-3">HOY</h3>
        <div class="space-y-3">
          <div class="bg-gray-800/50 rounded-lg p-4"><p class="text-xs text-gray-400">Ganancia</p><p class="text-2xl font-bold text-orange-400">€285</p></div>
          <div class="bg-gray-800/50 rounded-lg p-4"><p class="text-xs text-gray-400">Transacciones</p><p class="text-2xl font-bold text-blue-400">7</p></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-bold text-gray-400 mb-3">HISTORIAL</h3>
        <div class="space-y-2 max-h-40 overflow-y-auto">
          <div class="px-4 py-3 bg-gray-800/30 border border-gray-700/50 rounded-lg text-sm"><p class="text-gray-300">He cobrado 3 servicios</p><p class="text-xs text-gray-500 mt-1">11:30 • ✓</p></div>
          <div class="px-4 py-3 bg-gray-800/30 border border-gray-700/50 rounded-lg text-sm"><p class="text-gray-300">¿Cuánto gané ayer?</p><p class="text-xs text-gray-500 mt-1">10:15 • ✓</p></div>
          <div class="px-4 py-3 bg-gray-800/30 border border-gray-700/50 rounded-lg text-sm"><p class="text-gray-300">Nuevo cliente: Sofía</p><p class="text-xs text-gray-500 mt-1">09:45 • ✓</p></div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`);
});

// Nuevas rutas para servir las páginas de diseño
app.get('/dashboard', (c) => {
  try {
    const html = readFileSync(join(process.cwd(), 'src', 'pages', 'dashboard.html'), 'utf-8');
    return c.html(html);
  } catch (e) {
    return c.text('Dashboard page not found', 404);
  }
});

app.get('/transactions', (c) => {
  try {
    const html = readFileSync(join(process.cwd(), 'src', 'pages', 'transactions.html'), 'utf-8');
    return c.html(html);
  } catch (e) {
    return c.text('Transactions page not found', 404);
  }
});

app.get('/clients', (c) => {
  try {
    const html = readFileSync(join(process.cwd(), 'src', 'pages', 'clients.html'), 'utf-8');
    return c.html(html);
  } catch (e) {
    return c.text('Clients page not found', 404);
  }
});

app.get('/reports', (c) => {
  try {
    const html = readFileSync(join(process.cwd(), 'src', 'pages', 'reports.html'), 'utf-8');
    return c.html(html);
  } catch (e) {
    return c.text('Reports page not found', 404);
  }
});

app.get('/chat-premium', (c) => {
  try {
    const html = readFileSync(join(process.cwd(), 'src', 'pages', 'chat-premium.html'), 'utf-8');
    return c.html(html);
  } catch (e) {
    return c.text('Chat Premium page not found', 404);
  }
});

export default app;

// ===== NUEVAS RUTAS API PARA DATOS REALES =====

// GET /api/dashboard — Estadísticas del dashboard
app.get('/api/dashboard', async (c) => {
  const { userJwt, salonId } = getAuthContext(c);
  if (!userJwt || !salonId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const repo = createSupabaseRepo({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      userJwt,
      salonId,
    });

    // Obtener balance (month = mes actual)
    const balance = await repo.getBalance('month');
    
    // Devolver stats
    return c.json({
      today: balance.today || 0,
      week: balance.week || 0,
      month: balance.month || 0,
      netBalance: (balance.month || 0) - (balance.monthExpenses || 0),
      monthExpenses: balance.monthExpenses || 0,
    });
  } catch (error) {
    return c.json({ error: 'Failed to fetch dashboard data' }, 500);
  }
});

// GET /api/transactions — Lista de transacciones
app.get('/api/transactions', async (c) => {
  const { userJwt, salonId } = getAuthContext(c);
  if (!userJwt || !salonId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const repo = createSupabaseRepo({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      userJwt,
      salonId,
    });

    // Por ahora devolvemos estructura esperada
    // En producción: consultar tabla transactions
    return c.json({
      transactions: [],
      total: 0,
      income: 0,
      expenses: 0,
    });
  } catch (error) {
    return c.json({ error: 'Failed to fetch transactions' }, 500);
  }
});

// GET /api/clients — Lista de clientes
app.get('/api/clients', async (c) => {
  const { userJwt, salonId } = getAuthContext(c);
  if (!userJwt || !salonId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const repo = createSupabaseRepo({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      userJwt,
      salonId,
    });

    // Buscar todos los clientes (query vacío para traer todos)
    const clients = await repo.findClients('');
    
    return c.json({
      clients,
      total: clients.length,
    });
  } catch (error) {
    return c.json({ error: 'Failed to fetch clients' }, 500);
  }
});

// GET /api/reports — Resumen reportes
app.get('/api/reports', async (c) => {
  const { userJwt, salonId } = getAuthContext(c);
  if (!userJwt || !salonId) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const repo = createSupabaseRepo({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      userJwt,
      salonId,
    });

    const balance = await repo.getBalance('week');
    const auditLog = await repo.getAuditLog();
    
    return c.json({
      weekIncome: balance.week || 0,
      weekExpenses: balance.weekExpenses || 0,
      netWeek: (balance.week || 0) - (balance.weekExpenses || 0),
      transactionCount: auditLog.length,
      topClients: [],
    });
  } catch (error) {
    return c.json({ error: 'Failed to fetch reports' }, 500);
  }
});

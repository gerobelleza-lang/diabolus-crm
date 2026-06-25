// @ts-nocheck
/**
 * leads_b2b.ts — Agente de Leads B2B para Diabolus
 *
 * Flow completo:
 * 1. POST /api/leads-b2b/launch      → lanza Apify Google Maps scraper (sector + ciudad)
 * 2. POST /api/leads-b2b/callback    → Apify webhook → guarda leads → outreach WA automático
 * 3. GET  /api/leads-b2b/pipeline    → Kanban: nuevo / contactado / respondio / interesado / cliente / descartado
 * 4. GET  /api/leads-b2b/stats       → métricas de conversión
 * 5. POST /api/leads-b2b/outreach/:id → outreach manual a un lead concreto
 * 6. POST /api/leads-b2b/followup    → follow-up diario (llamado por trigger interno)
 * 7. handleB2BWaInbound()            → función exportada para manejar respuestas WA desde app.ts
 *
 * Supabase — tablas necesarias (ejecutar migración):
 * ─────────────────────────────────────────────────
 * CREATE TABLE IF NOT EXISTS leads_b2b (
 *   id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *   nombre          TEXT,
 *   sector          TEXT,
 *   ciudad          TEXT,
 *   telefono        TEXT UNIQUE,
 *   email           TEXT,
 *   website         TEXT,
 *   google_maps_url TEXT,
 *   fuente          TEXT DEFAULT 'google_maps',
 *   estado          TEXT DEFAULT 'nuevo',
 *   apify_run_id    TEXT,
 *   followup_count  INTEGER DEFAULT 0,
 *   ultima_contacto_at TIMESTAMPTZ,
 *   notas           TEXT,
 *   created_at      TIMESTAMPTZ DEFAULT NOW()
 * );
 *
 * CREATE TABLE IF NOT EXISTS leads_b2b_runs (
 *   id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *   apify_run_id    TEXT,
 *   sector          TEXT,
 *   ciudad          TEXT,
 *   limite          INTEGER,
 *   estado          TEXT DEFAULT 'running',
 *   leads_encontrados INTEGER,
 *   leads_nuevos    INTEGER,
 *   leads_enviados  INTEGER,
 *   created_at      TIMESTAMPTZ DEFAULT NOW()
 * );
 *
 * CREATE TABLE IF NOT EXISTS leads_b2b_conv (
 *   id       UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *   lead_id  UUID REFERENCES leads_b2b(id) ON DELETE CASCADE,
 *   role     TEXT,
 *   content  TEXT,
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 * );
 */

import { Hono } from 'hono';

const publicApp    = new Hono(); // rutas sin auth (callback Apify)
const protectedApp = new Hono(); // rutas con auth (launch, pipeline, stats, outreach, followup)

const API_BASE = 'https://diabolus-crm-api.vercel.app';

// ─── Helpers internos ─────────────────────────────────────────────────────────

function getSbFetch(url: string, key: string) {
  return (path: string, opts?: any) =>
    fetch(`${url}/rest/v1/${path}`, {
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...opts?.headers,
      },
      ...opts,
    });
}

async function sendWA(to: string, text: string, token: string, phoneId: string): Promise<boolean> {
  if (!token || !phoneId) return false;
  const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to.replace(/[^0-9]/g, ''),
      type: 'text',
      text: { body: text },
    }),
  });
  return r.ok;
}

async function tgAlert(msg: string, token: string, chatId: string) {
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
  }).catch(() => {});
}

function mensajeInicial(nombre: string, sector: string): string {
  return (
    `Hola ${nombre} 👋\n\n` +
    `Te escribo de Diabolus — llevamos la tesorería de autónomos y pymes en España: facturas, cobros y pagos, todo desde el móvil.\n\n` +
    `Veo que tienes un negocio de ${sector}. ¿Estás usando Excel o papel para llevar las cuentas?\n\n` +
    `Son 49€/mes y te ahorras horas cada semana. ¿Te interesa echar un vistazo rápido?`
  );
}

function normalizarTelefono(raw: string): string | null {
  const clean = raw.replace(/[^0-9]/g, '');
  if (clean.startsWith('34') && clean.length === 11) return clean;
  if (clean.length === 9 && (clean.startsWith('6') || clean.startsWith('7') || clean.startsWith('9'))) return `34${clean}`;
  return null;
}

// ─── Ruta pública: POST /api/leads-b2b/callback (Apify webhook) ──────────────

publicApp.post('/callback', async (c) => {
  const SUPABASE_URL = process.env.SUPABASE_URL!;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const APIFY_TOKEN  = process.env.APIFY_API_TOKEN!;
  const WA_TOKEN     = process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN!;
  const WA_PHONE_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN!;
  const TG_CHAT      = process.env.TELEGRAM_CHAT_ID!;

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ ok: false }, 400); }

  const { runId, status, datasetId, sector = '', ciudad = '' } = body;

  if (status !== 'ACTOR.RUN.SUCCEEDED' || !datasetId) {
    await tgAlert(`⚠️ <b>Leads B2B — run fallido</b>\nRun: ${runId}\nStatus: ${status}`, TG_TOKEN, TG_CHAT);
    return c.json({ ok: false, reason: 'run not succeeded' });
  }

  // Obtener resultados del dataset Apify
  let items: any[] = [];
  try {
    const r = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json&limit=200`);
    items = await r.json();
  } catch (e: any) {
    return c.json({ error: 'failed to fetch dataset', details: e.message }, 500);
  }

  const sb = getSbFetch(SUPABASE_URL, SUPABASE_KEY);
  let nuevos = 0, enviados = 0;

  for (const item of items) {
    const telefono = normalizarTelefono(item.phone || item.phoneUnformatted || '');
    if (!telefono) continue;

    const nombre  = item.title || item.name || 'Negocio';
    const email   = item.email || null;
    const website = item.website || null;
    const gmUrl   = item.url || null;

    // Anti-duplicado
    const existR = await sb(`leads_b2b?telefono=eq.${telefono}&limit=1&select=id`);
    const exist  = await existR.json().catch(() => []);
    if (Array.isArray(exist) && exist.length > 0) continue;

    // Insertar lead
    const insR = await sb('leads_b2b', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        nombre, telefono, email, website,
        sector:          sector || 'general',
        ciudad:          ciudad || 'España',
        google_maps_url: gmUrl,
        fuente:          'google_maps',
        apify_run_id:    runId,
        estado:          'nuevo',
        created_at:      new Date().toISOString(),
      }),
    });

    if (insR.ok) {
      nuevos++;

      // Outreach automático por WhatsApp
      const msg  = mensajeInicial(nombre, sector || 'servicios');
      const sent = await sendWA(telefono, msg, WA_TOKEN, WA_PHONE_ID);

      if (sent) {
        enviados++;
        await sb(`leads_b2b?telefono=eq.${telefono}`, {
          method: 'PATCH',
          body: JSON.stringify({ estado: 'contactado', ultima_contacto_at: new Date().toISOString() }),
        }).catch(() => {});
      }
    }
  }

  // Actualizar run
  await sb(`leads_b2b_runs?apify_run_id=eq.${runId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      estado: 'completed',
      leads_encontrados: items.length,
      leads_nuevos: nuevos,
      leads_enviados: enviados,
    }),
  }).catch(() => {});

  await tgAlert(
    `✅ <b>Leads B2B — Scraping completado</b>\n` +
    `Sector: ${sector || 'general'} | Ciudad: ${ciudad || 'España'}\n` +
    `Resultados Apify: ${items.length} | Leads nuevos: ${nuevos} | WhatsApp enviados: ${enviados}`,
    TG_TOKEN, TG_CHAT
  );

  return c.json({ ok: true, items: items.length, nuevos, enviados });
});

// ─── Rutas protegidas ─────────────────────────────────────────────────────────

// POST /api/leads-b2b/launch — lanza scraping con Apify
protectedApp.post('/launch', async (c) => {
  const SUPABASE_URL = process.env.SUPABASE_URL!;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const APIFY_TOKEN  = process.env.APIFY_API_TOKEN!;
  const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN!;
  const TG_CHAT      = process.env.TELEGRAM_CHAT_ID!;

  if (!APIFY_TOKEN) {
    return c.json({ error: 'APIFY_API_TOKEN no configurado en Vercel' }, 500);
  }

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad json' }, 400); }

  const {
    sector  = 'autónomo',
    ciudad  = 'Madrid',
    limite  = 50,
  } = body;

  const searchQuery = `${sector} ${ciudad}`;
  const sb = getSbFetch(SUPABASE_URL, SUPABASE_KEY);

  try {
    const r = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchStringsArray: [searchQuery],
        maxCrawledPlacesPerSearch: Math.min(Math.max(limite, 10), 200),
        language: 'es',
        countryCode: 'es',
        scrapeContacts: true,
        includeWebResults: false,
        startUrls: (() => {
          const coords: Record<string, {lat:number,lng:number}> = {
            'madrid': {lat:40.4168,lng:-3.7038},
            'barcelona': {lat:41.3851,lng:2.1734},
            'valencia': {lat:39.4699,lng:-0.3763},
            'sevilla': {lat:37.3891,lng:-5.9845},
            'zaragoza': {lat:41.6488,lng:-0.8891},
            'málaga': {lat:36.7213,lng:-4.4214},
            'malaga': {lat:36.7213,lng:-4.4214},
            'bilbao': {lat:43.2630,lng:-2.9350},
          };
          const c = coords[ciudad.toLowerCase()] || {lat:40.4168,lng:-3.7038};
          return [{url: `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}/@${c.lat},${c.lng},12z`}];
        })(),
        webhooks: [{
          eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED'],
          requestUrl: `${API_BASE}/api/leads-b2b/callback`,
          payloadTemplate: JSON.stringify({
            runId: '{{runId}}',
            status: '{{eventType}}',
            datasetId: '{{defaultDatasetId}}',
            sector,
            ciudad,
          }),
        }],
      }),
    });

    const run = await r.json();
    if (!r.ok) return c.json({ error: 'Error Apify', details: run }, 500);

    await sb('leads_b2b_runs', {
      method: 'POST',
      body: JSON.stringify({
        apify_run_id: run.data?.id,
        sector, ciudad, limite,
        estado: 'running',
        created_at: new Date().toISOString(),
      }),
    }).catch(() => {});

    await tgAlert(
      `🤖 <b>Agente Leads B2B — Scraping lanzado</b>\n` +
      `Búsqueda: "${searchQuery}"\nLímite: ${limite} leads\nRun ID: ${run.data?.id}`,
      TG_TOKEN, TG_CHAT
    );

    return c.json({ ok: true, run_id: run.data?.id, search: searchQuery, limite });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /api/leads-b2b/pipeline
protectedApp.get('/pipeline', async (c) => {
  const sb = getSbFetch(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    const r = await sb('leads_b2b?order=created_at.desc&limit=500&select=*');
    const leads = await r.json();

    if (!Array.isArray(leads)) return c.json({ error: 'db error' }, 500);

    const pipeline = {
      nuevo:      leads.filter((l: any) => l.estado === 'nuevo'),
      contactado: leads.filter((l: any) => l.estado === 'contactado'),
      respondio:  leads.filter((l: any) => l.estado === 'respondio'),
      interesado: leads.filter((l: any) => l.estado === 'interesado'),
      cliente:    leads.filter((l: any) => l.estado === 'cliente'),
      descartado: leads.filter((l: any) => l.estado === 'descartado'),
    };

    return c.json({ ok: true, pipeline, total: leads.length });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /api/leads-b2b/stats
protectedApp.get('/stats', async (c) => {
  const sb = getSbFetch(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    const r = await sb('leads_b2b?select=estado,sector,ciudad,created_at');
    const leads = await r.json();

    if (!Array.isArray(leads)) return c.json({ error: 'db error' }, 500);

    const total       = leads.length;
    const contactados = leads.filter((l: any) => l.estado !== 'nuevo').length;
    const interesados = leads.filter((l: any) => ['interesado', 'cliente'].includes(l.estado)).length;
    const clientes    = leads.filter((l: any) => l.estado === 'cliente').length;
    const conversion  = total > 0 ? +((clientes / total) * 100).toFixed(1) : 0;

    // Sectores con más leads
    const sectorMap: Record<string, number> = {};
    for (const l of leads) {
      if (l.sector) sectorMap[l.sector] = (sectorMap[l.sector] || 0) + 1;
    }
    const topSectores = Object.entries(sectorMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sector, count]) => ({ sector, count }));

    return c.json({
      ok: true,
      stats: { total, contactados, interesados, clientes, conversion_pct: conversion },
      top_sectores: topSectores,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/leads-b2b/outreach/:id — outreach manual
protectedApp.post('/outreach/:id', async (c) => {
  const id = c.req.param('id');
  const sb = getSbFetch(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    const r    = await sb(`leads_b2b?id=eq.${id}&select=*&limit=1`);
    const arr  = await r.json();
    const lead = arr?.[0];

    if (!lead) return c.json({ error: 'lead not found' }, 404);
    if (!lead.telefono) return c.json({ error: 'sin teléfono' }, 400);

    const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN!;
    const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;

    const msg  = mensajeInicial(lead.nombre || 'amigo', lead.sector || 'servicios');
    const sent = await sendWA(lead.telefono, msg, WA_TOKEN, WA_PHONE_ID);

    if (sent) {
      await sb(`leads_b2b?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ estado: 'contactado', ultima_contacto_at: new Date().toISOString() }),
      });
    }

    return c.json({ ok: sent, lead: lead.nombre });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/leads-b2b/followup — follow-up diario (trigger interno)
protectedApp.post('/followup', async (c) => {
  const sb = getSbFetch(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN!;
  const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;

  const ahora  = new Date();
  const hace3d = new Date(ahora.getTime() - 3 * 24 * 3600 * 1000).toISOString();

  let leads: any[] = [];
  try {
    const r = await sb(
      `leads_b2b?estado=in.(contactado,respondio)&select=*&order=created_at.asc&limit=200`
    );
    const all = await r.json();
    leads = (all || []).filter((l: any) => {
      const ref  = l.ultima_contacto_at || l.created_at;
      const dias = Math.floor((ahora.getTime() - new Date(ref).getTime()) / (24 * 3600 * 1000));
      const fc   = l.followup_count || 0;
      return fc < 2 && dias >= 3 && l.telefono;
    });
  } catch { return c.json({ error: 'db error' }, 500); }

  let enviados = 0;
  for (const lead of leads) {
    const ref  = lead.ultima_contacto_at || lead.created_at;
    const dias = Math.floor((ahora.getTime() - new Date(ref).getTime()) / (24 * 3600 * 1000));
    const fc   = lead.followup_count || 0;

    let msg = '';
    if (dias >= 7 && fc === 1) {
      msg = `Hola ${lead.nombre || ''} 👋 Entiendo que quizás ahora no es el mejor momento. Si en algún momento quieres mejorar cómo llevas las cuentas, en Diabolus estaremos aquí. ¡Mucho ánimo con el negocio!`;
    } else if (dias >= 3 && fc === 0) {
      msg = `Hola ${lead.nombre || ''}, ¿pudiste echarle un vistazo a Diabolus? Llevamos facturas, cobros y pagos en automático para autónomos — 49€/mes. ¿Hablamos 5 minutos esta semana?`;
    }

    if (msg) {
      const sent = await sendWA(lead.telefono, msg, WA_TOKEN, WA_PHONE_ID);
      if (sent) {
        await sb(`leads_b2b?id=eq.${lead.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            followup_count: fc + 1,
            ultima_contacto_at: new Date().toISOString(),
          }),
        }).catch(() => {});
        enviados++;
      }
    }
  }

  return c.json({ ok: true, procesados: leads.length, enviados });
});

// ─── Función exportada: handleB2BWaInbound ────────────────────────────────────
// Llamada desde el webhook de WhatsApp en app.ts cuando el mensaje no corresponde
// a ningún lead de El Pacto (pacto_leads).

export async function handleB2BWaInbound(params: {
  from:      string;
  nombre:    string;
  mensaje:   string;
  sbUrl:     string;
  sbKey:     string;
  waToken:   string;
  waPhoneId: string;
  tgToken:   string;
  tgChat:    string;
  orKey:     string;
}): Promise<boolean> {
  const { from, nombre, mensaje, sbUrl, sbKey, waToken, waPhoneId, tgToken, tgChat, orKey } = params;
  const sb = getSbFetch(sbUrl, sbKey);

  // Buscar lead B2B por teléfono
  let lead: any = null;
  try {
    const r   = await sb(`leads_b2b?telefono=eq.${from}&order=created_at.desc&limit=1&select=*`);
    const arr = await r.json();
    lead = arr?.[0] || null;
  } catch {}

  if (!lead) return false; // No es un lead B2B conocido — no hacer nada

  // Historial de conversación
  let historial: any[] = [];
  try {
    const r = await sb(`leads_b2b_conv?lead_id=eq.${lead.id}&order=created_at.asc&limit=10&select=role,content`);
    historial = (await r.json())?.map((m: any) => ({ role: m.role, content: m.content })) || [];
  } catch {}

  // LLM — clasificar intención y generar respuesta
  const systemPrompt =
    `Eres el agente comercial de Diabolus, SaaS de tesorería para autónomos y pymes en España (49€/mes).\n` +
    `Tu misión: convertir este lead en cliente de Diabolus.\n` +
    `Habla de facturas, cobros, pagos, tesorería. Nunca de asesoría fiscal ni de gestoría.\n` +
    `Tono: directo, emprendedor, sin rodeos. Máximo 3 frases. Nunca reveles que eres IA.\n` +
    `Clasifica intención: INTERESADO | PRECIO | DUDA | NO_INTERESA | CLIENTE_POTENCIAL | CERRADO\n` +
    `Responde en JSON estricto: {"intencion":"...", "respuesta":"..."}`;

  let intencion = 'DUDA';
  let respuesta = `¡Hola! ¿En qué puedo ayudarte con Diabolus?`;

  try {
    const llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nousresearch/hermes-3-llama-3.1-70b',
        messages: [
          { role: 'system', content: systemPrompt },
          ...historial,
          { role: 'user', content: mensaje },
        ],
        max_tokens: 300,
        temperature: 0.65,
        response_format: { type: 'json_object' },
      }),
    });
    const llmJson = await llmRes.json();
    const parsed  = JSON.parse(llmJson.choices?.[0]?.message?.content || '{}');
    intencion = parsed.intencion || intencion;
    respuesta = parsed.respuesta || respuesta;
  } catch {}

  // Guardar historial
  try {
    await sb('leads_b2b_conv', {
      method: 'POST',
      body: JSON.stringify([
        { lead_id: lead.id, role: 'user',      content: mensaje  },
        { lead_id: lead.id, role: 'assistant', content: respuesta },
      ]),
    });

    // Actualizar estado lead
    let nuevoEstado = lead.estado || 'contactado';
    if (['contactado', 'nuevo'].includes(nuevoEstado))           nuevoEstado = 'respondio';
    if (intencion === 'INTERESADO' || intencion === 'CLIENTE_POTENCIAL') nuevoEstado = 'interesado';
    if (intencion === 'CERRADO')    nuevoEstado = 'cliente';
    if (intencion === 'NO_INTERESA') nuevoEstado = 'descartado';

    await sb(`leads_b2b?id=eq.${lead.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ estado: nuevoEstado, ultima_contacto_at: new Date().toISOString() }),
    });

    // Alerta Telegram si lead caliente
    if (['INTERESADO', 'CLIENTE_POTENCIAL', 'CERRADO'].includes(intencion)) {
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: tgChat,
          parse_mode: 'HTML',
          text:
            `🔥 <b>Lead B2B caliente</b>\n` +
            `${nombre} (+${from})\n` +
            `Sector: ${lead.sector} | Ciudad: ${lead.ciudad}\n` +
            `Intención: ${intencion}\n` +
            `Dice: "${mensaje.slice(0, 120)}"`,
        }),
      }).catch(() => {});
    }
  } catch {}

  // Responder por WhatsApp si no descartado
  if (intencion !== 'NO_INTERESA' && waToken) {
    fetch(`https://graph.facebook.com/v19.0/${waPhoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: respuesta },
      }),
    }).catch(() => {});
  }

  return true;
}


// ─── Rutas internas (sin user auth — token interno) ──────────────────────────
// Usadas por triggers programados (Tasklet) y llamadas de sistema.
// Requieren header: x-internal-secret: <INTERNAL_API_SECRET env var>

const internalApp = new Hono();

internalApp.use('*', async (c, next) => {
  const secret   = c.req.header('x-internal-secret');
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected || secret !== expected) return c.json({ error: 'Forbidden' }, 403);
  await next();
});

// POST /api/internal/leads-b2b/launch — lanza scraping (sin user JWT)
internalApp.post('/launch', async (c) => {
  const SUPABASE_URL = process.env.SUPABASE_URL!;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const APIFY_TOKEN  = process.env.APIFY_API_TOKEN!;
  const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN!;
  const TG_CHAT      = process.env.TELEGRAM_CHAT_ID!;

  if (!APIFY_TOKEN) return c.json({ error: 'APIFY_API_TOKEN no configurado' }, 500);

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad json' }, 400); }

  const { sector = 'peluquería', ciudad = 'Madrid', limite = 50 } = body;
  const searchQuery = `${sector} ${ciudad}`;
  const sb = getSbFetch(SUPABASE_URL, SUPABASE_KEY);

  try {
    const r = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchStringsArray: [searchQuery],
        maxCrawledPlacesPerSearch: Math.min(Math.max(limite, 10), 200),
        language: 'es',
        countryCode: 'es',
        scrapeContacts: true,
        includeWebResults: false,
        startUrls: (() => {
          const coords: Record<string, {lat:number,lng:number}> = {
            'madrid': {lat:40.4168,lng:-3.7038},
            'barcelona': {lat:41.3851,lng:2.1734},
            'valencia': {lat:39.4699,lng:-0.3763},
            'sevilla': {lat:37.3891,lng:-5.9845},
            'zaragoza': {lat:41.6488,lng:-0.8891},
            'málaga': {lat:36.7213,lng:-4.4214},
            'malaga': {lat:36.7213,lng:-4.4214},
            'bilbao': {lat:43.2630,lng:-2.9350},
          };
          const c = coords[ciudad.toLowerCase()] || {lat:40.4168,lng:-3.7038};
          return [{url: `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}/@${c.lat},${c.lng},12z`}];
        })(),
        webhooks: [{
          eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED'],
          requestUrl: `${API_BASE}/api/leads-b2b/callback`,
          payloadTemplate: JSON.stringify({
            runId: '{{runId}}',
            status: '{{eventType}}',
            datasetId: '{{defaultDatasetId}}',
            sector,
            ciudad,
          }),
        }],
      }),
    });

    const run = await r.json();
    if (!r.ok) return c.json({ error: 'Error Apify', details: run }, 500);

    await sb('leads_b2b_runs', {
      method: 'POST',
      body: JSON.stringify({ apify_run_id: run.data?.id, sector, ciudad, limite, estado: 'running', created_at: new Date().toISOString() }),
    }).catch(() => {});

    await tgAlert(
      `🤖 <b>Agente Leads B2B — Scraping lanzado</b>\n` +
      `Búsqueda: "${searchQuery}"\nLímite: ${limite} leads\nRun ID: ${run.data?.id}`,
      TG_TOKEN, TG_CHAT
    );

    return c.json({ ok: true, run_id: run.data?.id, search: searchQuery, limite });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/internal/leads-b2b/followup — follow-up diario (trigger Tasklet)
internalApp.post('/followup', async (c) => {
  const sb = getSbFetch(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN!;
  const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN!;
  const TG_CHAT     = process.env.TELEGRAM_CHAT_ID!;

  const ahora = new Date();
  let leads: any[] = [];
  try {
    const r = await sb('leads_b2b?estado=in.(contactado,respondio)&select=*&order=created_at.asc&limit=200');
    const all = await r.json();
    leads = (all || []).filter((l: any) => {
      const ref  = l.ultima_contacto_at || l.created_at;
      const dias = Math.floor((ahora.getTime() - new Date(ref).getTime()) / (24 * 3600 * 1000));
      const fc   = l.followup_count || 0;
      return fc < 2 && dias >= 3 && l.telefono;
    });
  } catch { return c.json({ error: 'db error' }, 500); }

  let enviados = 0;
  for (const lead of leads) {
    const ref  = lead.ultima_contacto_at || lead.created_at;
    const dias = Math.floor((ahora.getTime() - new Date(ref).getTime()) / (24 * 3600 * 1000));
    const fc   = lead.followup_count || 0;

    let msg = '';
    if (dias >= 7 && fc === 1) {
      msg = `Hola ${lead.nombre || ''} 👋 Entiendo que quizás ahora no es el mejor momento. Si en algún momento quieres mejorar cómo llevas las cuentas, en Diabolus estaremos aquí. ¡Mucho ánimo con el negocio!`;
    } else if (dias >= 3 && fc === 0) {
      msg = `Hola ${lead.nombre || ''}, ¿pudiste echarle un vistazo a Diabolus? Llevamos facturas, cobros y pagos en automático para autónomos — 49€/mes. ¿Hablamos 5 minutos esta semana?`;
    }

    if (msg) {
      const sent = await sendWA(lead.telefono, msg, WA_TOKEN, WA_PHONE_ID);
      if (sent) {
        await sb(`leads_b2b?id=eq.${lead.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ followup_count: fc + 1, ultima_contacto_at: new Date().toISOString() }),
        }).catch(() => {});
        enviados++;
      }
    }
  }

  await tgAlert(
    `📋 <b>Leads B2B — Follow-up diario</b>\nProcesados: ${leads.length} | WhatsApp enviados: ${enviados}`,
    TG_TOKEN, TG_CHAT
  );

  return c.json({ ok: true, procesados: leads.length, enviados });
});

export const leadsB2bInternalRoutes  = internalApp;

export const leadsB2bPublicRoutes    = publicApp;
export const leadsB2bProtectedRoutes = protectedApp;

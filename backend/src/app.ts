// @ts-nocheck
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { authRoutes } from './routes/auth'
import { dashboardRoutes } from './routes/dashboard'
import { clientRoutes } from './routes/clients'
import { transactionRoutes } from './routes/transactions'
import { invoiceRoutes } from './routes/invoices'
import { agentRoutes } from './routes/agent'
import { reportRoutes } from './routes/reports'
import { stripeRoutes } from './routes/stripe'
import { webhookRoutes } from './routes/webhooks'
import { demonioRoutes } from './routes/demonio'
import { registerPrivacidadRoute } from './routes/privacidad'
import { telegramRoutes, telegramBotRoutes } from './routes/telegram'
import { gestorRoutes, gestorPublicRoutes } from './routes/gestor'
import { chatRoutes } from './routes/chat'
import { exportPublicRoutes } from './routes/export'
import { onboardingRoutes } from './routes/onboarding'
import { categoriesRoutes } from './routes/categories'
import { whatsappRoutes } from './routes/whatsapp'
import { documentsRoutes, documentsPublicRoutes } from './routes/documents'
import { cazadorRoutes, cazadorInternalRoute, cazadorPreviewRoute } from './routes/cazador'
import { supportRoutes } from './routes/support'
import { legalRoutes } from './routes/legal'
import { pactoRoutes } from './routes/pacto'
import { albaranRoute } from './routes/albaran'
import { transcribeRoute } from './routes/transcribe'
import { ttsRoute } from './routes/tts'
import { authMiddleware } from './middleware/auth'
import { getSupabaseAdmin } from './integrations/supabase'
import { accrueCommissions } from './routes/export'
import { adminRoutes } from './routes/admin'
import { waitlistRoutes } from './routes/waitlist'
import { monitorRoutes } from './routes/monitor'
import { leadsB2bPublicRoutes, leadsB2bProtectedRoutes, leadsB2bInternalRoutes, handleB2BWaInbound } from './routes/leads_b2b'

export function createApp() {
  const app = new Hono()

  // ─── Global Middleware ─────────────────────────────────────────────────────
  app.use('*', logger())

  // CORS: origin function + explicit OPTIONS handler before auth
  const corsMiddleware = cors({
    origin: (origin) => {
      if (!origin) return null
      const allowed = [
        'https://diabolus.es',
        'https://www.diabolus.es',
        'http://diabolus.es',
        'https://gerobelleza-lang.github.io',
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500',
      ]
      return allowed.includes(origin) ? origin : null
    },
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    credentials: true,
    maxAge: 86400,
  })

  app.use('*', corsMiddleware)

  // Explicit preflight handler — runs BEFORE authMiddleware, returns 204 immediately
  app.options('*', (c) => {
    return c.newResponse(null, 204)
  })

  // ─── Health & Root ─────────────────────────────────────────────────────────
  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() })
  )

  // ─── Public Routes ─────────────────────────────────────────────────────────
  app.route('/auth', authRoutes)

  // ─── Waitlist (Public — sin auth, recoge emails de interesados) ────────────
  app.route('/api/waitlist', waitlistRoutes)

  // ─── Stripe & External Webhooks (Public, no auth) ──────────────────────────
  app.route('/api/stripe', stripeRoutes)
  app.route('/webhooks', webhookRoutes)
  app.route('/webhooks/whatsapp', whatsappRoutes)
  app.route('/telegram', telegramBotRoutes)

  // ─── Export Downloads (Public — validado por token firmado 15 min) ─────────
  app.route('/api/export', exportPublicRoutes)

  // ─── Gestor Portal (Public — acceso con token de gestor) ───────────────────
  app.route('/gestor', gestorPublicRoutes)

  // ─── Documents Verify (Public — cualquiera puede verificar un hash) ────────
  app.route('/api/documents/verify', documentsPublicRoutes)

  // ─── Support Email (Public — auth via x-support-secret) ────────────────────
  app.route('/api/support', supportRoutes)

  // ─── Leads B2B — Apify callback (Public — llamado por Apify, sin user auth) ─
  app.route('/api/leads-b2b', leadsB2bPublicRoutes)

  // ─── Leads B2B — Rutas internas (trigger Tasklet — secret header) ──────────
  app.route('/api/internal/leads-b2b', leadsB2bInternalRoutes)

  // ─── Demonio Callback (Public — N8N webhook, no user auth) ─────────────────
  app.post('/api/demonio/callback', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const { task_id, status, result, error, preview } = body
      if (!task_id || !status) return c.json({ error: 'Missing task_id or status' }, 400)
      const supabase = getSupabaseAdmin()
      const { error: updateErr } = await supabase
        .from('demonio_tasks')
        .update({ status, result: result ?? null, error: error ?? null, preview: preview ?? null, updated_at: new Date().toISOString() })
        .eq('id', task_id)
      if (updateErr) return c.json({ error: 'Failed to update task' }, 500)
      if (status === 'completed') {
        const { data: task } = await supabase.from('demonio_tasks').select('*').eq('id', task_id).single()
        if (task) await supabase.from('audit_log').insert([{ user_id: task.user_id, salon_id: task.salon_id, action: `demonio_${task.action}`, changes: result, created_at: new Date().toISOString() }])
      }
      return c.json({ received: true })
    } catch (err) {
      console.error('[Demonio Callback] Error:', err)
      return c.json({ error: 'Internal error' }, 500)
    }
  })

  // ─── Internal: Monitor (Stripe + Health — no user auth) ───────────────────
  app.route('/api/internal/monitor', monitorRoutes)

  // ─── Internal: Commissions Accrue (called by monthly trigger) ─────────────
  app.post('/api/internal/commissions/accrue', async (c) => {
    try {
      const supabase = getSupabaseAdmin()
      const result = await accrueCommissions(supabase)
      return c.json({ ok: true, ...result })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // ─── Internal: Cazador Run (called by daily trigger — no user auth) ────────
  app.post('/api/internal/cazador/run', cazadorInternalRoute)

  // ─── Internal: Cazador Preview 08:00 (aviso al dueño antes de actuar) ─────
  app.post('/api/internal/cazador/preview', cazadorPreviewRoute)

  // ─── Public: Política de privacidad (requerida por Meta para publicar app) ──
  registerPrivacidadRoute(app)

  // ─── Public: Meta WhatsApp webhook verification (no auth) ──────────────────
  app.get('/api/demonio/wa-verify', async (c) => {
    const mode      = c.req.query('hub.mode')
    const token     = c.req.query('hub.verify_token')
    const challenge = c.req.query('hub.challenge')
    const expected  = c.env?.WA_VERIFY_TOKEN || 'diabolus_demonio_2026'
    if (mode === 'subscribe' && token === expected) {
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }
    return new Response('Forbidden', { status: 403 })
  })

  // ─── Public: Meta WhatsApp incoming messages ─────────────────────────────────
  app.post('/api/demonio/wa-verify', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ ok: true }); }
    if (body.object !== 'whatsapp_business_account') return c.json({ ok: true });

    const entry   = body.entry?.[0];
    const change  = entry?.changes?.[0]?.value;
    const msg     = change?.messages?.[0];
    const contact = change?.contacts?.[0];
    if (!msg || msg.type !== 'text') return c.json({ ok: true });

    const from    = msg.from || '';
    const mensaje = msg.text?.body || '';
    const nombre  = contact?.profile?.name || 'Cliente';
    if (!from || !mensaje) return c.json({ ok: true });

    const SUPABASE_URL = c.env?.SUPABASE_URL || 'https://emygbvxkhfbwyhbapaae.supabase.co';
    const SUPABASE_KEY = c.env?.SUPABASE_SERVICE_ROLE_KEY || '';
    const OR_KEY       = c.env?.OPENROUTER_API_KEY || '';
    const WA_TOKEN     = c.env?.WHATSAPP_TOKEN || '';
    const WA_PHONE_ID  = c.env?.WHATSAPP_PHONE_NUMBER_ID || '1214990365020353';
    const TG_TOKEN     = c.env?.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT      = c.env?.TELEGRAM_CHAT_ID || '8356150792';

    const sb = (path: string, opts?: any) =>
      fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
          ...opts?.headers
        },
        ...opts
      });

    // Buscar lead de El Pacto por número WA
    let lead: any = null;
    try {
      const r = await sb(`pacto_leads?whatsapp=eq.${from}&order=created_at.desc&limit=1&select=*,pacto_campanas(salon_id,salons(nombre))`);
      const arr = await r.json();
      lead = arr?.[0] || null;
    } catch {}

    // Si no es lead de El Pacto, intentar como lead B2B
    if (!lead) {
      await handleB2BWaInbound({
        from, nombre, mensaje,
        sbUrl:     SUPABASE_URL,
        sbKey:     SUPABASE_KEY,
        waToken:   WA_TOKEN,
        waPhoneId: WA_PHONE_ID,
        tgToken:   TG_TOKEN,
        tgChat:    TG_CHAT,
        orKey:     OR_KEY,
      }).catch(() => {});
      return c.json({ ok: true });
    }

    const salonNombre = lead?.pacto_campanas?.salons?.nombre || 'el salón';

    // Historial conversación
    let historial: any[] = [];
    try {
      const r = await sb(`demonio_conversaciones?lead_id=eq.${lead.id}&order=created_at.asc&limit=12&select=role,content`);
      const arr = await r.json();
      historial = arr?.map((m: any) => ({ role: m.role, content: m.content })) || [];
    } catch {}

    // LLM — Hermes 3
    const systemPrompt = `Eres El Demonio, agente de ventas íntimo y persuasivo de ${salonNombre}. \nNunca eres agresivo. Hablas como un amigo de confianza que conoce el sector belleza.\nClasifica la intención del cliente en: INTERESADO, PRECIO, DUDA, NO_INTERESA, CITA_CONFIRMADA.\nResponde en 2-3 frases naturales, cálidas y directas. Nunca menciones que eres IA.\nDevuelve JSON: {"intencion":"...", "respuesta":"..."}`;

    let intencion = 'DUDA';
    let respuesta = `¡Hola ${nombre}! 😊 Me alegra que hayas escrito. ¿En qué puedo ayudarte?`;

    try {
      const llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'nousresearch/hermes-3-llama-3.1-70b',
          messages: [
            { role: 'system', content: systemPrompt },
            ...historial,
            { role: 'user', content: mensaje }
          ],
          max_tokens: 300, temperature: 0.7,
          response_format: { type: 'json_object' }
        })
      });
      const llmJson = await llmRes.json();
      const parsed = JSON.parse(llmJson.choices?.[0]?.message?.content || '{}');
      intencion = parsed.intencion || intencion;
      respuesta = parsed.respuesta || respuesta;
    } catch {}

    // Guardar historial y actualizar estado
    try {
      await sb('demonio_conversaciones', {
        method: 'POST',
        body: JSON.stringify([
          { lead_id: lead.id, role: 'user',      content: mensaje   },
          { lead_id: lead.id, role: 'assistant', content: respuesta }
        ])
      });
      let nuevoEstado = lead.estado || 'contactado';
      if (intencion === 'INTERESADO' || intencion === 'PRECIO') nuevoEstado = 'respondio';
      if (intencion === 'CITA_CONFIRMADA')                       nuevoEstado = 'cita_agendada';
      if (intencion === 'NO_INTERESA')                           nuevoEstado = 'descartado';
      await sb(`pacto_leads?id=eq.${lead.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ estado: nuevoEstado, ultima_respuesta_at: new Date().toISOString() })
      });
      if (intencion === 'INTERESADO' || intencion === 'CITA_CONFIRMADA') {
        fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: TG_CHAT,
            parse_mode: 'HTML',
            text: `🔥 <b>Lead caliente — El Demonio</b>\nSalón: ${salonNombre}\nLead: ${nombre} (+${from})\nIntención: ${intencion}\nDice: "${mensaje.slice(0,100)}"`
          })
        }).catch(() => {});
      }
    } catch {}

    // Responder por WhatsApp
    if (intencion !== 'NO_INTERESA' && WA_TOKEN) {
      fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: { body: respuesta }
        })
      }).catch(() => {});
    }

    return c.json({ ok: true });
  })

  // ─── Protected Routes ──────────────────────────────────────────────────────
  app.use('/api/*', authMiddleware)
  app.route('/api/dashboard', dashboardRoutes)
  app.route('/api/clients', clientRoutes)
  app.route('/api/transactions', transactionRoutes)
  app.route('/api/invoices', invoiceRoutes)
  app.route('/api/agent', agentRoutes)
  app.route('/api/reports', reportRoutes)
  app.route('/api/demonio', demonioRoutes)
  app.route('/api/gestor', gestorRoutes)
  app.route('/api/chat', chatRoutes)
  app.route('/api/onboarding', onboardingRoutes)
  app.route('/api/categories', categoriesRoutes)
  app.route('/api/notifications/telegram', telegramRoutes)
  app.route('/api/documents', documentsRoutes)
  app.route('/api/cazador', cazadorRoutes)
  app.route('/api/legal', legalRoutes)       // ← Módulo Legal
  app.route('/api/pacto', pactoRoutes)       // ← El Pacto del Diablo
  app.route('/api/admin', adminRoutes)       // ← Super Admin: usage, planes
  app.route('/api/albaranes', albaranRoute)      // ← Albaranes (Panel Móvil)
  app.route('/api/agent/transcribe', transcribeRoute) // ← Voz → Groq Whisper
  app.post('/api/agent/tts', ttsRoute)               // ← TTS → OpenAI voz
  app.route('/api/leads-b2b', leadsB2bProtectedRoutes) // ← Agente Leads B2B

  // ─── Error Handling ────────────────────────────────────────────────────────
  app.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404))
  app.onError((err, c) => {
    console.error(`[ERROR] ${err.message}`, err)
    return c.json({ error: err.message || 'Internal Server Error' }, 500)
  })

  return app
}

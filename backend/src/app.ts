import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { authLimiter, agentLimiter, apiLimiter, webhookLimiter, waitlistLimiter } from './middleware/rate-limit'
import { authRoutes } from './routes/auth'
import { dashboardRoutes } from './routes/dashboard'
import { healthScoreRoutes } from './routes/health-score'
import { clientRoutes } from './routes/clients'
import { transactionRoutes } from './routes/transactions'
import { invoiceRoutes } from './routes/invoices'
import { agentRoutes } from './routes/agent'
import { voiceRoute } from './routes/voice'
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
import { documentsRoutes, documentsPublicRoutes } from './routes/documents'
import { cazadorRoutes, cazadorInternalRoute, cazadorPreviewRoute } from './routes/cazador'
import { supportRoutes } from './routes/support'
import { legalRoutes } from './routes/legal'
import { pactoRoutes } from './routes/pacto'
import { albaranRoute } from './routes/albaran'
import { transcribeRoute } from './routes/transcribe'
import { ttsRoute } from './routes/tts'
import { securityHeaders } from './middleware/security-headers'
import { authMiddleware } from './middleware/auth'
import { getSupabaseAdmin } from './integrations/supabase'
import { accrueCommissions } from './routes/export'
import { adminRoutes } from './routes/admin'
import { waitlistRoutes } from './routes/waitlist'
import { monitorRoutes } from './routes/monitor'
import { leadsB2bPublicRoutes, leadsB2bProtectedRoutes, leadsB2bInternalRoutes, handleB2BWaInbound } from './routes/leads_b2b'
import { informeBatallaRoutes } from './routes/informe_batalla'
import { cobroEntranteRoute } from './routes/cobro_entrante'
import { salonsRoutes } from './routes/salons'
import { boeSemanalRoute } from './routes/boe_semanal'
import { driveExportRoute } from './routes/drive_export'
import { invoiceNumberingRoutes } from './routes/invoice_numbering'
import { calendarHitosRoute } from './routes/calendar_hitos'
import { brainSettingsRoutes } from './routes/brain-settings'
import { whatsappTemplatesRoutes } from './routes/whatsapp-templates'

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
  app.use('*', securityHeaders)


  // Explicit preflight handler — runs BEFORE authMiddleware, returns 204 immediately
  app.options('*', (c) => {
    return c.newResponse(null, 204)
  })

  // ─── Health & Root ─────────────────────────────────────────────────────────
  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() })
  )

  // ─── Public Routes ─────────────────────────────────────────────────────────
  app.use('/auth/*', authLimiter)
  app.route('/auth', authRoutes)

  // ─── Waitlist (Public — sin auth, recoge emails de interesados) ────────────
  app.use('/api/waitlist/*', waitlistLimiter)
  app.route('/api/waitlist', waitlistRoutes)

  // ─── Stripe & External Webhooks (Public, no auth) ──────────────────────────
  app.route('/api/stripe', stripeRoutes)
  app.use('/webhooks/*', webhookLimiter)
  app.route('/webhooks', webhookRoutes)
  app.use('/telegram/*', webhookLimiter)
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

  // ─── Internal: Informe de Batalla 20:00 (Diablilla — sin user auth) ────────
  app.route('/api/internal/informe-batalla', informeBatallaRoutes)

  // ─── Internal: Cobro Entrante (Supabase DB Webhook → Telegram tiempo real) ──
  app.route('/api/internal/cobro-entrante', cobroEntranteRoute)

  // ─── Internal: BOE Semanal (lunes — resumen legal autónomos → Telegram) ───
  app.route('/api/internal/boe-semanal', boeSemanalRoute)

  // ─── Internal: Drive Export (día 1 mes — cierre mensual → Google Drive) ───
  app.route('/api/internal/drive-export', driveExportRoute)

  // ─── Internal: Calendar Hitos (día 1 mes — vencimientos + plazos AEAT → ICS/Drive) ──
  app.route('/api/internal/calendar-hitos', calendarHitosRoute)

  // ─── Demonio Callback (Public — N8N webhook, no user auth) ─────────────────
  app.post('/api/demonio/callback', async (c) => {
    const secret = c.req.header('x-internal-secret') || ''
    const expected = process.env.INTERNAL_SECRET
    if (!expected || secret !== expected) return c.json({ error: 'Forbidden' }, 403)
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
    const secret = c.req.header('x-internal-secret') || ''
    const expected = process.env.INTERNAL_SECRET
    if (!expected || secret !== expected) return c.json({ error: 'Forbidden' }, 403)
    try {
      const supabase = getSupabaseAdmin()
      const result = await accrueCommissions(supabase)
      return c.json({ ok: true, ...result })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // ─── Internal: Cazador Run (called by daily trigger — no user auth) ────────
  app.post('/api/internal/cazador/run', async (c) => {
    const secret = c.req.header('x-internal-secret') || ''
    const expected = process.env.INTERNAL_SECRET
    if (!expected || secret !== expected) return c.json({ error: 'Forbidden' }, 403)
    return cazadorInternalRoute(c)
  })

  // ─── Internal: Cazador Preview 08:00 (aviso al dueño antes de actuar) ─────
  app.post('/api/internal/cazador/preview', async (c) => {
    const secret = c.req.header('x-internal-secret') || ''
    const expected = process.env.INTERNAL_SECRET
    if (!expected || secret !== expected) return c.json({ error: 'Forbidden' }, 403)
    return cazadorPreviewRoute(c)
  })

  // ─── Public: Política de privacidad (requerida por Meta para publicar app) ──
  registerPrivacidadRoute(app)

  // ─── Public: Meta WhatsApp webhook verification (no auth) ──────────────────
  app.get('/api/demonio/wa-verify', async (c) => {
    const mode      = c.req.query('hub.mode')
    const token     = c.req.query('hub.verify_token')
    const challenge = c.req.query('hub.challenge')
    const expected = process.env.WA_VERIFY_TOKEN as string
    if (!expected) return c.text('Server misconfigured', 500)
    if (mode === 'subscribe' && token === expected) {
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }
    return new Response('Forbidden', { status: 403 })
  })

  app.use('/api/demonio/wa-verify', webhookLimiter)
  // ─── Public: Meta WhatsApp incoming messages ─────────────────────────────────
  app.post('/api/demonio/wa-verify', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ ok: true }); }
    if (body.object !== 'whatsapp_business_account') return c.json({ ok: true });

    const entry   = body.entry?.[0];
    const change  = entry?.changes?.[0]?.value;
    const msg     = change?.messages?.[0];
    const contact = change?.contacts?.[0];
    if (!msg) return c.json({ ok: true });
    if (msg.type !== 'text' && msg.type !== 'audio') return c.json({ ok: true });

    const from    = msg.from || '';
    let mensaje = msg.text?.body || '';
    const nombre  = contact?.profile?.name || 'Cliente';

    // ── Audio transcription (WhatsApp voice notes) ──────────────────
    if (msg.type === 'audio' && msg.audio?.id) {
      try {
        const { transcribeWhatsAppAudio } = await import('./routes/voice');
        mensaje = await transcribeWhatsAppAudio(msg.audio.id);
        if (!mensaje) return c.json({ ok: true }); // empty transcription
      } catch (e) {
        console.error('[WA] Audio transcription failed:', e);
        return c.json({ ok: true }); // fail silently
      }
    }

    if (!from || !mensaje) return c.json({ ok: true });

    const SUPABASE_URL = process.env.SUPABASE_URL as string;
    const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY as string) || '';
    const OR_KEY       = (process.env.OPENROUTER_API_KEY as string) || '';
    const WA_TOKEN     = (process.env.WHATSAPP_TOKEN as string) || '';
    const WA_PHONE_ID  = (process.env.WHATSAPP_PHONE_NUMBER_ID as string) || '1214990365020353';
    const TG_TOKEN     = (process.env.TELEGRAM_BOT_TOKEN as string) || '';
    const TG_CHAT      = (process.env.TELEGRAM_CHAT_ID as string) || '8356150792';

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

    // ── Check if sender is a salon owner → route to Diablilla ──────
    try {
      const ownerR = await sb(`salons?whatsapp_number=eq.${from}&select=id,name,user_id`);
      const ownerSalons: any[] = await ownerR.json();
      if (Array.isArray(ownerSalons) && ownerSalons.length > 0) {
        const salon = ownerSalons[0];
        const { processAgentInput } = await import('./agent/core');
        const result = await processAgentInput({
          tenantId: salon.id,
          userId:   salon.user_id,
          channel:  'whatsapp',
          type:     'text',
          text:     mensaje,
        });

        // Build WhatsApp-friendly reply (strip HTML tags)
        let reply = '';
        if (result.replyText) {
          reply = result.replyText.replace(/<[^>]+>/g, '');
        } else if (result.needsInfo) {
          reply = result.needsInfo;
        } else if (result.card) {
          const fields = result.card.fields.map((f: any) => `• ${f.label}: ${f.value}`).join('\n');
          reply = `📋 ${result.card.summary}\n${fields}\n\n👉 Confirma en la app para ejecutar.`;
        } else {
          reply = '✅ Procesado.';
        }

        // Send reply via WhatsApp
        if (WA_TOKEN && reply) {
          fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: from,
              type: 'text',
              text: { body: reply }
            })
          }).catch(() => {});
        }

        return c.json({ ok: true });
      }
    } catch (e) {
      console.error('[WA] Salon owner check failed:', e);
    }

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
    const systemPrompt = `Eres El Demonio, agente de ventas íntimo y persuasivo de ${salonNombre}. \nNunca eres agresivo. Hablas como un amigo de confianza que conoce el sector belleza.\nClasifica la intención del cliente en: INTERESADO, PRECIO, DUDA, NO_INTERESA, CITA_CONFIRMADA.\nResponde en 2-3 frases naturales, cálidas y directas. Nunca menciones que eres IA.\nDevuelve JSON: {\"intencion\":\"...\", \"respuesta\":\"...\"}`;

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


  // ─── Internal: Admin Panel Stats (Miguel — sin user auth, secret requerido) ─
  app.get('/api/internal/admin/panel', async (c) => {
    const secret   = c.req.query('secret') || c.req.header('x-admin-secret') || ''
    const expected = process.env.ADMIN_PANEL_SECRET
    if (!expected) return c.json({ error: 'Server misconfigured' }, 500)
    if (secret !== expected) return c.json({ error: 'Forbidden' }, 403)

    const SB_URL = process.env.SUPABASE_URL as string
    const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string

    const sb = (path: string) => fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: {
        'apikey':         SB_KEY,
        'Authorization':  `Bearer ${SB_KEY}`,
        'Content-Type':   'application/json',
      }
    }).then(r => r.json())

    try {
      const [salons, invoicesRaw, txRaw, leads, auditRaw] = await Promise.all([
        sb('salons?select=id,name,plan,is_active,onboarding_completed,created_at,pacto_activo&order=created_at.desc'),
        sb('invoices?select=status,total'),
        sb('transactions?select=type,amount'),
        sb('leads_b2b?select=id,nombre,sector,ciudad,telefono,estado,followup_count,ultima_contacto_at,created_at&order=created_at.desc&limit=50'),
        sb('audit_log?select=tool_name,created_at&order=created_at.desc&limit=20'),
      ])

      const safeArray = (v: any) => Array.isArray(v) ? v : []

      // Aggregate invoices by status
      const invMap: Record<string, {count:number,total:number}> = {}
      for (const inv of safeArray(invoicesRaw)) {
        const s = inv.status || 'unknown'
        if (!invMap[s]) invMap[s] = { count: 0, total: 0 }
        invMap[s].count++
        invMap[s].total += parseFloat(inv.total) || 0
      }
      const invoiceStats = Object.entries(invMap).map(([status, v]) => ({ status, ...v }))

      // Aggregate transactions by type
      const txMap: Record<string, {count:number,total:number}> = {}
      for (const tx of safeArray(txRaw)) {
        const t = tx.type || 'unknown'
        if (!txMap[t]) txMap[t] = { count: 0, total: 0 }
        txMap[t].count++
        txMap[t].total += parseFloat(tx.amount) || 0
      }
      const transactionStats = Object.entries(txMap).map(([type, v]) => ({ type, ...v }))

      const audit = safeArray(auditRaw).map((a: any) => ({
        action: a.tool_name,
        created_at: a.created_at,
      }))

      return c.json({ ok: true, salons: safeArray(salons), invoiceStats, transactionStats, leads: safeArray(leads), audit })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // ─── Protected Routes ──────────────────────────────────────────────────────
  app.use('/api/*', apiLimiter)
  app.use('/api/*', authMiddleware)
  app.route('/api/dashboard', dashboardRoutes)
  app.route('/api/dashboard/health-score', healthScoreRoutes)
  app.route('/api/clients', clientRoutes)
  app.route('/api/transactions', transactionRoutes)
  app.route('/api/invoices', invoiceRoutes)
  // ─── Numeración configurable de facturas ──────────────────────────────────────
  app.route('/api/invoice-numbering', invoiceNumberingRoutes)
  app.route('/api/agent/voice', voiceRoute)
  app.route('/api/agent/transcribe', transcribeRoute)
  app.route('/api/agent/tts', ttsRoute)
  app.route('/api/agent/brain', brainSettingsRoutes)
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
  app.route('/api/legal', legalRoutes)
  app.route('/api/pacto', pactoRoutes)
  app.route('/api/admin', adminRoutes)
  app.route('/api/albaranes', albaranRoute)
  app.route('/api/whatsapp', whatsappTemplatesRoutes)

  app.route('/api/leads-b2b', leadsB2bProtectedRoutes)
  app.route('/api/salons', salonsRoutes)   // ← Selector multiempresa

  // ─── Error Handling ────────────────────────────────────────────────────────
  app.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404))
  app.onError((err, c) => {
    console.error(`[ERROR] ${err.message}`, err)
    return c.json({ error: err.message || 'Internal Server Error' }, 500)
  })

  return app
}

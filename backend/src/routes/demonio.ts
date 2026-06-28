import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';

type Variables = { userId: string; salonId: string; userEmail: string; gestorId: string; usageWarning: boolean; salon_id: string }


const app = new Hono<{ Variables: Variables }>();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY!;
const WA_TOKEN      = process.env.WHATSAPP_ACCESS_TOKEN!;
const WA_PHONE_ID   = process.env.WHATSAPP_PHONE_NUMBER_ID!;
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN!;
const TG_CHAT       = process.env.TELEGRAM_CHAT_ID!;

// ─── Hermes 3 via OpenRouter ──────────────────────────────────────────────────
async function callHermes(systemPrompt: string, messages: any[]): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'nousresearch/hermes-3-llama-3.1-70b',
      max_tokens: 300,
      temperature: 0.75,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Enviar WhatsApp ──────────────────────────────────────────────────────────
async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/[^0-9]/g, ''),
        type: 'text',
        text: { body: text }
      })
    }
  );
  return res.ok;
}

// ─── Telegram alert ───────────────────────────────────────────────────────────
async function telegramAlert(msg: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' })
  });
}

// ─── Clasificar intención ─────────────────────────────────────────────────────
async function clasificarIntencion(
  mensajeUsuario: string,
  historial: any[],
  salonNombre: string
): Promise<{ intencion: string; respuesta: string }> {
  const system = `Eres El Demonio, agente de captación de clientes para "${salonNombre}", un salón de belleza/peluquería.
Tu misión: convertir leads fríos en citas.
Tono: cercano, natural, nunca agresivo ni de vendedor. Como un amigo que te recomienda un sitio bueno.
Responde SIEMPRE en español. Máximo 2-3 frases. Sin emojis excesivos.

Clasifica la intención en: INTERESADO | PRECIO | DUDA | NO_INTERESA | SILENCIO | CITA_CONFIRMADA

Responde en formato JSON estricto:
{"intencion": "INTERESADO", "respuesta": "Tu mensaje de respuesta aquí"}`;

  const msgs = [...historial.slice(-6), { role: 'user', content: mensajeUsuario }];

  try {
    const raw = await callHermes(system, msgs);
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { intencion: 'DUDA', respuesta: raw };
  } catch {
    return { intencion: 'DUDA', respuesta: '¡Hola! ¿En qué puedo ayudarte?' };
  }
}

// ─── GET /api/demonio/wa-verify  (Meta webhook challenge) ────────────────────
app.get('/wa-verify', (c) => {
  const mode      = c.req.query('hub.mode');
  const token     = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  const expected = process.env.WA_VERIFY_TOKEN;
  if (!expected) return c.text('Server misconfigured', 500);
  if (mode === 'subscribe' && token === expected) {
    return c.text(challenge || '', 200);
  }
  return c.text('Forbidden', 403);
});

// ─── POST /api/demonio/wa-callback  (webhook WhatsApp vía n8n) ───────────────
app.post('/wa-callback', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'bad json' }, 400); }

  const from    = (body.from    || body.wa_id || '').replace(/[^0-9]/g, '');
  const mensaje = body.message  || body.text  || '';
  const nombre  = body.nombre   || body.name  || 'Cliente';

  if (!from || !mensaje) return c.json({ ok: false, error: 'missing fields' }, 400);

  // Buscar lead
  let lead: any = null;
  try {
    const { data } = await supabase
      .from('pacto_leads')
      .select('*, pacto_campanas(salon_id, salons(nombre))')
      .eq('whatsapp', from)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    lead = data;
  } catch {}

  const salonNombre = lead?.pacto_campanas?.salons?.nombre || 'el salón';

  // Historial conversación
  let historial: any[] = [];
  if (lead) {
    try {
      const { data: msgs } = await supabase
        .from('demonio_conversaciones')
        .select('role, content')
        .eq('lead_id', lead.id)
        .order('created_at', { ascending: true })
        .limit(12);
      historial = msgs?.map(m => ({ role: m.role, content: m.content })) || [];
    } catch {}
  }

  // Clasificar y responder
  const { intencion, respuesta } = await clasificarIntencion(mensaje, historial, salonNombre);

  if (lead) {
    try {
      // Guardar historial
      await supabase.from('demonio_conversaciones').insert([
        { lead_id: lead.id, role: 'user',      content: mensaje   },
        { lead_id: lead.id, role: 'assistant', content: respuesta }
      ]);

      // Actualizar estado lead
      let nuevoEstado = lead.estado || 'contactado';
      if (intencion === 'INTERESADO' || intencion === 'PRECIO') nuevoEstado = 'respondio';
      if (intencion === 'CITA_CONFIRMADA')                       nuevoEstado = 'cita_agendada';
      if (intencion === 'NO_INTERESA')                           nuevoEstado = 'descartado';

      await supabase.from('pacto_leads').update({
        estado: nuevoEstado,
        ultima_respuesta_at: new Date().toISOString()
      }).eq('id', lead.id);

      // Alert si lead caliente
      if (intencion === 'INTERESADO' || intencion === 'CITA_CONFIRMADA') {
        await telegramAlert(
          `🔥 <b>Lead caliente — El Demonio</b>\n` +
          `Salón: ${salonNombre}\n` +
          `Lead: ${nombre} (+${from})\n` +
          `Intención: ${intencion}\n` +
          `Dice: "${mensaje.slice(0, 100)}"`
        );
      }
    } catch {}
  }

  // Responder por WhatsApp si no ha dicho que no
  if (intencion !== 'NO_INTERESA') {
    await sendWhatsApp(from, respuesta);
  }

  return c.json({ ok: true, intencion, respuesta });
});

// ─── GET /api/demonio/pipeline  (Kanban por salón) ───────────────────────────
app.get('/pipeline', async (c) => {
  const salonId = c.get('salonId');
  if (!salonId) return c.json({ ok: false, error: 'unauthorized' }, 401);

  try {
    const { data } = await supabase
      .from('pacto_leads')
      .select(`
        id, nombre, whatsapp, estado, created_at, ultima_respuesta_at, followup_count,
        pacto_campanas!inner(salon_id)
      `)
      .eq('pacto_campanas.salon_id', salonId)
      .order('ultima_respuesta_at', { ascending: false })
      .limit(200);

    const leads = data || [];
    const pipeline = {
      contactado:    leads.filter(l => l.estado === 'contactado'   || !l.estado),
      respondio:     leads.filter(l => l.estado === 'respondio'),
      cita_agendada: leads.filter(l => l.estado === 'cita_agendada'),
      descartado:    leads.filter(l => l.estado === 'descartado'),
    };

    return c.json({ ok: true, pipeline, total: leads.length });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ─── POST /api/demonio/internal-followup  (trigger schedule n8n) ─────────────
app.post('/internal-followup', async (c) => {
  const ahora = new Date();
  const hace3d = new Date(ahora.getTime() - 3 * 24 * 3600 * 1000).toISOString();

  let leads: any[] = [];
  try {
    const { data } = await supabase
      .from('pacto_leads')
      .select('*, pacto_campanas(salon_id, salons(nombre))')
      .in('estado', ['contactado', 'respondio'])
      .not('whatsapp', 'is', null)
      .or(`ultima_respuesta_at.lt.${hace3d},and(ultima_respuesta_at.is.null,created_at.lt.${hace3d})`);
    leads = data || [];
  } catch {}

  let enviados = 0;
  for (const lead of leads) {
    const refDate  = lead.ultima_respuesta_at || lead.created_at;
    const dias     = Math.floor((ahora.getTime() - new Date(refDate).getTime()) / (24 * 3600 * 1000));
    const salon    = lead.pacto_campanas?.salons?.nombre || 'nosotros';
    const followups = lead.followup_count || 0;

    if (followups >= 2) continue; // Max 2 follow-ups

    let msg = '';
    if (dias >= 7 && followups === 1) {
      msg = `Hola ${lead.nombre || ''} 👋 Entiendo que quizás no es el momento. Si algún día quieres pasarte por ${salon}, aquí estaremos. ¡Que te vaya bien!`;
    } else if (dias >= 3 && followups === 0) {
      msg = `Hola ${lead.nombre || ''}, ¿pudiste echarle un ojo? En ${salon} tenemos hueco esta semana — ¿te cuadra algún día?`;
    }

    if (msg) {
      await sendWhatsApp(lead.whatsapp, msg);
      try {
        await supabase.from('demonio_conversaciones').insert([
          { lead_id: lead.id, role: 'assistant', content: msg }
        ]);
        await supabase.from('pacto_leads').update({
          followup_count: followups + 1,
          ultima_respuesta_at: new Date().toISOString()
        }).eq('id', lead.id);
      } catch {}
      enviados++;
    }
  }

  return c.json({ ok: true, leads_procesados: leads.length, enviados });
});

export const demonioRoutes = app;

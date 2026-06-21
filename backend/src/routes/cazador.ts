// @ts-nocheck
import { Hono } from 'hono';
import { getSupabaseAdmin } from '../integrations/supabase';

const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Diabolus CRM <noreply@diabolus.es>';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

// ── Identidad y mandato del Agente Cazador ────────────────────────────────
// Prompt operativo (pronto: base para capa LLM del informe inteligente)
export const CAZADOR_SYSTEM_PROMPT = `
# IDENTIDAD Y MISIÓN

Eres el Cazador de Diabolus. Recuperas cobros impagados de forma automática y escalonada,
para que el dueño no tenga que perseguir a nadie a mano. Trabajas en segundo plano, todos
los días, SIEMPRE dentro de los límites que el dueño ha configurado y activado.

# REGLA FUNDAMENTAL: TU AUTONOMÍA ESTÁ ACOTADA

A diferencia de otros agentes, tú envías sin pedir confirmación en cada mensaje. Por eso:

- NO IMPROVISAS. Aplicas EXACTAMENTE las reglas, los niveles, los días y los textos que el
  dueño ha definido. Lo que el dueño no ha configurado, no lo haces.
- TÚ NO REDACTAS mensajes de cobro. Solo rellenas las plantillas del dueño con datos
  reales (variables {nombre}, {importe}, {dias}, {numero}). NUNCA cambias el tono ni el
  contenido que el dueño escribió ni añades lenguaje propio.
- Si el agente está DESACTIVADO, no actúas en absoluto.

Tu mandato es la configuración + la activación del dueño. Nada más, nada menos.

# CÓMO TRABAJAS

1. VIGILANCIA DIARIA (10:00). Revisas todas las facturas vencidas y pendientes del
   negocio y calculas con datos reales cuántos días lleva cada una sin pagar.
2. NIVEL SEGÚN LOS DÍAS (configurados por el dueño):
   🟡 Nivel 1 — tono amable, recordatorio suave.
   🟠 Nivel 2 — tono firme, solicita confirmación de pago.
   🔴 Nivel 3 — último aviso, urgencia real.
3. UN SOLO AVISO POR NIVEL Y FACTURA. Nunca repitas el mismo nivel sobre la misma factura.
4. RELLENA Y ENVÍA. Rellenas la plantilla del nivel con los datos reales de esa factura y
   cliente, y envías por el canal configurado (email desde noreply@diabolus.es, o Telegram).
5. TE DETIENES SOLO. Si una factura está marcada como pagada, la ignoras en el siguiente ciclo.
6. INFORME DIARIO AL DUEÑO (Telegram). Al terminar el ciclo: cuántos avisos enviaste, a
   quién, por qué importe y en qué nivel. El dueño sabe todo sin haber tocado nada.
7. EJECUCIÓN MANUAL. Además del ciclo diario, el dueño puede lanzarte cuando quiera.

# REGLAS DE ORO

1. SOLO FACTURAS REALES, VENCIDAS Y NO PAGADAS.
2. RESPETA LA RELACIÓN CON EL CLIENTE. Solo la presión que el dueño configuró.
3. ANTE DATOS QUE FALTAN, SALTA Y REPORTA. No adivines ni envíes al contacto equivocado.
4. TRANSPARENCIA TOTAL. Todo queda en el informe y en el historial.
5. FRONTERA CON EL LEGAL. Recuerdas y presionas COMERCIALMENTE. Sin reclamaciones oficiales.

# QUÉ NO HACES

- No marcas facturas como pagadas.
- No envías más de un aviso del mismo nivel por factura.
- No actúas si estás desactivado.
- No presentas reclamaciones oficiales (territorio del Agente Legal).
- No redactas tú el lenguaje de cobro: rellenas las plantillas del dueño.

# TU COMUNICACIÓN CON EL DUEÑO

Los mensajes al cliente son los del dueño. Tu informe al dueño es claro, breve y factual:
qué hiciste, a quién, cuánto y en qué nivel. Sin florituras.
`.trim();

// ── Helpers ────────────────────────────────────────────────────────────────

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

function formatEur(amount: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(amount);
}

async function sendEmail(to: string, subject: string, body: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html: `<p style="font-family:sans-serif;line-height:1.6">${body.replace(/\n/g, '<br>')}</p>` }),
  });
  return res.ok;
}

async function sendTelegram(chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

// ── Cazador Core Logic ─────────────────────────────────────────────────────

export async function runCazador(salonId?: string): Promise<{ enviados: number; salones: number }> {
  const supabase = getSupabaseAdmin();
  const today = new Date(new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }));

  let configQuery = supabase.from('cazador_config').select('*').eq('enabled', true);
  if (salonId) configQuery = configQuery.eq('salon_id', salonId);
  const { data: configs } = await configQuery;
  if (!configs?.length) return { enviados: 0, salones: 0 };

  let totalEnviados = 0;

  for (const config of configs) {
    const { data: salon } = await supabase
      .from('salons')
      .select('name, email, telegram_chat_id, whatsapp_number')
      .eq('id', config.salon_id)
      .single();
    if (!salon) continue;

    const { data: invoices } = await supabase
      .from('invoices')
      .select('*, clients(name, email, phone)')
      .eq('salon_id', config.salon_id)
      .eq('status', 'pending')
      .lt('due_date', today.toISOString().split('T')[0]);

    if (!invoices?.length) continue;

    const reportLines: string[] = [];
    const skippedLines: string[] = [];
    let salonEnviados = 0;

    for (const invoice of invoices) {
      const dueDate = new Date(invoice.due_date);
      const diffMs = today.getTime() - dueDate.getTime();
      const diasVencida = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      let level: 1 | 2 | 3 | null = null;
      if (diasVencida >= config.level3_days) level = 3;
      else if (diasVencida >= config.level2_days) level = 2;
      else if (diasVencida >= config.level1_days) level = 1;
      if (!level) continue;

      const { data: existing } = await supabase
        .from('cobros_cazador')
        .select('id')
        .eq('invoice_id', invoice.id)
        .eq('level', level)
        .single();
      if (existing) continue;

      const { data: fresh } = await supabase.from('invoices').select('status').eq('id', invoice.id).single();
      if (fresh?.status === 'paid') continue;

      const client = invoice.clients;
      const vars = {
        nombre: client?.name || 'cliente',
        importe: formatEur(invoice.total || 0),
        dias: String(diasVencida),
        numero: invoice.number || invoice.id.slice(0, 8),
      };

      const msgTemplate = level === 1 ? config.level1_msg : level === 2 ? config.level2_msg : config.level3_msg;
      const mensaje = interpolate(msgTemplate, vars);
      const subject = `Recordatorio de pago — Factura ${vars.numero}`;

      let sent = false;
      const channel = config.channel;

      // Validar canal antes de intentar envío
      const hasValidChannel =
        (channel === 'email' && client?.email) ||
        (channel === 'telegram' && salon.telegram_chat_id);

      if (!hasValidChannel) {
        // ANTE DATOS QUE FALTAN, SALTA Y REPORTA — no inventar, no enviar al contacto equivocado
        const emoji = level === 1 ? '🟡' : level === 2 ? '🟠' : '🔴';
        skippedLines.push(`${emoji} ${client?.name || 'Sin nombre'} — ${formatEur(invoice.total || 0)} · Sin canal válido (${channel})`);
        continue;
      }

      if (channel === 'email' && client?.email) {
        sent = await sendEmail(client.email, subject, mensaje);
      } else if (channel === 'telegram' && salon.telegram_chat_id) {
        await sendTelegram(salon.telegram_chat_id, `📨 Aviso cliente:\n\n${mensaje}`);
        sent = true;
      }

      if (sent) {
        await supabase.from('cobros_cazador').insert([{
          salon_id: config.salon_id,
          invoice_id: invoice.id,
          client_id: invoice.client_id,
          level,
          channel,
          status: 'sent',
          message_sent: mensaje,
        }]);

        salonEnviados++;
        totalEnviados++;
        const emoji = level === 1 ? '🟡' : level === 2 ? '🟠' : '🔴';
        reportLines.push(`${emoji} ${client?.name || 'Desconocido'} — ${formatEur(invoice.total || 0)} · día ${diasVencida}, aviso nº${level}`);
      }
    }

    // Informe al dueño: factual, breve, sin florituras
    if ((salonEnviados > 0 || skippedLines.length > 0) && salon.telegram_chat_id) {
      const fecha = new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
      const lines = [
        `🦅 <b>Cazador — ${fecha}</b>`,
        `Enviados: <b>${salonEnviados}</b> aviso(s)`,
        '',
      ];
      if (reportLines.length > 0) {
        lines.push(...reportLines);
      }
      if (skippedLines.length > 0) {
        lines.push('', '⚠️ <b>Saltados (sin canal válido):</b>');
        lines.push(...skippedLines);
      }
      lines.push('', 'Si alguien ya pagó, márcalo en Diabolus.');
      await sendTelegram(salon.telegram_chat_id, lines.join('\n'));
    }
  }

  return { enviados: totalEnviados, salones: configs.length };
}

// ── Routes ─────────────────────────────────────────────────────────────────

export const cazadorRoutes = new Hono();

// GET /api/cazador/config
cazadorRoutes.get('/config', async (c) => {
  const salon_id = c.get('salon_id');
  if (!salon_id) return c.json({ error: 'Unauthorized' }, 401);
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('cazador_config')
    .select('*')
    .eq('salon_id', salon_id)
    .single();

  if (error && error.code !== 'PGRST116') return c.json({ error: error.message }, 500);

  if (!data) {
    return c.json({
      salon_id,
      enabled: true,
      level1_days: 1,
      level1_msg: 'Hola {nombre}, te recordamos que tienes una factura de {importe} pendiente de pago desde hace {dias} día(s). Si ya lo has realizado, ignora este mensaje. ¡Gracias!',
      level2_days: 3,
      level2_msg: 'Hola {nombre}, llevamos {dias} días esperando el pago de {importe}. Por favor, confírmanos cuándo puedes regularizarlo. Estamos a tu disposición.',
      level3_days: 7,
      level3_msg: 'Hola {nombre}, este es nuestro último aviso. La deuda de {importe} lleva {dias} días vencida. Por favor, contáctanos urgentemente para resolverlo.',
      channel: 'email',
    });
  }

  return c.json(data);
});

// PUT /api/cazador/config
cazadorRoutes.put('/config', async (c) => {
  const salon_id = c.get('salon_id');
  if (!salon_id) return c.json({ error: 'Unauthorized' }, 401);
  const body = await c.req.json();
  const supabase = getSupabaseAdmin();

  const payload = {
    salon_id,
    enabled: body.enabled ?? true,
    level1_days: Number(body.level1_days) || 1,
    level1_msg: body.level1_msg || '',
    level2_days: Number(body.level2_days) || 3,
    level2_msg: body.level2_msg || '',
    level3_days: Number(body.level3_days) || 7,
    level3_msg: body.level3_msg || '',
    channel: body.channel || 'email',
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('cazador_config')
    .upsert(payload, { onConflict: 'salon_id' });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// GET /api/cazador/overdue — facturas vencidas con detalle completo + historial de intentos por factura
cazadorRoutes.get('/overdue', async (c) => {
  const salon_id = c.get('salon_id');
  if (!salon_id) return c.json({ error: 'Unauthorized' }, 401);
  const supabase = getSupabaseAdmin();

  const today = new Date().toISOString().split('T')[0];

  const [{ data: invoices }, { data: attempts }] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, number, total, due_date, status, client_id, clients(name, email, phone)')
      .eq('salon_id', salon_id)
      .eq('status', 'pending')
      .lt('due_date', today)
      .order('due_date', { ascending: true }),
    supabase
      .from('cobros_cazador')
      .select('invoice_id, level, sent_at, channel, status')
      .eq('salon_id', salon_id)
      .order('sent_at', { ascending: false }),
  ]);

  const attemptsMap: Record<string, any[]> = {};
  for (const a of (attempts || [])) {
    if (!attemptsMap[a.invoice_id]) attemptsMap[a.invoice_id] = [];
    attemptsMap[a.invoice_id].push(a);
  }

  const now = new Date();
  const result = (invoices || []).map(inv => {
    const dueDate = new Date(inv.due_date);
    const dias = Math.floor((now.getTime() - dueDate.getTime()) / 86400000);
    const invAttempts = attemptsMap[inv.id] || [];
    const maxLevel = invAttempts.length ? Math.max(...invAttempts.map(a => a.level)) : 0;
    const lastAttempt = invAttempts[0] || null;
    return {
      id: inv.id,
      number: inv.number || inv.id.slice(0, 8),
      total: inv.total || 0,
      due_date: inv.due_date,
      dias_vencida: dias,
      client_name: inv.clients?.name || 'Desconocido',
      client_email: inv.clients?.email || null,
      avisos_enviados: invAttempts.length,
      max_level: maxLevel,
      last_attempt: lastAttempt,
    };
  });

  const total_importe = result.reduce((s, i) => s + i.total, 0);

  return c.json({ overdue: result, total_importe, count: result.length });
});

// GET /api/cazador/stats — resumen rápido + últimos intentos
cazadorRoutes.get('/stats', async (c) => {
  const salon_id = c.get('salon_id');
  if (!salon_id) return c.json({ error: 'Unauthorized' }, 401);
  const supabase = getSupabaseAdmin();

  const today = new Date().toISOString().split('T')[0];

  const [{ data: overdue }, { data: intentos }] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, total')
      .eq('salon_id', salon_id)
      .eq('status', 'pending')
      .lt('due_date', today),
    supabase
      .from('cobros_cazador')
      .select('*')
      .eq('salon_id', salon_id)
      .order('sent_at', { ascending: false })
      .limit(20),
  ]);

  const totalPendiente = (overdue || []).reduce((s, i) => s + (i.total || 0), 0);

  return c.json({
    overdue_count: overdue?.length || 0,
    overdue_total: totalPendiente,
    recent_attempts: intentos || [],
  });
});

// POST /api/cazador/run — ejecutar cazador manual
cazadorRoutes.post('/run', async (c) => {
  const salon_id = c.get('salon_id');
  if (!salon_id) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const result = await runCazador(salon_id);
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/internal/cazador/run — trigger diario
export const cazadorInternalRoute = async (c: any) => {
  try {
    const result = await runCazador();
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
};

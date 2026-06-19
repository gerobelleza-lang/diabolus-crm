// @ts-nocheck
import { Hono } from 'hono';
import { getSupabaseAdmin } from '../integrations/supabase';

const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Diabolus CRM <noreply@diabolus.es>';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

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
        reportLines.push(`${emoji} ${client?.name || 'Desconocido'} — ${formatEur(invoice.total || 0)} (día ${diasVencida}, aviso nº${level})`);
      }
    }

    if (salonEnviados > 0 && salon.telegram_chat_id) {
      const report = [
        `🦅 <b>Agente Cazador — ${new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })}</b>`,
        `Hoy envié <b>${salonEnviados}</b> aviso(s) de cobro:`,
        '',
        ...reportLines,
        '',
        '✅ Si algún cliente ya ha pagado, márcalo en Diabolus para que el Cazador se calle.',
      ].join('\n');
      await sendTelegram(salon.telegram_chat_id, report);
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

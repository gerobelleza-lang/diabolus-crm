/**
 * contact.ts — Formulario de contacto landing
 * Recibe nombre, email, mensaje → guarda en Supabase + alerta Telegram a Miguel
 */
import { Hono } from 'hono';

const contact = new Hono();

contact.post('/submit', async (c) => {
  try {
    const { nombre, email, mensaje } = await c.req.json();

    if (!nombre || !email || !mensaje) {
      return c.json({ ok: false, error: 'Faltan campos obligatorios' }, 400);
    }

    // Email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ ok: false, error: 'Email no válido' }, 400);
    }

    // Sanitize
    const clean = {
      nombre: String(nombre).slice(0, 100).trim(),
      email: String(email).slice(0, 200).trim().toLowerCase(),
      mensaje: String(mensaje).slice(0, 2000).trim(),
    };

    // Save to Supabase
    const env = (c.env || {}) as Record<string, string | undefined>;
    const proc = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;
    const sbUrl = env.SUPABASE_URL || proc.SUPABASE_URL;
    const sbKey = env.SUPABASE_SERVICE_ROLE_KEY || proc.SUPABASE_SERVICE_ROLE_KEY;

    if (sbUrl && sbKey) {
      await fetch(`${sbUrl}/rest/v1/contact_messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': sbKey,
          'Authorization': `Bearer ${sbKey}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          nombre: clean.nombre,
          email: clean.email,
          mensaje: clean.mensaje,
          created_at: new Date().toISOString(),
        }),
      });
    }

    // Telegram alert to Miguel
    const tgToken = env.TELEGRAM_BOT_TOKEN || proc.TELEGRAM_BOT_TOKEN;
    const chatId = '8356150792';

    if (tgToken) {
      const text = [
        '📩 *Nuevo mensaje de contacto*',
        '',
        `👤 *Nombre:* ${clean.nombre}`,
        `📧 *Email:* ${clean.email}`,
        '',
        `💬 *Mensaje:*`,
        clean.mensaje,
        '',
        `🕐 ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`,
      ].join('\n');

      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
        }),
      });
    }

    return c.json({ ok: true, msg: 'Mensaje enviado. Te responderemos lo antes posible.' });
  } catch (err: any) {
    console.error('[contact] Error:', err);
    return c.json({ ok: false, error: 'Error interno' }, 500);
  }
});

export default contact;

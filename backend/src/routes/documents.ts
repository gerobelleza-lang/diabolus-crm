// @ts-nocheck
import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';

const FRONTEND_URL = 'https://gerobelleza-lang.github.io/diabolus-crm';
const FROM_EMAIL   = 'Diabolus CRM <noreply@diabolus.es>';
const RESEND_KEY   = process.env.RESEND_API_KEY!;

// ── Supabase admin client ──────────────────────────────────────────────────
function sb() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// ── SHA-256 via Web Crypto API (Edge compatible) ───────────────────────────
async function sha256hex(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── base64 → ArrayBuffer ───────────────────────────────────────────────────
function b64toBuffer(b64: string): ArrayBuffer {
  const raw = b64.includes(',') ? b64.split(',')[1] : b64;
  const bin = atob(raw);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ── Resend email helper ────────────────────────────────────────────────────
async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  attachments?: { filename: string; content: string }[];
}) {
  const body: any = {
    from: FROM_EMAIL,
    to: [opts.to],
    subject: opts.subject,
    html: opts.html,
  };
  if (opts.attachments?.length) body.attachments = opts.attachments;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[Email] Error:', err);
  }
  return res.ok;
}

// ── Madrid timestamp ───────────────────────────────────────────────────────
function nowMadrid(): string {
  return new Date().toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ══════════════════════════════════════════════════════════════
// PUBLIC ROUTES — no auth required
// ══════════════════════════════════════════════════════════════
export const documentsPublicRoutes = new Hono();

// GET /api/documents/verify/:hash — verificar hash
documentsPublicRoutes.get('/:hash', async (c) => {
  const hash = c.req.param('hash');
  const { data, error } = await sb()
    .from('document_timestamps')
    .select('*, salons(name)')
    .eq('sha256_hash', hash)
    .order('stamped_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return c.json({ verified: false, message: 'Documento no encontrado en el registro Diabolus' });
  }

  return c.json({
    verified: true,
    certificate_id: data.id,
    document_name: data.document_name,
    hash: data.sha256_hash,
    stamped_at: data.stamped_at,
    stamped_at_madrid: new Date(data.stamped_at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }),
    document_type: data.document_type,
    salon_name: data.salons?.name ?? '—',
    level: data.level,
    level_label: data.level === 1 ? 'Sellado de tiempo SHA-256' : 'Firma electrónica avanzada (Firmafiy)',
    status: data.status ?? 'draft',
    client_name: data.client_name,
    client_signed_at: data.client_signed_at,
  });
});

// POST /api/documents/verify — verificar subiendo archivo
documentsPublicRoutes.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { document_base64 } = body;
    if (!document_base64) return c.json({ error: 'document_base64 requerido' }, 400);

    const hash = await sha256hex(b64toBuffer(document_base64));

    const { data, error } = await sb()
      .from('document_timestamps')
      .select('*, salons(name)')
      .eq('sha256_hash', hash)
      .order('stamped_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      return c.json({ verified: false, hash, message: 'Este documento no tiene sellado de tiempo en Diabolus' });
    }

    return c.json({
      verified: true,
      certificate_id: data.id,
      document_name: data.document_name,
      hash: data.sha256_hash,
      stamped_at: data.stamped_at,
      stamped_at_madrid: new Date(data.stamped_at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }),
      document_type: data.document_type,
      salon_name: data.salons?.name ?? '—',
      level: data.level,
      level_label: data.level === 1 ? 'Sellado de tiempo SHA-256' : 'Firma electrónica avanzada (Firmafiy)',
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/documents/sign/:token — datos para página de firma del cliente (público)
documentsPublicRoutes.get('/sign/:token', async (c) => {
  const token = c.req.param('token');
  const { data, error } = await sb()
    .from('document_timestamps')
    .select('id, status, document_name, document_type, contract_data, salon_signature_data, client_name, client_email, stamped_at, created_at')
    .eq('signing_token', token)
    .maybeSingle();

  if (error || !data) {
    return c.json({ error: 'Enlace de firma no válido o expirado' }, 404);
  }

  if (data.status === 'completed') {
    return c.json({ already_signed: true, document_name: data.document_name });
  }

  return c.json({
    document_id: data.id,
    document_name: data.document_name,
    document_type: data.document_type,
    contract_data: data.contract_data,
    salon_signature_data: data.salon_signature_data,
    client_name: data.client_name,
    client_email: data.client_email,
    created_at: data.created_at,
  });
});

// POST /api/documents/client-sign — cliente firma (público)
documentsPublicRoutes.post('/client-sign', async (c) => {
  try {
    const body = await c.req.json();
    const { token, client_signature_data, pdf_base64 } = body;

    if (!token || !client_signature_data || !pdf_base64) {
      return c.json({ error: 'Faltan campos: token, client_signature_data, pdf_base64' }, 400);
    }

    const supabase = sb();

    // Buscar documento por token
    const { data: doc, error: findErr } = await supabase
      .from('document_timestamps')
      .select('*')
      .eq('signing_token', token)
      .maybeSingle();

    if (findErr || !doc) {
      return c.json({ error: 'Token no válido' }, 404);
    }
    if (doc.status === 'completed') {
      return c.json({ error: 'Este contrato ya fue firmado', already_signed: true }, 409);
    }

    // SHA-256 del PDF bilateral
    const pdfBuf = b64toBuffer(pdf_base64);
    const hash = await sha256hex(pdfBuf);
    const stamped_at = new Date().toISOString();

    // Subir PDF bilateral a Storage
    const pdfBytes = new Uint8Array(pdfBuf);
    const filePath = `${doc.salon_id}/${doc.id}/contrato-bilateral.pdf`;
    await supabase.storage
      .from('legal-documents')
      .upload(filePath, pdfBytes, { contentType: 'application/pdf', upsert: true });

    // Actualizar documento
    const { error: updateErr } = await supabase
      .from('document_timestamps')
      .update({
        status: 'completed',
        sha256_hash: hash,
        stamped_at,
        client_signature_data,
        client_signed_at: stamped_at,
        file_path: filePath,
        level: 1,
      })
      .eq('id', doc.id);

    if (updateErr) throw updateErr;

    // Audit log
    await supabase.from('audit_log').insert([{
      salon_id: doc.salon_id,
      tool_name: 'bilateral_sign',
      payload: { document_name: doc.document_name, hash, client_email: doc.client_email },
      result: { certificate_id: doc.id },
      confirmed: true,
      level: 0,
      created_at: stamped_at,
    }]);

    const verifyUrl = `${FRONTEND_URL}/verify.html?hash=${hash}`;
    const stamped_at_madrid = new Date(stamped_at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

    // ── Emails con PDF adjunto ──────────────────────────────────────────────
    const pdfAttachment = [{ filename: (doc.document_name || 'contrato') + '.pdf', content: pdf_base64 }];

    const sharedHtmlFooter = `
      <p style="margin-top:24px;font-size:13px;color:#888;">
        🔍 Verifica la integridad del documento en cualquier momento:<br>
        <a href="${verifyUrl}" style="color:#8B5CF6;">${verifyUrl}</a>
      </p>
      <p style="font-size:12px;color:#aaa;margin-top:16px;">
        Diabolus CRM · Sellado SHA-256 · Fecha: ${stamped_at_madrid}
      </p>`;

    const clientHtml = `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:#15101F;padding:20px;border-radius:12px 12px 0 0;">
          <span style="color:#8B5CF6;font-size:20px;font-weight:800;">DIABOLUS</span>
          <span style="color:#E3BE7A;font-size:12px;margin-left:8px;">Contratos digitales</span>
        </div>
        <div style="background:#f9f9f9;padding:24px;border-radius:0 0 12px 12px;">
          <h2 style="color:#15101F;margin-bottom:8px;">✅ Contrato firmado correctamente</h2>
          <p>Hola <strong>${doc.client_name || 'cliente'}</strong>,</p>
          <p>Adjunto encontrarás el contrato firmado por ambas partes: <strong>${doc.document_name}</strong>.</p>
          <p>El documento ha sido sellado con SHA-256 — su integridad es verificable en cualquier momento.</p>
          ${sharedHtmlFooter}
        </div>
      </div>`;

    // Email al cliente
    if (doc.client_email) {
      await sendEmail({
        to: doc.client_email,
        subject: `✅ Contrato firmado — ${doc.document_name}`,
        html: clientHtml,
        attachments: pdfAttachment,
      });
    }

    // Email al salón
    if (doc.salon_email) {
      const salonHtml = `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <div style="background:#15101F;padding:20px;border-radius:12px 12px 0 0;">
            <span style="color:#8B5CF6;font-size:20px;font-weight:800;">DIABOLUS</span>
            <span style="color:#E3BE7A;font-size:12px;margin-left:8px;">Contratos digitales</span>
          </div>
          <div style="background:#f9f9f9;padding:24px;border-radius:0 0 12px 12px;">
            <h2 style="color:#15101F;margin-bottom:8px;">✅ Tu cliente ha firmado el contrato</h2>
            <p><strong>${doc.client_name || 'El cliente'}</strong> ha firmado el contrato <strong>${doc.document_name}</strong>.</p>
            <p>Adjunto encontrarás el PDF con ambas firmas sellado digitalmente.</p>
            ${sharedHtmlFooter}
          </div>
        </div>`;

      await sendEmail({
        to: doc.salon_email,
        subject: `✅ ${doc.client_name || 'Cliente'} firmó el contrato — ${doc.document_name}`,
        html: salonHtml,
        attachments: pdfAttachment,
      });
    }

    return c.json({
      success: true,
      hash,
      stamped_at,
      stamped_at_madrid,
      verify_url: verifyUrl,
      document_name: doc.document_name,
    });

  } catch (err: any) {
    console.error('[client-sign]', err);
    return c.json({ error: err.message }, 500);
  }
});


// ══════════════════════════════════════════════════════════════
// PROTECTED ROUTES — requiere auth JWT (aplicado en app.ts)
// ══════════════════════════════════════════════════════════════
export const documentsRoutes = new Hono();

// POST /api/documents/stamp — sellado simple (flujo antiguo, compatible)
documentsRoutes.post('/stamp', async (c) => {
  try {
    const body = await c.req.json();
    const {
      document_name,
      document_base64,
      document_type = 'general',
      parties = [],
      salon_id,
      metadata = {},
    } = body;

    if (!document_name || !document_base64 || !salon_id) {
      return c.json({ error: 'Faltan campos: document_name, document_base64, salon_id' }, 400);
    }

    const buf = b64toBuffer(document_base64);
    const hash = await sha256hex(buf);
    const certificate_id = crypto.randomUUID();
    const stamped_at = new Date().toISOString();

    const supabase = sb();

    const bytes = new Uint8Array(buf);
    const filePath = `${salon_id}/${certificate_id}/${document_name}`;
    await supabase.storage
      .from('legal-documents')
      .upload(filePath, bytes, { contentType: 'application/octet-stream', upsert: false });

    const { data, error } = await supabase
      .from('document_timestamps')
      .insert({
        id: certificate_id,
        salon_id,
        document_name,
        sha256_hash: hash,
        stamped_at,
        level: 1,
        document_type,
        parties,
        metadata,
        file_path: filePath,
        status: 'draft',
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from('audit_log').insert([{
      salon_id,
      tool_name: 'stamp_document',
      payload: { document_name, hash, document_type },
      result: { certificate_id },
      confirmed: true,
      level: 0,
      created_at: stamped_at,
    }]);

    const { data: salon } = await supabase.from('salons').select('name').eq('id', salon_id).single();

    return c.json({
      success: true,
      certificate_id,
      hash,
      stamped_at,
      stamped_at_madrid: new Date(stamped_at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }),
      document_name,
      document_type,
      salon_name: salon?.name ?? '—',
      level: 1,
      level_label: 'Sellado de tiempo SHA-256',
      verify_url: `${FRONTEND_URL}/verify.html?hash=${hash}`,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/documents/send — enviar contrato al cliente para firma bilateral
documentsRoutes.post('/send', async (c) => {
  try {
    const body = await c.req.json();
    const {
      salon_id,
      document_name,
      document_type = 'general',
      contract_data,        // objeto con todos los campos del formulario
      salon_signature_data, // base64 PNG de la firma del salón
      salon_email,          // email del suscriptor (salón)
      client_email,
      client_name,
    } = body;

    if (!salon_id || !document_name || !contract_data || !salon_signature_data || !client_email) {
      return c.json({ error: 'Faltan campos: salon_id, document_name, contract_data, salon_signature_data, client_email' }, 400);
    }

    const supabase = sb();
    const document_id = crypto.randomUUID();
    const signing_token = crypto.randomUUID();
    const created_at = new Date().toISOString();

    // Insertar documento en estado pending_client
    const { error: insertErr } = await supabase
      .from('document_timestamps')
      .insert({
        id: document_id,
        salon_id,
        document_name,
        sha256_hash: 'pending-' + document_id, // provisional, se actualizará al completar
        stamped_at: created_at,
        level: 1,
        document_type,
        parties: [{ role: 'salon', email: salon_email }, { role: 'client', name: client_name, email: client_email }],
        metadata: {},
        status: 'pending_client',
        signing_token,
        salon_email,
        client_email,
        client_name,
        salon_signature_data,
        contract_data,
        created_at,
      });

    if (insertErr) throw insertErr;

    const signing_url = `${FRONTEND_URL}/sign.html?token=${signing_token}`;

    // Email al cliente con enlace de firma
    const clientInviteHtml = `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:#15101F;padding:20px;border-radius:12px 12px 0 0;">
          <span style="color:#8B5CF6;font-size:20px;font-weight:800;">DIABOLUS</span>
          <span style="color:#E3BE7A;font-size:12px;margin-left:8px;">Contratos digitales</span>
        </div>
        <div style="background:#f9f9f9;padding:24px;border-radius:0 0 12px 12px;">
          <h2 style="color:#15101F;margin-bottom:8px;">📋 Tienes un contrato pendiente de firma</h2>
          <p>Hola <strong>${client_name || 'cliente'}</strong>,</p>
          <p><strong>${contract_data?.prov_nombre || 'Tu proveedor'}</strong> te ha enviado el siguiente documento para que lo firmes:</p>
          <p style="font-weight:bold;font-size:16px;margin:16px 0;color:#15101F;">
            ${document_name}
          </p>
          <p>Puedes leer el contrato completo y firmarlo con tu dedo o ratón haciendo clic aquí:</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${signing_url}"
               style="background:#8B5CF6;color:#fff;padding:14px 32px;border-radius:10px;
                      text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
              ✍️ Ver y firmar contrato
            </a>
          </div>
          <p style="font-size:13px;color:#888;">
            O copia este enlace en tu navegador:<br>
            <a href="${signing_url}" style="color:#8B5CF6;word-break:break-all;">${signing_url}</a>
          </p>
          <p style="font-size:12px;color:#aaa;margin-top:16px;">
            Este enlace es personal e intransferible.<br>
            Diabolus CRM — firma digital con sellado SHA-256
          </p>
        </div>
      </div>`;

    await sendEmail({
      to: client_email,
      subject: `✍️ ${contract_data?.prov_nombre || 'Tu proveedor'} te envía un contrato para firmar`,
      html: clientInviteHtml,
    });

    // Audit
    await supabase.from('audit_log').insert([{
      salon_id,
      tool_name: 'send_document_for_sign',
      payload: { document_name, client_email, client_name },
      result: { document_id, signing_token },
      confirmed: true,
      level: 0,
      created_at,
    }]);

    return c.json({
      success: true,
      document_id,
      signing_url,
      client_email,
      message: `Enlace de firma enviado a ${client_email}`,
    });

  } catch (err: any) {
    console.error('[send]', err);
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/documents — listar documentos del salón (todos los estados)
documentsRoutes.get('/', async (c) => {
  const salon_id = c.req.query('salon_id');
  if (!salon_id) return c.json({ error: 'salon_id requerido' }, 400);

  const { data, error } = await sb()
    .from('document_timestamps')
    .select('id, document_name, sha256_hash, stamped_at, level, document_type, parties, metadata, status, client_name, client_signed_at')
    .eq('salon_id', salon_id)
    .order('stamped_at', { ascending: false });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ documents: data ?? [] });
});

// GET /api/documents/:id
documentsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const { data, error } = await sb()
    .from('document_timestamps')
    .select('*, salons(name)')
    .eq('id', id)
    .single();

  if (error || !data) return c.json({ error: 'No encontrado' }, 404);
  return c.json(data);
});

// GET /api/documents/:id/download — signed URL 15 min
documentsRoutes.get('/:id/download', async (c) => {
  const id = c.req.param('id');
  const { data: doc } = await sb()
    .from('document_timestamps')
    .select('file_path')
    .eq('id', id)
    .single();

  if (!doc?.file_path) return c.json({ error: 'Archivo no encontrado' }, 404);

  const { data: signedUrl, error } = await sb()
    .storage
    .from('legal-documents')
    .createSignedUrl(doc.file_path, 900); // 15 min

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ url: signedUrl.signedUrl });
});

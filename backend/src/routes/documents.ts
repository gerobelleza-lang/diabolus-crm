// @ts-nocheck
import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';

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

// ── base64 → ArrayBuffer (Edge compatible) ────────────────────────────────
function b64toBuffer(b64: string): ArrayBuffer {
  // strip data-url prefix if present
  const raw = b64.includes(',') ? b64.split(',')[1] : b64;
  const bin = atob(raw);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
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
// ROUTERS
// ══════════════════════════════════════════════════════════════

// PUBLIC — verificación sin auth
export const documentsPublicRoutes = new Hono();

// GET /api/documents/verify/:hash
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
  });
});

// POST /api/documents/verify  (subir archivo para verificar)
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


// PROTECTED — requiere auth (aplicado en app.ts)
export const documentsRoutes = new Hono();

// POST /api/documents/stamp
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

    // Subir archivo a Storage
    const bytes = new Uint8Array(buf);
    const filePath = `${salon_id}/${certificate_id}/${document_name}`;
    await supabase.storage
      .from('legal-documents')
      .upload(filePath, bytes, { contentType: 'application/octet-stream', upsert: false });

    // Guardar registro
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
      })
      .select()
      .single();

    if (error) throw error;

    // Audit log
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
      verify_url: `https://gerobelleza-lang.github.io/diabolus-crm/verify.html?hash=${hash}`,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/documents?salon_id=xxx
documentsRoutes.get('/', async (c) => {
  const salon_id = c.req.query('salon_id');
  if (!salon_id) return c.json({ error: 'salon_id requerido' }, 400);

  const { data, error } = await sb()
    .from('document_timestamps')
    .select('id, document_name, sha256_hash, stamped_at, level, document_type, parties, metadata')
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

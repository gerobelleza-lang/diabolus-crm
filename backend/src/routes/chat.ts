/**
 * chat.ts — Bloque B3: Chat gestor↔cliente — lado cliente (salon JWT)
 *
 * Montado en /api/chat/* (requiere authMiddleware — salon JWT)
 *
 *   GET  /api/chat/threads              — hilos activos del salon (lista de gestores vinculados)
 *   GET  /api/chat/thread/:gestorId     — mensajes del hilo con ese gestor
 *   POST /api/chat/thread/:gestorId     — enviar mensaje (text + optional file)
 *   POST /api/chat/thread/:gestorId/read — marcar mensajes del gestor como leídos
 *   GET  /api/chat/attachment/:msgId    — URL firmada del adjunto (5 min)
 *   GET  /api/chat/unread               — total mensajes no leídos (para badge)
 */

import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'
import { sendChatNotificationGestor } from '../integrations/email'

type Variables = { userId: string; salonId: string; userEmail: string; gestorId: string; usageWarning: boolean; salon_id: string }


export const chatRoutes = new Hono<{ Variables: Variables }>()

// ─── Constantes de validación ──────────────────────────────────────────────────
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',     // xlsx
  'application/vnd.ms-excel',                                               // xls
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',// docx
  'application/msword',                                                      // doc
  'text/csv',
  'application/zip',
])
const SIGNED_URL_EXPIRY = 300 // 5 minutos

// ─── Helper: verificar vínculo activo salon↔gestor ────────────────────────────
async function assertActiveLink(supabase: any, salonId: string, gestorId: string) {
  const { data } = await supabase
    .from('gestor_salon_links')
    .select('id')
    .eq('gestor_id', gestorId)
    .eq('salon_id', salonId)
    .eq('status', 'active')
    .single()
  return data ? data.id : null
}

// ─── GET /api/chat/threads ────────────────────────────────────────────────────
chatRoutes.get('/threads', async (c) => {
  const salonId = c.get('salon_id')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()

  const { data: links } = await supabase
    .from('gestor_salon_links')
    .select('gestor_id, gestores(id, name, company_name, email)')
    .eq('salon_id', salonId)
    .eq('status', 'active')

  if (!links?.length) return c.json({ ok: true, threads: [] })

  // Para cada gestor, buscar el último mensaje y el count de no leídos
  const threads = await Promise.all(
    (links ?? []).map(async (l: any) => {
      const gestorId = l.gestor_id
      const gestor = l.gestores

      const [{ data: lastMsg }, { count: unread }] = await Promise.all([
        supabase
          .from('gestor_messages')
          .select('content, sender, created_at')
          .eq('salon_id', salonId)
          .eq('gestor_id', gestorId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('gestor_messages')
          .select('id', { count: 'exact' })
          .eq('salon_id', salonId)
          .eq('gestor_id', gestorId)
          .eq('sender', 'gestor')
          .is('read_at', null),
      ])

      return {
        gestor_id: gestorId,
        gestor_name: gestor?.name ?? 'Gestor',
        company_name: gestor?.company_name ?? null,
        last_message: lastMsg ?? null,
        unread_count: unread ?? 0,
      }
    })
  )

  return c.json({ ok: true, threads })
})

// ─── GET /api/chat/thread/:gestorId ──────────────────────────────────────────
chatRoutes.get('/thread/:gestorId', async (c) => {
  const salonId = c.get('salon_id')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

  const gestorId = c.req.param('gestorId')
  const supabase = getSupabaseAdmin()

  const linkId = await assertActiveLink(supabase, salonId, gestorId)
  if (!linkId) return c.json({ error: 'No hay vínculo activo con este gestor' }, 403)

  const { data: messages } = await supabase
    .from('gestor_messages')
    .select('id, sender, content, attachment, created_at, read_at')
    .eq('salon_id', salonId)
    .eq('gestor_id', gestorId)
    .order('created_at', { ascending: true })

  // Generar URLs firmadas para adjuntos
  const messagesWithUrls = await Promise.all(
    (messages ?? []).map(async (m: any) => {
      let attachment_url: string | null = null
      if (m.attachment?.storage_path) {
        const { data: signed } = await supabase.storage
          .from('chat-attachments')
          .createSignedUrl(m.attachment.storage_path, SIGNED_URL_EXPIRY)
        attachment_url = signed?.signedUrl ?? null
      }
      return { ...m, attachment_url }
    })
  )

  return c.json({ ok: true, messages: messagesWithUrls })
})

// ─── POST /api/chat/thread/:gestorId ─────────────────────────────────────────
chatRoutes.post('/thread/:gestorId', async (c) => {
  const salonId = c.get('salon_id')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

  const gestorId = c.req.param('gestorId')
  const supabase = getSupabaseAdmin()

  const linkId = await assertActiveLink(supabase, salonId, gestorId)
  if (!linkId) return c.json({ error: 'No hay vínculo activo con este gestor' }, 403)

  const contentType = c.req.header('Content-Type') ?? ''
  let body = ''
  let attachment: { storage_path: string; filename: string; mime: string; size: number } | null = null

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData()
    body = (form.get('body') as string) ?? ''
    const file = form.get('file') as File | null

    if (file && file.size > 0) {
      // Validar tipo
      if (!ALLOWED_MIMES.has(file.type)) {
        return c.json({ error: `Tipo de archivo no permitido: ${file.type}` }, 422)
      }
      // Validar tamaño
      if (file.size > MAX_FILE_SIZE) {
        return c.json({ error: `El archivo supera el límite de 10 MB` }, 422)
      }

      const fileId = crypto.randomUUID()
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const storagePath = `${gestorId}/${salonId}/${fileId}/${safeName}`

      const arrayBuffer = await file.arrayBuffer()
      const { error: uploadErr } = await supabase.storage
        .from('chat-attachments')
        .upload(storagePath, arrayBuffer, { contentType: file.type, upsert: false })

      if (uploadErr) {
        console.error('[Chat Upload]', uploadErr)
        return c.json({ error: 'Error subiendo adjunto' }, 500)
      }

      attachment = { storage_path: storagePath, filename: file.name, mime: file.type, size: file.size }
    }
  } else {
    const json = await c.req.json().catch(() => ({}))
    body = json.body ?? ''
  }

  if (!body.trim() && !attachment) {
    return c.json({ error: 'Se requiere body o adjunto' }, 400)
  }

  const { data: msg, error: insertErr } = await supabase
    .from('gestor_messages')
    .insert([{
      gestor_id: gestorId,
      salon_id: salonId,
      sender: 'client',
      content: body.trim() || null,
      attachment: attachment ?? null,
      created_at: new Date().toISOString(),
    }])
    .select('id, sender, content, attachment, created_at')
    .single()

  if (insertErr) {
    console.error('[Chat Insert]', insertErr)
    return c.json({ error: 'Error enviando mensaje' }, 500)
  }

  // Notificar al gestor por email (fire & forget)
  const [{ data: salon }, { data: gestor }] = await Promise.all([
    supabase.from('salons').select('name').eq('id', salonId).single(),
    supabase.from('gestores').select('email, name').eq('id', gestorId).single(),
  ])

  if (gestor?.email) {
    sendChatNotificationGestor(
      gestor.email,
      gestor.name,
      salon?.name ?? 'Tu cliente',
      body.trim() || `[adjunto: ${attachment?.filename}]`
    ).catch(console.error)
  }

  return c.json({ ok: true, message: msg }, 201)
})

// ─── POST /api/chat/thread/:gestorId/read ────────────────────────────────────
chatRoutes.post('/thread/:gestorId/read', async (c) => {
  const salonId = c.get('salon_id')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

  const gestorId = c.req.param('gestorId')
  const supabase = getSupabaseAdmin()

  const linkId = await assertActiveLink(supabase, salonId, gestorId)
  if (!linkId) return c.json({ error: 'Acceso denegado' }, 403)

  const now = new Date().toISOString()
  await supabase
    .from('gestor_messages')
    .update({ read_at: now })
    .eq('salon_id', salonId)
    .eq('gestor_id', gestorId)
    .eq('sender', 'gestor')
    .is('read_at', null)

  return c.json({ ok: true })
})

// ─── GET /api/chat/attachment/:msgId ─────────────────────────────────────────
chatRoutes.get('/attachment/:msgId', async (c) => {
  const salonId = c.get('salon_id')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

  const msgId = c.req.param('msgId')
  const supabase = getSupabaseAdmin()

  const { data: msg } = await supabase
    .from('gestor_messages')
    .select('salon_id, gestor_id, attachment')
    .eq('id', msgId)
    .single()

  if (!msg) return c.json({ error: 'Mensaje no encontrado' }, 404)
  if (msg.salon_id !== salonId) return c.json({ error: 'Acceso denegado' }, 403)
  if (!msg.attachment?.storage_path) return c.json({ error: 'Sin adjunto' }, 404)

  // Verificar vínculo activo
  const linkId = await assertActiveLink(supabase, salonId, msg.gestor_id)
  if (!linkId) return c.json({ error: 'Acceso denegado' }, 403)

  const { data: signed } = await supabase.storage
    .from('chat-attachments')
    .createSignedUrl(msg.attachment.storage_path, SIGNED_URL_EXPIRY)

  if (!signed?.signedUrl) return c.json({ error: 'Error generando URL' }, 500)

  return c.json({ ok: true, url: signed.signedUrl, expires_in: SIGNED_URL_EXPIRY, filename: msg.attachment.filename })
})

// ─── GET /api/chat/unread ─────────────────────────────────────────────────────
chatRoutes.get('/unread', async (c) => {
  const salonId = c.get('salon_id')
  if (!salonId) return c.json({ error: 'No autorizado' }, 401)

  const supabase = getSupabaseAdmin()

  const { count } = await supabase
    .from('gestor_messages')
    .select('id', { count: 'exact' })
    .eq('salon_id', salonId)
    .eq('sender', 'gestor')
    .is('read_at', null)

  return c.json({ ok: true, unread: count ?? 0 })
})

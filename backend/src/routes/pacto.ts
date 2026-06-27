import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase'

type Variables = { userId: string; salonId: string; userEmail: string; gestorId: string; usageWarning: boolean; salon_id: string }


export const pactoRoutes = new Hono<{ Variables: Variables }>()

const APIFY_TOKEN    = process.env.APIFY_API_KEY      || ''
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''
const WA_TOKEN       = process.env.WHATSAPP_TOKEN     || ''
const WA_PHONE_ID    = process.env.WHATSAPP_PHONE_ID  || ''

// ─── LIST CAMPAÑAS ──────────────────────────────────────────────────────────
pactoRoutes.get('/campanas', async (c) => {
  const salonId = c.get('salonId')
  const db = getSupabaseAdmin()
  try {
    const { data } = await db
      .from('pacto_campanas')
      .select('*')
      .eq('salon_id', salonId)
      .order('created_at', { ascending: false })
    return c.json({ campanas: data || [] })
  } catch { return c.json({ campanas: [] }) }
})

// ─── STATS GLOBALES ─────────────────────────────────────────────────────────
pactoRoutes.get('/stats', async (c) => {
  const salonId = c.get('salonId')
  const db = getSupabaseAdmin()
  try {
    const { data: campanas } = await db
      .from('pacto_campanas')
      .select('leads_encontrados, leads_enviados, leads_convertidos')
      .eq('salon_id', salonId)
    const stats = (campanas || []).reduce(
      (acc, r) => ({
        total_campanas: acc.total_campanas + 1,
        total_leads: acc.total_leads + (r.leads_encontrados || 0),
        total_enviados: acc.total_enviados + (r.leads_enviados || 0),
        total_convertidos: acc.total_convertidos + (r.leads_convertidos || 0),
      }),
      { total_campanas: 0, total_leads: 0, total_enviados: 0, total_convertidos: 0 }
    )
    return c.json(stats)
  } catch { return c.json({ total_campanas: 0, total_leads: 0, total_enviados: 0, total_convertidos: 0 }) }
})

// ─── CREATE CAMPAÑA ──────────────────────────────────────────────────────────
pactoRoutes.post('/campanas', async (c) => {
  const salonId = c.get('salonId')
  const body = await c.req.json()
  const { nombre, tipo_cliente, categoria_busqueda, zona, radio_km, leads_objetivo } = body
  if (!nombre || !categoria_busqueda || !zona)
    return c.json({ error: 'Nombre, categoría y zona son obligatorios' }, 400)
  const db = getSupabaseAdmin()
  try {
    const { data } = await db
      .from('pacto_campanas')
      .insert({
        salon_id: salonId,
        nombre,
        tipo_cliente:        tipo_cliente || 'negocios',
        categoria_busqueda,
        zona,
        radio_km:       radio_km      || 5,
        leads_objetivo: leads_objetivo || 50,
        estado: 'borrador'
      })
      .select()
      .single()
    return c.json({ campana: data })
  } catch (e) { return c.json({ error: 'Error al crear campaña' }, 500) }
})

// ─── GET CAMPAÑA ─────────────────────────────────────────────────────────────
pactoRoutes.get('/campanas/:id', async (c) => {
  const salonId = c.get('salonId')
  const id = c.req.param('id')
  const db = getSupabaseAdmin()
  try {
    const { data } = await db
      .from('pacto_campanas')
      .select('*')
      .eq('id', id).eq('salon_id', salonId)
      .single()
    if (!data) return c.json({ error: 'No encontrado' }, 404)
    return c.json({ campana: data })
  } catch { return c.json({ error: 'Error' }, 500) }
})

// ─── TRIGGER APIFY SEARCH ────────────────────────────────────────────────────
pactoRoutes.post('/campanas/:id/buscar', async (c) => {
  const salonId = c.get('salonId')
  const id = c.req.param('id')
  const db = getSupabaseAdmin()
  try {
    const { data: campana } = await db
      .from('pacto_campanas')
      .select('*')
      .eq('id', id).eq('salon_id', salonId)
      .single()
    if (!campana) return c.json({ error: 'No encontrado' }, 404)

    const searchQuery = `${campana.categoria_busqueda} ${campana.zona}`
    const apifyRes = await fetch(
      `https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchStringsArray: [searchQuery],
          language: 'es',
          maxCrawledPlacesPerSearch: campana.leads_objetivo || 50,
          includeWebResults: false,
          maxImages: 0,
          maxReviews: 5
        })
      }
    )
    if (!apifyRes.ok) {
      const err = await apifyRes.text()
      return c.json({ error: `Apify: ${err}` }, 500)
    }
    const { data: run } = await apifyRes.json()
    await db.from('pacto_campanas').update({
      estado: 'buscando',
      apify_run_id: run.id,
      apify_dataset_id: run.defaultDatasetId,
      updated_at: new Date().toISOString()
    }).eq('id', id)

    return c.json({ ok: true, runId: run.id })
  } catch (e: any) { return c.json({ error: e.message || 'Error al buscar' }, 500) }
})

// ─── POLL SEARCH STATUS ──────────────────────────────────────────────────────
pactoRoutes.get('/campanas/:id/buscar/estado', async (c) => {
  const salonId = c.get('salonId')
  const id = c.req.param('id')
  const db = getSupabaseAdmin()
  try {
    const { data: campana } = await db
      .from('pacto_campanas')
      .select('*')
      .eq('id', id).eq('salon_id', salonId)
      .single()
    if (!campana) return c.json({ error: 'No encontrado' }, 404)
    if (!campana.apify_run_id)
      return c.json({ estado: campana.estado, listo: false })

    // Check Apify
    const runRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${campana.apify_run_id}?token=${APIFY_TOKEN}`
    )
    const { data: run } = await runRes.json()
    const status = run?.status

    if (status === 'SUCCEEDED') {
      // Get dataset items
      const itemsRes = await fetch(
        `https://api.apify.com/v2/datasets/${campana.apify_dataset_id}/items?token=${APIFY_TOKEN}&limit=100&clean=true`
      )
      const items = await itemsRes.json()

      const leads = (Array.isArray(items) ? items : [])
        .filter((item: any) => item.title && item.phone)
        .map((item: any) => ({
          campana_id: id,
          salon_id: salonId,
          nombre:      item.title        || null,
          telefono:    item.phone        || null,
          email:       item.email        || null,
          direccion:   item.address      || null,
          categoria:   item.categoryName || null,
          rating:      item.totalScore   || null,
          num_reviews: item.reviewsCount || null,
          website:     item.website      || null,
          seleccionado: true,
          estado: 'pendiente',
          raw_data: { placeId: item.placeId, url: item.url }
        }))

      if (leads.length > 0) {
        await db.from('pacto_leads').insert(leads)
      }

      await db.from('pacto_campanas').update({
        estado: 'leads_listos',
        leads_encontrados: leads.length,
        updated_at: new Date().toISOString()
      }).eq('id', id)

      return c.json({ estado: 'leads_listos', listo: true, total: leads.length })
    }

    if (status === 'FAILED' || status === 'ABORTED') {
      await db.from('pacto_campanas').update({ estado: 'borrador', updated_at: new Date().toISOString() }).eq('id', id)
      return c.json({ estado: 'error', listo: false })
    }

    return c.json({ estado: 'buscando', listo: false, runStatus: status })
  } catch (e) { return c.json({ error: 'Error al comprobar' }, 500) }
})

// ─── LIST LEADS ──────────────────────────────────────────────────────────────
pactoRoutes.get('/campanas/:id/leads', async (c) => {
  const salonId = c.get('salonId')
  const id = c.req.param('id')
  const db = getSupabaseAdmin()
  try {
    const { data } = await db
      .from('pacto_leads')
      .select('*')
      .eq('campana_id', id)
      .eq('salon_id', salonId)
      .order('rating', { ascending: false })
    return c.json({ leads: data || [] })
  } catch { return c.json({ leads: [] }) }
})

// ─── UPDATE CAMPAÑA ──────────────────────────────────────────────────────────
pactoRoutes.patch('/campanas/:id', async (c) => {
  const salonId = c.get('salonId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const db = getSupabaseAdmin()
  const updates: any = { updated_at: new Date().toISOString() }
  for (const k of ['nombre', 'mensaje_plantilla', 'estado']) {
    if (body[k] !== undefined) updates[k] = body[k]
  }
  if (body.mensaje_plantilla && !body.estado) updates.estado = 'mensaje_listo'
  try {
    const { data } = await db
      .from('pacto_campanas')
      .update(updates)
      .eq('id', id).eq('salon_id', salonId)
      .select().single()
    return c.json({ campana: data })
  } catch { return c.json({ error: 'Error al actualizar' }, 500) }
})

// ─── UPDATE LEAD ─────────────────────────────────────────────────────────────
pactoRoutes.patch('/leads/:leadId', async (c) => {
  const salonId = c.get('salonId')
  const leadId = c.req.param('leadId')
  const body = await c.req.json()
  const db = getSupabaseAdmin()
  const updates: any = {}
  for (const k of ['seleccionado', 'estado', 'notas', 'telefono']) {
    if (body[k] !== undefined) updates[k] = body[k]
  }
  try {
    const { data } = await db
      .from('pacto_leads')
      .update(updates)
      .eq('id', leadId).eq('salon_id', salonId)
      .select().single()
    return c.json({ lead: data })
  } catch { return c.json({ error: 'Error al actualizar lead' }, 500) }
})

// ─── GENERAR MENSAJE IA ──────────────────────────────────────────────────────
pactoRoutes.post('/campanas/:id/mensaje-ia', async (c) => {
  const salonId = c.get('salonId')
  const id = c.req.param('id')
  const db = getSupabaseAdmin()
  try {
    const { data: campana } = await db
      .from('pacto_campanas').select('*')
      .eq('id', id).eq('salon_id', salonId).single()
    const { data: salon } = await db
      .from('salons').select('name, category')
      .eq('id', salonId).single()
    if (!campana || !salon) return c.json({ error: 'No encontrado' }, 404)

    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4-5',
        messages: [{
          role: 'user',
          content: `Eres experto en marketing directo para pequeños negocios en España.

Genera un mensaje de WhatsApp para captar clientes potenciales. Reglas:
- Máximo 3 frases cortas
- Tono cercano y profesional, en español de España
- Máximo 1 emoji al inicio
- Termina con una pregunta o CTA claro
- No menciones precios
- Empieza con "Hola [nombre],"

Negocio: ${salon.name || 'negocio local'} (${salon.category || 'servicios profesionales'})
Busca contactar: ${campana.categoria_busqueda} en ${campana.zona}
Tipo: ${campana.tipo_cliente === 'negocios' ? 'empresas y negocios' : 'personas'}

Escribe SOLO el mensaje, sin comillas ni explicaciones.`
        }],
        max_tokens: 250,
        temperature: 0.7
      })
    })
    const aiData = await aiRes.json()
    const mensaje = aiData.choices?.[0]?.message?.content?.trim() || ''
    return c.json({ mensaje })
  } catch { return c.json({ error: 'Error al generar mensaje' }, 500) }
})

// ─── ENVIAR A LEADS ──────────────────────────────────────────────────────────
pactoRoutes.post('/campanas/:id/enviar', async (c) => {
  const salonId = c.get('salonId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const { lead_ids } = body
  const db = getSupabaseAdmin()
  try {
    const { data: campana } = await db
      .from('pacto_campanas').select('*')
      .eq('id', id).eq('salon_id', salonId).single()
    if (!campana?.mensaje_plantilla)
      return c.json({ error: 'Configura el mensaje antes de enviar' }, 400)

    let query = db.from('pacto_leads').select('*')
      .eq('campana_id', id).eq('salon_id', salonId).eq('estado', 'pendiente')
    if (lead_ids?.length > 0) query = query.in('id', lead_ids)
    else                       query = query.eq('seleccionado', true)
    const { data: leads } = await query
    if (!leads?.length) return c.json({ error: 'No hay leads para enviar' }, 400)

    let enviados = 0, errores = 0
    for (const lead of leads) {
      if (!lead.telefono) { errores++; continue }
      let phone = lead.telefono.replace(/\s+/g, '').replace(/[^\d+]/g, '')
      if (phone.startsWith('0'))  phone = '+34' + phone.slice(1)
      if (!phone.startsWith('+')) phone = '+34' + phone
      const texto = campana.mensaje_plantilla
        .replace('[nombre],', lead.nombre ? `${lead.nombre},` : 'estimado cliente,')
        .replace('[nombre]',  lead.nombre || 'estimado cliente')
      try {
        const waRes = await fetch(
          `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: phone.replace('+', ''),
              type: 'text',
              text: { body: texto }
            })
          }
        )
        if (waRes.ok) {
          await db.from('pacto_leads').update({
            estado: 'enviado',
            mensaje_enviado: texto,
            enviado_at: new Date().toISOString()
          }).eq('id', lead.id)
          enviados++
        } else { errores++ }
      } catch { errores++ }
    }

    await db.from('pacto_campanas').update({
      estado: 'activa',
      leads_enviados: (campana.leads_enviados || 0) + enviados,
      updated_at: new Date().toISOString()
    }).eq('id', id)

    return c.json({ ok: true, enviados, errores })
  } catch { return c.json({ error: 'Error al enviar' }, 500) }
})

// ─── MARCAR LEAD CONVERTIDO ──────────────────────────────────────────────────
pactoRoutes.post('/leads/:leadId/convertido', async (c) => {
  const salonId = c.get('salonId')
  const leadId = c.req.param('leadId')
  const db = getSupabaseAdmin()
  try {
    const { data: lead } = await db
      .from('pacto_leads').update({ estado: 'convertido', respondio_at: new Date().toISOString() })
      .eq('id', leadId).eq('salon_id', salonId).select().single()
    // Update campaign counter
    if (lead) {
      const { data: campana } = await db
        .from('pacto_campanas').select('leads_convertidos')
        .eq('id', lead.campana_id).single()
      if (campana) {
        await db.from('pacto_campanas').update({
          leads_convertidos: (campana.leads_convertidos || 0) + 1
        }).eq('id', lead.campana_id)
      }
    }
    return c.json({ ok: true })
  } catch { return c.json({ error: 'Error' }, 500) }
})

// ─── DELETE CAMPAÑA ──────────────────────────────────────────────────────────
pactoRoutes.delete('/campanas/:id', async (c) => {
  const salonId = c.get('salonId')
  const id = c.req.param('id')
  const db = getSupabaseAdmin()
  try {
    await db.from('pacto_leads').delete().eq('campana_id', id).eq('salon_id', salonId)
    await db.from('pacto_campanas').delete().eq('id', id).eq('salon_id', salonId)
    return c.json({ ok: true })
  } catch { return c.json({ error: 'Error al eliminar' }, 500) }
})

// ─── GET /api/pacto/status ────────────────────────────────────────────────────
pactoRoutes.get('/status', async (c) => {
  try {
    const salonId = c.get('salonId')
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('salons')
      .select('pacto_activo, pacto_activado_at')
      .eq('id', salonId)
      .single()
    return c.json({ ok: true, pacto_activo: data?.pacto_activo || false, activado_at: data?.pacto_activado_at })
  } catch {
    return c.json({ ok: true, pacto_activo: false })
  }
})

// ─── POST /api/pacto/solicitar ────────────────────────────────────────────────
pactoRoutes.post('/solicitar', async (c) => {
  try {
    const salonId = c.get('salonId')
    const supabase = getSupabaseAdmin()
    const { data: salon } = await supabase
      .from('salons')
      .select('name')
      .eq('id', salonId)
      .single()

    const tgToken = process.env.TELEGRAM_BOT_TOKEN
    const chatId  = process.env.TELEGRAM_CHAT_ID
    if (tgToken && chatId) {
      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🔥 *El Pacto del Diablo — Solicitud*\n\nSalón: *${salon?.name || salonId}*\n\nActiva en admin:\nPOST /api/admin/salons/${salonId}/pacto\n{"activo": true}`,
          parse_mode: 'Markdown'
        })
      })
    }
    return c.json({ ok: true, message: 'Solicitud enviada' })
  } catch {
    return c.json({ ok: true })
  }
})

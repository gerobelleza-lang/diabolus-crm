// @ts-nocheck
import { Hono } from 'hono';
import { getSupabaseAdmin } from '../integrations/supabase';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const legalRoutes = new Hono();

// ── GET /api/legal/templates ──────────────────────────────────────
legalRoutes.get('/templates', async (c) => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('legal_templates')
    .select('id, slug, name, description, category, variables')
    .order('category', { ascending: true });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ templates: data });
});

// ── GET /api/legal/templates/:slug ────────────────────────────────
legalRoutes.get('/templates/:slug', async (c) => {
  const { slug } = c.req.param();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('legal_templates')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !data) return c.json({ error: 'Plantilla no encontrada' }, 404);
  return c.json({ template: data });
});

// ── POST /api/legal/templates/:slug/render ────────────────────────
legalRoutes.post('/templates/:slug/render', async (c) => {
  const { slug } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const { variables = {} } = body;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('legal_templates')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !data) return c.json({ error: 'Plantilla no encontrada' }, 404);

  let rendered = data.body;
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, String(value || '___________'));
  }
  rendered = rendered.replace(/\{\{[^}]+\}\}/g, '___________');

  return c.json({ rendered, template: data });
});

// ── GET /api/legal/knowledge ──────────────────────────────────────
legalRoutes.get('/knowledge', async (c) => {
  const q = c.req.query('q') || '';
  const category = c.req.query('category') || '';
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('legal_knowledge')
    .select('id, doc_name, article, title, content, keywords, category, doc_id');

  if (category) query = query.eq('category', category);

  const { data, error } = await query.limit(20);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ results: data });
});

// ── Helpers ───────────────────────────────────────────────────────
function extractKeywords(question: string): string[] {
  const stopWords = new Set(['que', 'de', 'la', 'el', 'en', 'un', 'una', 'los', 'las', 'y', 'o', 'a', 'se', 'su', 'me', 'mi', 'si', 'por', 'con', 'para', 'es', 'son', 'hay', 'como', 'qué', 'cómo']);
  return question
    .toLowerCase()
    .replace(/[¿?¡!.,;:]/g, '')
    .split(' ')
    .filter(w => w.length > 3 && !stopWords.has(w))
    .slice(0, 6);
}

function detectCategory(question: string): string {
  const q = question.toLowerCase();
  if (q.includes('morosidad') || q.includes('impag') || q.includes('cobr') || q.includes('interes') || q.includes('mora') || q.includes('pago') || q.includes('factura') || q.includes('venci')) return 'morosidad';
  if (q.includes('rgpd') || q.includes('datos') || q.includes('privacidad') || q.includes('lopd') || q.includes('consentimiento')) return 'rgpd';
  if (q.includes('contrato') || q.includes('incumpl') || q.includes('resci') || q.includes('cancel') || q.includes('servicio')) return 'contratos';
  if (q.includes('web') || q.includes('lssi') || q.includes('aviso legal') || q.includes('online') || q.includes('email')) return 'comercio-electronico';
  if (q.includes('autóno') || q.includes('autono') || q.includes('trade') || q.includes('trabajo')) return 'autonomos';
  return 'contratos';
}

// ── POST /api/legal/chat ──────────────────────────────────────────
legalRoutes.post('/chat', async (c) => {
  try {
  const salonId = c.get('salonId') || c.get('salon_id');
  const body = await c.req.json().catch(() => ({}));
  const { question } = body;

  if (!question?.trim()) return c.json({ error: 'Pregunta requerida' }, 400);

  const supabase = getSupabaseAdmin();
  let relevantChunks: any[] = [];

  // ── Búsqueda en base de conocimiento legal ────────────────────
  try {
    // Intento 1: FTS con config español
    const { data: ftsResults, error: ftsError } = await supabase
      .from('legal_knowledge')
      .select('doc_name, article, title, content, category')
      .textSearch('search_vector', question.split(' ').filter(w => w.length > 3).slice(0, 5).join(' | '), { config: 'spanish' })
      .limit(4);

    if (!ftsError && ftsResults && ftsResults.length > 0) {
      relevantChunks = ftsResults;
    }
  } catch (_) {}

  // Intento 2: keywords en array
  if (relevantChunks.length === 0) {
    try {
      const keywords = extractKeywords(question);
      if (keywords.length > 0) {
        const { data: kwResults } = await supabase
          .from('legal_knowledge')
          .select('doc_name, article, title, content, category')
          .overlaps('keywords', keywords)
          .limit(4);
        if (kwResults && kwResults.length > 0) relevantChunks = kwResults;
      }
    } catch (_) {}
  }

  // Intento 3: ILIKE en título y contenido
  if (relevantChunks.length === 0) {
    try {
      const words = extractKeywords(question);
      const searchTerm = words[0] || question.split(' ')[0];
      const { data: ilikeResults } = await supabase
        .from('legal_knowledge')
        .select('doc_name, article, title, content, category')
        .or(`title.ilike.%${searchTerm}%,content.ilike.%${searchTerm}%`)
        .limit(4);
      if (ilikeResults && ilikeResults.length > 0) relevantChunks = ilikeResults;
    } catch (_) {}
  }

  // Intento 4: categoría detectada
  if (relevantChunks.length === 0) {
    try {
      const detectedCategory = detectCategory(question);
      const { data: catResults } = await supabase
        .from('legal_knowledge')
        .select('doc_name, article, title, content, category')
        .eq('category', detectedCategory)
        .limit(3);
      relevantChunks = catResults || [];
    } catch (_) {}
  }

  // Último recurso: artículos más recientes
  if (relevantChunks.length === 0) {
    try {
      const { data: allResults } = await supabase
        .from('legal_knowledge')
        .select('doc_name, article, title, content, category')
        .limit(3);
      relevantChunks = allResults || [];
    } catch (_) {}
  }

  const contextText = relevantChunks.length > 0
    ? relevantChunks.map(ch =>
        `[${ch.doc_name} — ${ch.article || ''}]\nTítulo: ${ch.title}\n${ch.content}`
      ).join('\n\n---\n\n')
    : 'No se encontraron artículos específicos.';

  const sources = relevantChunks.map(ch => ({
    doc: ch.doc_name,
    article: ch.article,
    title: ch.title,
  }));

  // ── LLM ───────────────────────────────────────────────────────
  let answer = '';

  if (!OPENROUTER_API_KEY) {
    // Sin IA: devolvemos los artículos directamente
    if (relevantChunks.length > 0) {
      answer = `Artículos relevantes encontrados en la base de conocimiento legal:\n\n` +
        relevantChunks.map(ch =>
          `📚 **${ch.doc_name} — ${ch.article || ''}**: ${ch.title}\n${ch.content.substring(0, 300)}...`
        ).join('\n\n') +
        '\n\n⚠️ El asistente IA no está disponible temporalmente. Estos son los artículos más relevantes para tu consulta.';
    } else {
      answer = 'No se encontraron artículos específicos para tu consulta. El asistente IA no está disponible temporalmente. Consulta con tu asesor legal.';
    }
  } else {
    try {
      const systemPrompt = `Eres el Agente Legal de Diabolus CRM, especializado en derecho español para autónomos y pequeñas empresas de servicios (peluquerías, centros de estética, profesionales independientes).

Tu base de conocimiento incluye: Ley 3/2004 de Morosidad, RGPD/LOPD, Código Civil, LSSI y Estatuto del Trabajo Autónomo.

INSTRUCCIONES:
- Responde SIEMPRE citando el artículo o ley específica cuando esté disponible en el contexto.
- Usa el contexto legal proporcionado como fuente principal — es legislación española oficial.
- Sé preciso, práctico y orientado al negocio pequeño.
- Si la pregunta está fuera de tu base de conocimiento, indícalo y recomienda consultar a un abogado.
- Responde en español, de forma clara y sin jerga jurídica innecesaria.
- Al final, indica qué documentación o acción concreta recomiendas tomar.
- NUNCA inventes artículos o leyes que no estén en el contexto proporcionado.

CONTEXTO LEGAL OFICIAL:
${contextText}`;

      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://diabolus-crm-api.vercel.app',
          'X-Title': 'Diabolus Legal Agent',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-haiku-4.5',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
          ],
          max_tokens: 800,
          temperature: 0.2,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        answer = data.choices?.[0]?.message?.content || 'Sin respuesta del modelo.';
      } else {
        const errText = await response.text().catch(() => '');
        console.error('[Legal Chat] OpenRouter error:', errText);
        // Fallback: mostrar artículos directamente
        answer = `No pude conectar con el asistente IA en este momento.\n\nArtículos más relevantes encontrados:\n\n` +
          relevantChunks.slice(0, 2).map(ch =>
            `📚 ${ch.doc_name} — ${ch.article}: ${ch.title}\n${ch.content.substring(0, 400)}`
          ).join('\n\n---\n\n');
      }
    } catch (err) {
      console.error('[Legal Chat] Error LLM:', err);
      answer = 'Error inesperado al conectar con el asistente. Inténtalo de nuevo en unos segundos.';
    }
  }

  // ── Guardar historial ─────────────────────────────────────────
  if (salonId) {
    await supabase.from('legal_chat_history').insert([{
      salon_id: salonId,
      question,
      answer,
      sources,
    }]).catch(() => {});
  }

  return c.json({ answer, sources });
  } catch (topErr: any) {
    console.error('[Legal Chat] Uncaught error:', topErr?.message || topErr);
    return c.json({ answer: 'Error interno. Inténtalo de nuevo en unos segundos.', sources: [] });
  }
});

// ── GET /api/legal/chat/history ───────────────────────────────────
legalRoutes.get('/chat/history', async (c) => {
  const salonId = c.get('salonId') || c.get('salon_id');
  if (!salonId) return c.json({ history: [] });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('legal_chat_history')
    .select('id, question, answer, sources, created_at')
    .eq('salon_id', salonId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return c.json({ history: [] });
  return c.json({ history: data });
});

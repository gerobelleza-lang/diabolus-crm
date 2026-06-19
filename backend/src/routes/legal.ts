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
// Renderiza plantilla sustituyendo {{variables}}
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
  // Resaltar variables no rellenadas
  rendered = rendered.replace(/\{\{[^}]+\}\}/g, '___________');

  return c.json({ rendered, template: data });
});

// ── GET /api/legal/knowledge ──────────────────────────────────────
// Busca en la base de conocimiento legal
legalRoutes.get('/knowledge', async (c) => {
  const q = c.req.query('q') || '';
  const category = c.req.query('category') || '';
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('legal_knowledge')
    .select('id, doc_name, article, title, content, keywords, category, doc_id');

  if (category) query = query.eq('category', category);
  if (q) query = query.textSearch('search_vector', q, { config: 'spanish' });

  const { data, error } = await query.limit(20);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ results: data });
});

// ── POST /api/legal/chat ──────────────────────────────────────────
// Agente Legal IA con RAG sobre base de conocimiento
legalRoutes.post('/chat', async (c) => {
  const salonId = c.get('salonId') || c.get('salon_id');
  const body = await c.req.json().catch(() => ({}));
  const { question } = body;

  if (!question?.trim()) return c.json({ error: 'Pregunta requerida' }, 400);

  const supabase = getSupabaseAdmin();

  // 1. Buscar chunks relevantes en la base de conocimiento
  let relevantChunks: any[] = [];
  try {
    // Búsqueda FTS
    const { data: ftsResults } = await supabase
      .from('legal_knowledge')
      .select('doc_name, article, title, content, category')
      .textSearch('search_vector', question.split(' ').slice(0, 5).join(' | '), {
        config: 'spanish',
      })
      .limit(4);

    if (ftsResults && ftsResults.length > 0) {
      relevantChunks = ftsResults;
    } else {
      // Fallback: búsqueda por palabras clave manualmente
      const keywords = extractKeywords(question);
      if (keywords.length > 0) {
        const { data: kwResults } = await supabase
          .from('legal_knowledge')
          .select('doc_name, article, title, content, category')
          .overlaps('keywords', keywords)
          .limit(4);
        relevantChunks = kwResults || [];
      }
    }

    // Si no hay resultados FTS, traer artículos más relevantes por categoría detectada
    if (relevantChunks.length === 0) {
      const detectedCategory = detectCategory(question);
      const { data: catResults } = await supabase
        .from('legal_knowledge')
        .select('doc_name, article, title, content, category')
        .eq('category', detectedCategory)
        .limit(3);
      relevantChunks = catResults || [];
    }
  } catch (err) {
    console.error('[Legal] Error buscando chunks:', err);
  }

  // 2. Construir contexto con los chunks encontrados
  const contextText = relevantChunks.length > 0
    ? relevantChunks.map(c =>
        `[${c.doc_name} — ${c.article || ''}]\nTítulo: ${c.title}\n${c.content}`
      ).join('\n\n---\n\n')
    : 'No se encontraron artículos específicos en la base de conocimiento.';

  const sources = relevantChunks.map(c => ({
    doc: c.doc_name,
    article: c.article,
    title: c.title,
  }));

  // 3. Llamar al LLM con el contexto legal real
  let answer = '';
  try {
    if (!OPENROUTER_API_KEY) {
      answer = 'El servicio de IA no está disponible temporalmente. Consulta los artículos de la base de conocimiento.';
    } else {
      const systemPrompt = `Eres el Agente Legal de Diabolus CRM, especializado en derecho español para autónomos y pequeñas empresas de servicios.

Tu base de conocimiento incluye: Ley 3/2004 de Morosidad, RGPD/LOPD, Código Civil, LSSI y Estatuto del Trabajo Autónomo.

INSTRUCCIONES:
- Responde SIEMPRE citando el artículo o ley específica cuando lo tengas disponible.
- Usa el contexto legal proporcionado como fuente principal. Es legislación española oficial.
- Sé preciso, práctico y orientado al negocio pequeño.
- Si la pregunta está fuera de tu base de conocimiento, indícalo claramente y recomienda consultar a un abogado.
- Responde en español, de forma clara y sin jerga jurídica innecesaria.
- Al final, indica qué documentación o acción concreta recomiendas.
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
          model: 'anthropic/claude-haiku',
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
        const errText = await response.text();
        console.error('[Legal Chat] OpenRouter error:', errText);
        answer = 'Error al conectar con el servicio de IA. Inténtalo de nuevo.';
      }
    }
  } catch (err) {
    console.error('[Legal Chat] Error LLM:', err);
    answer = 'Error inesperado. Inténtalo de nuevo.';
  }

  // 4. Guardar en historial
  if (salonId) {
    await supabase.from('legal_chat_history').insert([{
      salon_id: salonId,
      question,
      answer,
      sources,
    }]).catch(() => {});
  }

  return c.json({ answer, sources });
});

// ── GET /api/legal/chat/history ───────────────────────────────────
legalRoutes.get('/chat/history', async (c) => {
  const salonId = c.get('salonId') || c.get('salon_id');
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('legal_chat_history')
    .select('id, question, answer, sources, created_at')
    .eq('salon_id', salonId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ history: data });
});

// ── Helpers ───────────────────────────────────────────────────────
function extractKeywords(text: string): string[] {
  const stopwords = new Set(['de', 'la', 'el', 'en', 'y', 'a', 'que', 'es', 'se', 'no', 'un', 'una', 'los', 'las', 'del', 'con', 'por', 'para', 'su', 'al', 'le', 'me', 'si', 'pero', 'como', 'más', 'o', 'hay']);
  return text
    .toLowerCase()
    .replace(/[¿?¡!.,;:]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w))
    .slice(0, 6);
}

function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/pago|cobr|factura|deuda|moroso|interés|vencid|impag/.test(lower)) return 'cobros';
  if (/dato|privacidad|rgpd|lopd|consentimiento|aepd/.test(lower)) return 'datos';
  if (/contrato|acuerdo|cancelaci|señal|arras|resolv/.test(lower)) return 'contratos';
  if (/web|internet|cookie|aviso legal|lssi/.test(lower)) return 'web';
  return 'contratos';
}

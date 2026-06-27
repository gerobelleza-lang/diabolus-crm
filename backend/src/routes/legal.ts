import { Hono } from 'hono';
import { getSupabaseAdmin } from '../integrations/supabase';

type Variables = { userId: string; salonId: string; userEmail: string; gestorId: string; usageWarning: boolean; salon_id: string }


const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const legalRoutes = new Hono<{ Variables: Variables }>();

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
      const systemPrompt = `# IDENTIDAD Y ÁMBITO

Eres el Agente Legal de Diabolus: un asistente jurídico-práctico para autónomos y
pequeñas empresas en España (especialmente sector belleza, salud y bienestar).

Tu derecho aplicable es el ESPAÑOL (estatal y, cuando proceda, autonómico). No respondes
sobre otras jurisdicciones; si te preguntan por otro país, lo dices y te detienes ahí.

Ofreces ORIENTACIÓN jurídica práctica y preventiva. NO eres asesoramiento jurídico
vinculante ni representación legal. Tu objetivo es que el usuario entienda su situación,
actúe con criterio y sepa cuándo necesita un abogado.

# REGLAS DE ORO (innegociables)

1. FUNDAMENTA TODO EN FUENTES REALES. Basa cada afirmación legal en tu base de
   conocimiento (los artículos y normas recuperados). Cita la norma y el artículo
   EXACTOS. Si tu base no cubre algo, o no estás seguro de la referencia, DILO
   abiertamente. NUNCA inventes leyes, artículos, números ni jurisprudencia. Una cita
   falsa es el peor error que puedes cometer.

2. USA DATOS REALES, NO SUPUESTOS. Para situaciones concretas (un impago, un contrato),
   consulta los datos reales del negocio en la base de datos (facturas, fechas, importes,
   cliente). No inventes ni asumas cifras.

3. MUESTRA EL CÁLCULO. En intereses de demora, plazos o importes, enseña la base: qué
   factura, qué fechas, qué tipo aplicas. El usuario debe poder verificarlo, no fiarse a
   ciegas.

4. CONFIRMACIÓN HUMANA EN TODA ACCIÓN. Redactar un borrador está bien. Pero ENVIAR
   (burofax, reclamación) o cualquier acción real requiere la confirmación explícita del
   usuario, vía el sistema de confirmación de Diabolus. NUNCA presentes un documento como
   "enviado" o "presentado" si no lo está.

5. SEÑALA LA INCERTIDUMBRE Y DERIVA A TIEMPO. Las leyes cambian y muchos casos tienen
   matices. En asuntos con consecuencias serias, advierte del matiz y recomienda
   verificar o acudir a un abogado colegiado. Es mejor derivar de más que de menos.

# QUÉ HACES

1. DUDAS LEGALES DIRECTAS (laboral, fiscal, contratos, morosidad, RGPD).
   Respuesta breve (máx. ~5 líneas), con el artículo exacto, al grano, sin rodeos.

2. ANÁLISIS DE SITUACIONES CONCRETAS.
   Ej.: "un cliente no me paga" → consulta sus facturas reales, calcula los días de
   impago, calcula el interés de demora aplicable (operaciones comerciales: tipo de
   referencia del BCE + 8 puntos, según la Ley 3/2004 de morosidad), e indica qué
   reclamar y cuánto — mostrando el cálculo.

3. GENERACIÓN DE DOCUMENTOS LISTOS PARA USAR.
   Carta de reclamación de pago, burofax de requerimiento, contrato de servicios,
   cláusula de protección de datos para clientes, acuerdo de confidencialidad para
   empleados. Rellenos con los datos reales del salón y del cliente implicado.
   Marca SIEMPRE que es un borrador a revisar antes de usar.

4. GUÍA DE PROCESOS PASO A PASO.
   Ej.: "quiero iniciar el proceso monitorio" → los pasos concretos, qué formulario, qué
   juzgado es competente y qué documentos aportar (proceso monitorio regulado en la LEC).

5. ALERTAS PROACTIVAS.
   Facturas que entran hoy en mora legal, contratos próximos a vencer, obligaciones
   legales cercanas (renovar la evaluación de riesgos, presentar el modelo 303, etc.).

6. SABER CUÁNDO DERIVAR.
   Si el caso supera lo que puedes resolver con seguridad (un delito, un contencioso
   complejo, un despido conflictivo, una inspección) → dilo claro y recomienda qué tipo
   de profesional necesita (laboralista, fiscalista, etc.).

# QUÉ NO HACES

- No presentas documentos ante organismos, AEAT ni juzgados.
- No actúas como representante legal del usuario.
- No inventas leyes, artículos ni jurisprudencia.
- No das certezas absolutas donde hay interpretación: marca el matiz.

# TONO Y FORMATO

- Claro, directo y sin jerga innecesaria. Hablas a un autónomo, no a un juez.
- Preciso: el dato y el artículo exactos, no aproximaciones.
- Cuando algo es serio, lo dices con calma y propones el siguiente paso, sin alarmismo.
- Dudas directas: respuesta corta. Documentos y guías: tan largos como haga falta, pero
  estructurados y claros.

# BASE DE CONOCIMIENTO LEGAL (fuente primaria — cita de aquí):
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
          max_tokens: 2000,
          temperature: 0.1,
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
    try {
      await supabase.from('legal_chat_history').insert([{
        salon_id: salonId,
        question,
        answer,
        sources,
      }]);
    } catch (_) { /* historial opcional */ }
  }

  return c.json({ answer, sources });
  } catch (topErr: any) {
    console.error('[Legal Chat] Uncaught error:', topErr?.message || topErr);
    return c.json({ answer: 'Ha ocurrido un error inesperado. Inténtalo de nuevo.', sources: [] });
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

// @ts-nocheck
// POST /api/agent/tts — OpenAI TTS proxy (Edge Runtime)
// Body: { text: string, voice?: string }
// Returns: audio/mpeg stream

export const config = { runtime: 'edge' };

const VOICE = 'nova'; // cálida, profesional, femenina
const MODEL = 'tts-1';  // tts-1-hd para mayor calidad (más lento)
const MAX_CHARS = 1000; // recortamos para evitar gastos excesivos

export async function ttsRoute(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { text, voice } = await req.json();

    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({ error: 'text requerido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'TTS no configurado' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Limpiar texto: quitar emojis y markdown para voz más natural
    const clean = text
      .replace(/[*_~`#>]/g, '')           // markdown
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, '') // emojis
      .replace(/\[(.*?)\]\(.*?\)/g, '$1') // links
      .replace(/\n+/g, '. ')              // saltos → pausa natural
      .trim()
      .slice(0, MAX_CHARS);

    const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        input: clean,
        voice: voice || VOICE,
        response_format: 'mp3',
        speed: 1.0,
      }),
    });

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('OpenAI TTS error:', err);
      return new Response(JSON.stringify({ error: 'Error generando audio' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stream el audio directamente al cliente
    return new Response(ttsRes.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (e) {
    console.error('TTS route error:', e);
    return new Response(JSON.stringify({ error: 'Error interno' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

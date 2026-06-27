// POST /api/agent/tts — OpenAI TTS proxy (Edge Runtime)
// Voz oficial: nova (femenina, cálida) — Diablilla V2
// Body: { text: string, speed?: number, hd?: boolean }
// Returns: audio/mpeg

export const config = { runtime: 'edge' };

const VOICE = 'nova';
const MODEL_STD = 'tts-1';
const MODEL_HD  = 'tts-1-hd';
const MAX_CHARS = 1000;

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
    const body = await req.json();
    const { text, speed, hd } = body;

    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({ error: 'text requerido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'TTS no configurado' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Limpiar texto para voz natural
    const clean = text
      .replace(/[*_~`#>]/g, '')                            // Markdown
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')              // Emojis block 1
      .replace(/[\u{2600}-\u{27BF}]/gu, '')                // Emojis block 2
      .replace(/[\u{FE00}-\u{FE0F}]/gu, '')                // Variation selectors
      .replace(/[\u{200D}]/gu, '')                          // Zero-width joiner
      .replace(/💡|😈|🔥|⚠️|✅|❌|📊|💰|🧾|📈|📉/g, '')   // Common Diablilla emojis
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')                   // Links
      .replace(/<[^>]+>/g, '')                              // HTML tags
      .replace(/\n+/g, '. ')                                // Newlines to pauses
      .replace(/\.{2,}/g, '.')                              // Multiple dots
      .replace(/€(\d)/g, '$1 euros')                        // €500 → 500 euros
      .replace(/\s{2,}/g, ' ')                              // Multiple spaces
      .trim()
      .slice(0, MAX_CHARS);

    if (!clean) {
      return new Response(JSON.stringify({ error: 'texto vacío tras limpiar' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const model = hd ? MODEL_HD : MODEL_STD;
    const ttsSpeed = Math.min(4.0, Math.max(0.25, speed || 1.05)); // Diablilla: slightly snappy

    const costPerChar = model === MODEL_HD ? 0.00003 : 0.000015;
    const cost = (clean.length * costPerChar).toFixed(4);

    console.log(`[TTS] model=${model} speed=${ttsSpeed} chars=${clean.length} cost=$${cost}`);

    const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: clean,
        voice: VOICE,
        speed: ttsSpeed,
        response_format: 'mp3',
      }),
    });

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('OpenAI TTS error:', err);
      return new Response(JSON.stringify({ error: 'Error generando audio' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    return new Response(ttsRes.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Diablilla-Voice': VOICE,
        'X-TTS-Model': model,
        'X-TTS-Cost': `$${cost}`,
      },
    });

  } catch (e) {
    console.error('TTS route error:', e);
    return new Response(JSON.stringify({ error: 'Error interno' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

// POST /api/agent/tts — OpenAI TTS proxy (Edge Runtime)
// Voz oficial: nova (femenina, cálida) — Diablilla V2
// Body: { text: string, speed?: number, hd?: boolean }
// Returns: audio/mpeg

import { Hono } from 'hono'

const VOICE = 'nova';
const MODEL_STD = 'tts-1';
const MODEL_HD  = 'tts-1-hd';
const MAX_CHARS = 1000;

const app = new Hono()

app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { text, speed, hd } = body;

    if (!text || typeof text !== 'string') {
      return c.json({ error: 'text requerido' }, 400);
    }

    const apiKey = (c.env as any)?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return c.json({ error: 'TTS no configurado' }, 500);
    }

    // Limpiar texto para voz natural
    const clean = text
      .replace(/[*_~`#>]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
      .replace(/[\u{2600}-\u{27BF}]/gu, '')
      .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
      .replace(/[\u{200D}]/gu, '')
      .replace(/💡|😈|🔥|⚠️|✅|❌|📊|💰|🧾|📈|📉/g, '')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\n+/g, '. ')
      .replace(/\.{2,}/g, '.')
      .replace(/€(\d)/g, '$1 euros')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, MAX_CHARS);

    if (!clean) {
      return c.json({ error: 'texto vacío tras limpiar' }, 400);
    }

    const model = hd ? MODEL_HD : MODEL_STD;
    const ttsSpeed = Math.min(4.0, Math.max(0.25, speed || 1.05));

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
      return c.json({ error: 'Error generando audio' }, 502);
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
    return c.json({ error: 'Error interno' }, 500);
  }
})

export const ttsRoute = app

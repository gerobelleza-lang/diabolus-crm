// Rate limiting middleware — protege API de abuso
// Implementación simple en-memory (producción: usar Redis via Upstash)

import type { Context, Next } from 'hono';

interface RateLimitStore {
  [key: string]: { count: number; resetAt: number };
}

const store: RateLimitStore = {};
const WINDOW_MS = 60 * 1000; // 1 minuto
const MAX_REQUESTS = 60; // 60 requests por minuto

export async function rateLimitMiddleware(c: Context, next: Next): Promise<void> {
  // Obtener IP del cliente (Vercel agrega x-forwarded-for)
  const ip = c.req.header('x-forwarded-for')?.split(',')[0] || 'unknown';
  const now = Date.now();

  // Inicializar o resetear si la ventana expiró
  if (!store[ip] || store[ip].resetAt < now) {
    store[ip] = { count: 0, resetAt: now + WINDOW_MS };
  }

  // Incrementar contador
  store[ip].count++;

  // Verificar límite
  if (store[ip].count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((store[ip].resetAt - now) / 1000);
    return c.json(
      {
        error: 'Too many requests',
        retryAfter,
      },
      429
    );
  }

  // Agregar headers informativos
  c.header('X-RateLimit-Limit', String(MAX_REQUESTS));
  c.header('X-RateLimit-Remaining', String(MAX_REQUESTS - store[ip].count));
  c.header('X-RateLimit-Reset', String(store[ip].resetAt));

  await next();
}

import type { Context, Next } from 'hono'

interface RateLimitEntry {
  count: number
  resetAt: number
}

// In-memory store (per Edge instance — effective against burst attacks)
const store = new Map<string, RateLimitEntry>()

interface RateLimitOptions {
  windowMs: number    // Time window in ms
  max: number         // Max requests per window
  keyPrefix?: string  // Prefix for the key (to separate different limiters)
}

function getClientIP(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    c.req.header('cf-connecting-ip') ||
    'unknown'
  )
}

export function rateLimiter(opts: RateLimitOptions) {
  const { windowMs, max, keyPrefix = 'rl' } = opts

  return async (c: Context, next: Next) => {
    const ip = getClientIP(c)
    const key = `${keyPrefix}:${ip}`
    const now = Date.now()

    let entry = store.get(key)

    // Cleanup expired entry inline (replaces setInterval which is dead code in Edge)
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs }
      store.set(key, entry)
    }

    entry.count++

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(max))
    c.header('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)))
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)))

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
      c.header('Retry-After', String(retryAfter))
      return c.json(
        { error: 'Too many requests. Try again later.', retryAfter },
        429
      )
    }

    await next()
  }
}

// ── Pre-configured limiters ──────────────────────────────────────────────

// Auth: 10 requests per 15 min (prevent brute force)
export const authLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: 'auth',
})

// Agent chat: 30 requests per minute (AI calls are expensive)
export const agentLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyPrefix: 'agent',
})

// General API: 120 requests per minute
export const apiLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyPrefix: 'api',
})

// Webhooks: 60 requests per minute (WhatsApp/Telegram can burst)
export const webhookLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyPrefix: 'webhook',
})

// Waitlist: 5 requests per 15 min (prevent spam signups)
export const waitlistLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyPrefix: 'waitlist',
})

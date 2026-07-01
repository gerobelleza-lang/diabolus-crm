import type { Context, Next } from 'hono'

/**
 * Security Headers Middleware
 * Adds CSP, HSTS, X-Frame-Options, X-Content-Type-Options, etc.
 * Recommended: Apply BEFORE routing
 */
export async function securityHeaders(c: Context, next: Next) {
  // HSTS — Force HTTPS for 1 year + subdomains
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')

  // CSP — Content Security Policy
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "img-src 'self' data: https: blob:",
    "font-src 'self' https://fonts.googleapis.com",
    "connect-src 'self' https://api.openrouter.ai https://graph.facebook.com https://api.telegram.org https://api.stripe.com https://openrouter.ai https://groq.com https://api.openai.com",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  c.header('Content-Security-Policy', csp)

  // X-Frame-Options — Prevent clickjacking
  c.header('X-Frame-Options', 'DENY')

  // X-Content-Type-Options — Prevent MIME sniffing
  c.header('X-Content-Type-Options', 'nosniff')

  // X-XSS-Protection — Legacy XSS protection
  c.header('X-XSS-Protection', '1; mode=block')

  // Referrer-Policy — Limit referrer info
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')

  // Permissions-Policy — Disable unused features (microphone + autoplay enabled for Voice UI)
  c.header('Permissions-Policy', [
    'accelerometer=()',
    'ambient-light-sensor=()',
    'autoplay=(self)',
    'battery=()',
    'camera=()',
    'document-domain=()',
    'encrypted-media=()',
    'fullscreen=()',
    'geolocation=()',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=(self)',
    'midi=()',
    'payment=()',
    'picture-in-picture=()',
    'sync-xhr=()',
    'usb=()',
    'vr=()',
    'xr-spatial-tracking=()',
  ].join(', '))

  await next()
}

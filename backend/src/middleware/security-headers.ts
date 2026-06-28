/**
 * security-headers.ts — HTTP security headers middleware
 * CSP, HSTS, X-Frame-Options, Permissions-Policy, etc.
 * @since 28 Jun 2026
 */
import type { MiddlewareHandler } from 'hono'

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next()

  // Prevent clickjacking
  c.header('X-Frame-Options', 'DENY')

  // Prevent MIME sniffing
  c.header('X-Content-Type-Options', 'nosniff')

  // XSS protection (legacy browsers)
  c.header('X-XSS-Protection', '1; mode=block')

  // Referrer policy — send origin only cross-origin
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')

  // HSTS — 1 year, include subdomains
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')

  // Permissions Policy — restrict sensitive APIs
  c.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(self)')

  // CSP — allow our domains + inline styles (Tailwind) + Stripe
  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://js.stripe.com https://cdn.tailwindcss.com 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self' https://diabolus-crm-api.vercel.app https://api.stripe.com",
      "frame-src https://js.stripe.com",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ')
  )
}

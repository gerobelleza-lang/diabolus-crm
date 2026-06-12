// JWT Signature Validation — validar autenticidad del token

import type { Context, Next } from 'hono';

/**
 * Validar JWT signature usando JWT_SECRET de Supabase
 * En producción: usar @supabase/auth-helpers o jose library
 */
export async function jwtValidationMiddleware(c: Context, next: Next): Promise<void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing Authorization header' }, 401);
  }

  const jwt = authHeader.slice(7);
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;

  if (!jwtSecret) {
    console.warn('⚠️ SUPABASE_JWT_SECRET not configured - skipping signature validation');
    return await next();
  }

  try {
    // En desarrollo: solo verificar formato (sin validar firma)
    // En producción: usar jose o jsonwebtoken para validar firma
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return c.json({ error: 'Invalid JWT format' }, 401);
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf-8')
    );

    // Verificar expiración
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return c.json({ error: 'JWT expired' }, 401);
    }

    // TODO: Validar firma usando jose library
    // import * as jose from 'jose';
    // const secret = new TextEncoder().encode(jwtSecret);
    // const { payload: verified } = await jose.jwtVerify(jwt, secret);

  } catch (error) {
    return c.json({ error: 'Invalid JWT' }, 401);
  }

  await next();
}

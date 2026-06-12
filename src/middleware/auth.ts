// Auth middleware — JWT context para RLS Supabase
// Extrae JWT del header Authorization, lo pasa a Supabase para que RLS lo use

import type { Context, Next } from 'hono';

export interface AuthContext {
  userJwt: string;
  userId: string;
  salonId: string;
}

/**
 * Middleware de autenticación
 * - Requiere header Authorization: Bearer <JWT>
 * - Extrae userId del JWT
 * - salonId se obtiene de query param o será validado en BD
 */
export async function authMiddleware(c: Context, next: Next): Promise<void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: missing or invalid Authorization header' }, 401);
  }

  const jwt = authHeader.slice(7); // Quita "Bearer "

  // Decodificar JWT (básico - en producción validar firma)
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return c.json({ error: 'Invalid JWT format' }, 401);
    }

    // Decodificar payload (parte 2)
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf-8')
    );

    const userId = payload.sub;
    const salonId = c.req.query('salon_id');

    if (!userId) {
      return c.json({ error: 'Invalid JWT: missing sub' }, 401);
    }

    if (!salonId) {
      return c.json({ error: 'Missing salon_id query parameter' }, 400);
    }

    // Guardar en contexto para que las rutas lo usen
    c.set('userJwt', jwt);
    c.set('userId', userId);
    c.set('salonId', salonId);
  } catch (error) {
    return c.json({ error: 'Failed to parse JWT' }, 401);
  }

  await next();
}

/**
 * Helper para obtener auth context desde cualquier ruta
 */
export function getAuthContext(c: Context): AuthContext {
  const userJwt = c.get('userJwt');
  const userId = c.get('userId');
  const salonId = c.get('salonId');

  if (!userJwt || !userId || !salonId) {
    throw new Error('Auth context not set - middleware may not have run');
  }

  return { userJwt, userId, salonId };
}

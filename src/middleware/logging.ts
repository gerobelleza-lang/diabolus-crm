// Production Logging — observabilidad en Vercel + Supabase

import type { Context, Next } from 'hono';

export interface LogEntry {
  timestamp: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  userId?: string;
  salonId?: string;
  error?: string;
}

export async function loggingMiddleware(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;

  try {
    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    // Log en Vercel (stderr para Production logs)
    if (duration > 1000 || status >= 400) {
      const log: LogEntry = {
        timestamp: new Date().toISOString(),
        method,
        path,
        status,
        duration,
        userId: c.get('userId'),
        salonId: c.get('salonId'),
      };

      console.error(
        `[${log.status}] ${log.method} ${log.path} (${log.duration}ms)`,
        log
      );
    }
  } catch (error) {
    const duration = Date.now() - start;
    const log: LogEntry = {
      timestamp: new Date().toISOString(),
      method,
      path,
      status: 500,
      duration,
      error: error instanceof Error ? error.message : String(error),
    };

    console.error(`[500] ${method} ${path} - ERROR`, log);
    throw error;
  }
}

/**
 * Log para queries a Supabase
 * Usa en supabaseRepo.ts para rastrear qué accesos ocurren
 */
export function logSupabaseQuery(
  operation: string,
  table: string,
  salonId: string,
  duration: number,
  success: boolean
): void {
  if (!success || duration > 500) {
    console.log(
      `[Supabase] ${operation} on ${table} (${salonId}) - ${duration}ms`
    );
  }
}

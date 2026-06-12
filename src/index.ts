import 'dotenv/config';
import { serve } from '@hono/node-server';
import { app } from './app.js';

const port = Number(process.env.PORT || 3939);
serve({ fetch: app.fetch, port });
console.log(`⚡ Diabolus v40 en http://localhost:${port}`);
console.log(`📦 SUPABASE_URL: ${process.env.SUPABASE_URL}`);

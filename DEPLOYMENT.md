# 🚀 Diabolus v40 — Deployment Guide

## Producción (Vercel + Supabase Live)

### Prerequisitos

- ✅ Código en GitHub
- ✅ Supabase project (diabolus-crm, production-ready)
- ✅ Vercel account
- ✅ OpenRouter API key (live, no test)

---

## Paso 1: Git Setup

```bash
cd "/Users/gerobelleza/Downloads/diabolus 3"

# Inicializar repo
git init
git add .
git commit -m "feat: v40.0.0 Supabase multi-tenant + LLM router"
```

**Crear `.gitignore` si no existe:**

```
node_modules/
.env
.env.local
dist/
.DS_Store
```

---

## Paso 2: GitHub

1. Crear nuevo repo: `diabolus-crm`
2. Push local:

```bash
git remote add origin https://github.com/gerobelleza/diabolus-crm.git
git branch -M main
git push -u origin main
```

---

## Paso 3: Vercel

### 3.1 Conectar GitHub

1. https://vercel.com/new
2. Import GitHub repo `diabolus-crm`
3. Framework: **Other** (custom Node.js)

### 3.2 Environment Variables

En Vercel dashboard → Settings → Environment Variables, agregar:

```
SUPABASE_URL=https://emygbvxkhfbwyhbapaae.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
OPENROUTER_API_KEY=sk-or-v1-YOUR_KEY_HERE
PORT=3000
NODE_ENV=production
```

### 3.3 Build & Start Commands

- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm run start` (o `node dist/index.js`)

---

## Paso 4: Post-Deploy

1. **Health Check:**
   ```
   https://diabolus.vercel.app/
   ```
   (Debería retornar HTML)

2. **Test API:**
   ```bash
   curl -X POST https://diabolus.vercel.app/api/agent \
     -H "Authorization: Bearer <JWT>" \
     -H "Content-Type: application/json" \
     -d '{"message":"he cobrado 500€ de Maria"}' \
     ?salon_id=<salon_id>
   ```

3. **Monitor Logs:**
   - Vercel Dashboard → Logs
   - Supabase Dashboard → Logs (queries)
   - OpenRouter API → Usage

---

## Paso 5: Production Hardening

### 5.1 Supabase

- ✅ Backups automáticos (Supabase Pro)
- ✅ RLS policies validadas
- ✅ Audit log inmutable
- ⚠️ Rate limiting en Edge Functions

### 5.2 Vercel

- ✅ Auto-scaling
- ✅ CDN global
- ✅ SSL automático
- ⚠️ Agregar dominio custom (ej: api.diabolus.es)

### 5.3 OpenRouter

- ✅ API key con rate limits
- ⚠️ Monitorear gastos (costs logged en Supabase)

---

## Troubleshooting

| Error | Solución |
|-------|----------|
| `SUPABASE_URL undefined` | Verificar env vars en Vercel |
| `RLS policy violation` | Revisar JWT + salon_id en request |
| `OpenRouter 401` | Usar API key live, no test |
| `Port 3000 already in use` | Vercel lo maneja automáticamente |

---

## Rollback

```bash
git revert <commit-hash>
git push origin main
# Vercel redeploy automático
```

---

**v40.0.0 PRODUCTION-READY** 🎉

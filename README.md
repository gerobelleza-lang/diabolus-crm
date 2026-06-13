# ⚡ Diabolus CRM

> "El negocio te obedece hablando."

Asistente operativo para autónomos y pequeños negocios. Facturación VeriFactu-ready, agente IA que ejecuta, y portal de gestoría automático.

## Estructura del monorepo

```
diabolus-crm/
├── backend/              # API Hono.js → desplegado en Vercel
├── diabolus-crm-visual/  # Frontend HTML → desplegado en GitHub Pages
└── README.md
```

## URLs de producción

| Servicio | URL |
|----------|-----|
| 🌐 App | https://gerobelleza-lang.github.io/diabolus-crm |
| 🔌 API | https://diabolus-crm.vercel.app |

## Stack

- **Frontend:** HTML + Tailwind CSS + Chart.js (GitHub Pages, rama `gh-pages`)
- **Backend:** Hono.js + TypeScript (Vercel, raíz `backend/`)
- **Base de datos:** Supabase PostgreSQL con RLS multi-tenant
- **Firma:** SignatureProvider abstraction (Mock en dev → FirmaaFy en producción)

## Setup local — Backend

```bash
cd backend
cp .env.example .env
# Rellena las variables
npm install
npm run dev
# → http://localhost:3000
```

## Deploy Vercel

En la configuración del proyecto Vercel, establece **Root Directory** = `backend`.

Variables de entorno requeridas:
```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SIGNATURE_PROVIDER=mock
```

## Pricing

| Plan | Precio | Incluye |
|------|--------|---------|
| Solo | 9,99€/mes | 1 usuario, sin agente IA |
| Pro | 19,99€/mes | Agente IA, ilimitado |
| On-Premise | 990€/año | Docker + Ollama local |

## Roadmap

- [x] Bloque 0: Login real Supabase Auth
- [ ] **Bloque 1:** Backend API + Auth + SignatureProvider ← *aquí*
- [ ] Bloque 2: Frontend conectado al backend
- [ ] Bloque 3: Facturas, clientes, transacciones, approval queue
- [ ] Bloque 4: Agente IA conversacional
- [ ] Bloque 5: Testing + polish

**Lanzamiento:** Septiembre 2026 | **VeriFactu obligatorio:** Julio 2027

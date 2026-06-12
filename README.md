# ⚡ Diabolus CRM v39

Tesorería agéntica: lenguaje natural → acciones financieras con confirmación humana.
Construido según `SPEC.md`. **40 tests en verde.**

## Arrancar en 60 segundos

```bash
npm install
npm run dev
# abre http://localhost:3939
```

Prueba en el chat: `ingreso 50 corte María` → preview → Confirmar.
Funciona SIN clave de API (nivel 0, parser determinista, coste 0€).

## Activar niveles 1-3 (LLM)

```bash
cp .env.example .env.local
# añade tu OPENROUTER_API_KEY en .env.local (NUNCA commitear este archivo)
```

## Arquitectura

```
mensaje → router (src/agent/router.ts)
  ├─ Nivel 0: parser determinista (parser.ts) ──┐
  ├─ Nivel 1-2: modelo pequeño + tool calling ──┤→ executor.ts → valida (Zod)
  └─ Nivel 3: modelo grande (análisis) ─────────┘   → confirmación humana
                                                     → Repo → audit_log
```

- **12 tools** con schemas estrictos: `src/agent/tools/schemas.ts`
- **Toda escritura exige confirmación** y queda en auditoría (también las cancelaciones)
- **Repo en memoria** (`src/db/inMemoryRepo.ts`): desarrollo sin Postgres.
  La interfaz `Repo` (en `types.ts`) es el contrato para `PostgresRepo` (v39.1).

## Tests

```bash
npm test        # 40 tests: parser (18), router (4), schemas (4), confirmación (6), HTTP e2e (5), fechas (3)
```

## Hoja de ruta inmediata (de SPEC.md)

- **v39.1**: PostgresRepo con Drizzle (docker compose up) + UI React
- **v40**: multi-tenant + auth + onboarding + PWA
- **v41**: portal gestoría + seguimientos automáticos

## Reglas duras del proyecto

1. El modelo propone, el servidor valida y ejecuta. Siempre.
2. Importes ambiguos → preguntar, nunca adivinar dinero.
3. Secretos solo en `.env.local`. Nunca en código ni commits.

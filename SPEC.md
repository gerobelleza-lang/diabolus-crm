# SPEC.md — DIABOLUS CRM v39
## Especificación de construcción desde cero (local-first)
**Fecha: 10 junio 2026 · Para ejecutar con Claude Code (Antigravity)**

---

## 0. CONTEXTO PARA CLAUDE CODE

Diabolus es un CRM/tesorería agéntico: convierte lenguaje natural en acciones financieras reales con confirmación humana. Existía un MVP (v38) sobre ChatGPT Team Sites que NO se migra — se reconstruye limpio. No hay datos reales que preservar.

**Principios no negociables:**
1. El modelo NUNCA ejecuta nada directamente: propone tool calls, el servidor valida y ejecuta.
2. Toda acción de escritura requiere confirmación humana (autonomía nivel 0-1 en v39).
3. Importes ambiguos → el agente pregunta, nunca adivina dinero.
4. Todo en español. Código y comentarios en inglés, UI y respuestas en español.
5. Log de auditoría de cada tool ejecutada (quién, qué, cuándo, payload).

---

## 1. INSTRUCCIONES HEREDADAS DEL SITE v38

> ⚠️ PEGAR AQUÍ las instrucciones completas del Site de OpenAI antes de empezar.
> Son los requisitos funcionales validados por uso real: frases que entiende,
> acciones que ejecuta, reglas de confirmación.

```
[PEGAR INSTRUCCIONES DEL SITE AQUÍ]
```

---

## 2. STACK Y ESTRUCTURA

| Capa | Tecnología | Notas |
|---|---|---|
| Runtime | Node 20+ / TypeScript | |
| Backend | Hono | API REST + endpoint del agente |
| Frontend | React + Vite (PWA-ready) | UI mínima de chat + confirmaciones |
| Base de datos | PostgreSQL 16 (Docker) | esquema abajo |
| ORM | Drizzle | migraciones versionadas |
| LLM | OpenRouter (gpt-4.1-mini por defecto) | clave en `.env.local`, NUNCA en código ni commits |
| Empaquetado | Docker Compose | `docker compose up` levanta todo |

### Estructura del repo
```
diabolus/
├── docker-compose.yml        # postgres + api + web
├── .env.example              # plantilla sin secretos
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── index.ts          # Hono server
│   │   │   ├── agent/
│   │   │   │   ├── router.ts     # router determinista→pequeño→grande
│   │   │   │   ├── prompt.ts     # system prompt
│   │   │   │   ├── tools/        # 1 archivo por tool
│   │   │   │   └── memory.ts     # resumen sesión + perfil negocio
│   │   │   ├── db/
│   │   │   │   ├── schema.ts
│   │   │   │   └── migrations/
│   │   │   └── audit.ts          # log de auditoría
│   │   └── tests/                # vitest
│   └── web/                      # React chat UI
└── SPEC.md                       # este archivo
```

---

## 3. ESQUEMA DE BASE DE DATOS (mínimo v39)

```sql
-- Diseñado ya para multi-tenant (v40): todo lleva tenant_id desde el día 1,
-- aunque en v39 solo exista un tenant.

tenants        (id, name, business_profile jsonb, created_at)
users          (id, tenant_id, email, name, role, created_at)
clients        (id, tenant_id, name, phone, email, notes, created_at)
services       (id, tenant_id, name, default_price numeric, created_at)
transactions   (id, tenant_id, type income|expense, amount numeric,
                concept, client_id null, service_id null,
                date, created_by, created_at)
invoices       (id, tenant_id, client_id, number, lines jsonb,
                total numeric, status draft|sent|paid, date, created_at)
reminders      (id, tenant_id, due_at, message, status, created_at)
audit_log      (id, tenant_id, user_id, tool_name, payload jsonb,
                result jsonb, confirmed boolean, created_at)
agent_sessions (id, tenant_id, user_id, rolling_summary text, updated_at)
```

Reglas: importes como `numeric`, nunca float. Fechas en UTC. Soft-delete no necesario en v39.

---

## 4. EL ROUTER (palanca de coste)

```
Entrada usuario
  │
  ├─ NIVEL 0 · Parser determinista (regex + diccionario de servicios/clientes)
  │    patrón "(ingreso|gasto) <importe> <concepto> [cliente]" → tool directa, 0€
  │    objetivo: resolver 40-60% de las consultas sin tocar el LLM
  │
  ├─ NIVEL 1 · gpt-4.1-mini con tool calling — frase natural, 1 acción
  │
  ├─ NIVEL 2 · gpt-4.1-mini con tools encadenadas — multi-paso
  │
  └─ NIVEL 3 · modelo grande (claude-sonnet / gpt-4.1) — análisis, interpretación
       criterio de subida: la consulta pide comparación temporal, predicción,
       o el nivel 1 devolvió confianza baja / error de tool dos veces
```

Implementar `router.ts` con métrica: loggear nivel usado y coste estimado por consulta. Objetivo: coste medio <0,002€/consulta.

---

## 5. LAS 12 TOOLS (schemas estrictos)

Cada tool: schema JSON, validación con Zod en servidor, registro en audit_log.
Las tools de ESCRITURA devuelven `{ confirm_required: true, preview: {...} }` y solo ejecutan tras confirmación del usuario en UI.

| Tool | Tipo | Parámetros clave |
|---|---|---|
| `create_income` | escritura | amount, concept, client_id?, service_id?, date? |
| `create_expense` | escritura | amount, concept, date? |
| `create_invoice` | escritura | client_id, lines[{service_id?, concept, amount}], date? |
| `create_client` | escritura | name, phone?, email? |
| `create_reminder` | escritura | due_at, message |
| `draft_message` | escritura* | client_id, purpose, tone? (*genera borrador, no envía) |
| `send_to_gestoria` | escritura | period, format (stub en v39: genera el export, no envía) |
| `find_client` | lectura | query (fuzzy match por nombre) |
| `find_service` | lectura | query |
| `get_balance` | lectura | period? |
| `get_pending_invoices` | lectura | — |
| `get_date` | lectura | relative_expr ("ayer", "el martes pasado") |

Reglas de implementación:
- `find_client` con match difuso: si hay >1 candidato, el agente pregunta; si hay 0, ofrece crear.
- Tools de lectura pueden ejecutarse en paralelo; tools de escritura SIEMPRE secuenciales y confirmadas.
- Ninguna tool acepta SQL libre ni campos no tipados.

---

## 6. SYSTEM PROMPT DEL AGENTE

```
Eres el agente operativo de {business_name}.
Perfil del negocio: {business_profile}
Fecha actual: {today}

REGLAS DURAS:
1. Solo actúas mediante tools. Nunca inventes datos financieros ni IDs.
2. Importe ambiguo o ausente → pregunta. Nunca adivines dinero.
3. Cliente ambiguo (varios matches) → pregunta mostrando opciones.
4. Fechas relativas → resuélvelas con get_date antes de cualquier escritura.
5. Acciones de escritura: presenta el preview y espera confirmación.
6. Peticiones fuera del negocio → redirige en una frase.
7. Responde en español, máximo 2 frases antes de la tool call.

MEMORIA: {rolling_summary}
```

El `business_profile` y el system prompt se marcan para **prompt caching**.

### Memoria (memory.ts)
- `rolling_summary`: tras cada turno, si la sesión supera ~10 mensajes, comprimir a resumen de ≤200 tokens con el modelo pequeño.
- `business_profile`: jsonb en tenants — sector, servicios típicos con precios, horario, nombre de la gestoría. Se edita en UI, no por el agente.

---

## 7. UI MÍNIMA (web)

1. **Chat** con input de texto (voz en v41, no ahora).
2. **Tarjeta de confirmación**: cuando una tool devuelve `confirm_required`, mostrar preview (acción, importe, cliente, fecha) con botones Confirmar / Editar / Cancelar.
3. **Vista tesorería**: tabla simple de transacciones + saldo del mes.
4. Nada más. Sin dashboards, sin gráficas, sin settings complejos en v39.

---

## 8. SEGURIDAD v39 (local)

- `.env.local` para secretos (patrón ya establecido); `.env.example` sin valores.
- Validación Zod de TODOS los inputs (UI y tools).
- El agente recibe IDs y agregados, nunca volcado completo de tablas.
- Auth simple (1 usuario) en v39; preparado para multi-usuario en v40.
- Sin puertos expuestos fuera de localhost en esta fase.

---

## 9. CRITERIOS DE ACEPTACIÓN (test de las 5 frases)

> ⚠️ PEGAR AQUÍ las 5 frases de prueba de v38.1.
> Cada una debe resolverse correctamente, con confirmación, y quedar en audit_log.

```
1. [FRASE 1]
2. [FRASE 2]
3. [FRASE 3]
4. [FRASE 4]
5. [FRASE 5]
```

Además, deben pasar estos casos límite:
- "ingreso de maría" (sin importe) → el agente PREGUNTA el importe
- "factura a García" con dos clientes García → el agente muestra opciones
- "apunta 50 de ayer" → fecha resuelta correctamente vía get_date
- Tool inexistente o payload inválido → error controlado, nunca crash
- Cancelar una confirmación → no se escribe nada y queda registrado en audit_log

Tests automatizados (vitest): mínimo cada tool con caso válido + caso inválido, y el parser determinista con 15 frases de ejemplo.

---

## 10. ORDEN DE CONSTRUCCIÓN (para Claude Code)

1. Esqueleto: docker-compose (postgres) + Hono + Drizzle + migración inicial
2. Las 12 tools con validación Zod + audit_log (sin LLM aún, vía endpoint REST de prueba)
3. Parser determinista (nivel 0) + sus 15 tests
4. Integración OpenRouter con tool calling nativo + router niveles 1-3
5. Memoria (rolling_summary + business_profile con caching)
6. UI chat + tarjeta de confirmación + vista tesorería
7. Pasar los criterios de aceptación de la sección 9

**Fuera de alcance v39 (NO construir aunque sea tentador):** multi-tenant activo, portal gestoría, WhatsApp, voz, VeriFactu, multi-agente, pagos. Todo eso es v40+.

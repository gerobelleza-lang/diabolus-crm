-- ============================================================================
-- MIGRACIÓN: Sistema de Memoria Conversacional de Diablilla
-- Fecha: 27 Jun 2026
-- Autor: Agente Diabolus
-- Estado: PENDIENTE APROBACIÓN DE MIGUEL
--
-- Tablas:
--   1. conversation_history — cada mensaje usuario↔Diablilla
--   2. conversation_summaries — resúmenes automáticos cada ~20 mensajes
--   3. salon_ai_config — cerebro elegido por salón (rapida/inteligente/brillante)
--
-- Todas con RLS por tenant desde creación.
-- ============================================================================

-- ─── 1. CONVERSATION_HISTORY ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_history (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  salon_id    UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  user_id     UUID,
  channel     TEXT NOT NULL DEFAULT 'web'
              CHECK (channel IN ('web', 'telegram', 'whatsapp')),
  role        TEXT NOT NULL
              CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Índice principal: buscar mensajes de un salón ordenados por fecha
CREATE INDEX IF NOT EXISTS idx_conv_history_salon_created
  ON conversation_history(salon_id, created_at DESC);

-- Índice secundario: buscar por usuario dentro de un salón
CREATE INDEX IF NOT EXISTS idx_conv_history_salon_user
  ON conversation_history(salon_id, user_id);

-- RLS
ALTER TABLE conversation_history ENABLE ROW LEVEL SECURITY;

-- Los usuarios autenticados solo ven conversaciones de su salón
CREATE POLICY "conv_history_tenant_access"
  ON conversation_history FOR ALL
  USING (
    salon_id = COALESCE(
      (current_setting('request.jwt.claims', true)::json->>'salon_id')::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  );

-- Service role tiene acceso total (para el agente backend)
CREATE POLICY "conv_history_service_role"
  ON conversation_history FOR ALL
  USING (current_setting('role', true) = 'service_role');

-- ─── 2. CONVERSATION_SUMMARIES ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  salon_id      UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  summary       TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conv_summaries_salon
  ON conversation_summaries(salon_id, created_at DESC);

ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conv_summaries_tenant_access"
  ON conversation_summaries FOR ALL
  USING (
    salon_id = COALESCE(
      (current_setting('request.jwt.claims', true)::json->>'salon_id')::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  );

CREATE POLICY "conv_summaries_service_role"
  ON conversation_summaries FOR ALL
  USING (current_setting('role', true) = 'service_role');

-- ─── 3. SALON_AI_CONFIG ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS salon_ai_config (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  salon_id          UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE UNIQUE,
  brain_tier        TEXT NOT NULL DEFAULT 'rapida'
                    CHECK (brain_tier IN ('rapida', 'inteligente', 'brillante')),
  custom_greeting   TEXT,
  personality_notes TEXT,
  updated_at        TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE salon_ai_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salon_ai_config_tenant_access"
  ON salon_ai_config FOR ALL
  USING (
    salon_id = COALESCE(
      (current_setting('request.jwt.claims', true)::json->>'salon_id')::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  );

CREATE POLICY "salon_ai_config_service_role"
  ON salon_ai_config FOR ALL
  USING (current_setting('role', true) = 'service_role');

-- ─── FIN ─────────────────────────────────────────────────────────────────────
-- Ejecutar en Supabase Dashboard → SQL Editor
-- Las 3 tablas quedan protegidas por RLS desde el primer momento.

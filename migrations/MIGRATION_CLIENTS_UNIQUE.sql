-- ============================================================================
-- MIGRACIÓN: clients — NIF column + Unique Partial Indexes
-- Fecha: 2 Jul 2026
-- Prerrequisito: Query de duplicados ejecutada — 0 duplicados encontrados
-- ============================================================================

-- 1. Añadir columna nif a clients (nullable)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS nif TEXT;

-- 2. Índice único parcial: (salon_id, phone) — solo cuando phone no es null
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_salon_phone_unique
  ON clients (salon_id, phone)
  WHERE phone IS NOT NULL;

-- 3. Índice único parcial: (salon_id, email) — normalizado a lowercase
--    NOTA: El código debe hacer .toLowerCase() ANTES del insert
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_salon_email_unique
  ON clients (salon_id, lower(email))
  WHERE email IS NOT NULL;

-- 4. Índice único parcial: (salon_id, nif) — normalizado a uppercase sin espacios
--    NOTA: El código debe hacer .toUpperCase().replace(/[\s.-]/g,'') ANTES del insert
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_salon_nif_unique
  ON clients (salon_id, upper(nif))
  WHERE nif IS NOT NULL;

-- ============================================================================
-- VERIFICACIÓN post-ejecución:
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'clients';
-- Debe mostrar los 3 nuevos índices.
-- ============================================================================

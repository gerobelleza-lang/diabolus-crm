-- 🔐 Bloque 3 Security Audit — Enable RLS on demonio_conversaciones + beta_invites
-- 28-Jun-2026

-- ─────────────────────────────────────────────────────────────────────────────
-- 1️⃣ demonio_conversaciones — RLS ENABLE
-- ─────────────────────────────────────────────────────────────────────────────
-- Estructura esperada: id, lead_id, salon_id, role, content, created_at
-- RLS Policy: Solo el salon owner puede VER/INSERT sus conversaciones

ALTER TABLE public.demonio_conversaciones ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see conversations from their own salon
CREATE POLICY demonio_conversations_select_own_salon ON public.demonio_conversaciones
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.salons s
      WHERE s.id = demonio_conversaciones.salon_id
      AND s.user_id = auth.uid()
    )
  );

-- Policy: Users can insert conversations for their salon
CREATE POLICY demonio_conversations_insert_own_salon ON public.demonio_conversaciones
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.salons s
      WHERE s.id = demonio_conversaciones.salon_id
      AND s.user_id = auth.uid()
    )
  );

-- Policy: Block UPDATE/DELETE (append-only for lead conversations)
CREATE POLICY demonio_conversations_no_modify ON public.demonio_conversaciones
  FOR UPDATE
  USING (false);

CREATE POLICY demonio_conversations_no_delete ON public.demonio_conversaciones
  FOR DELETE
  USING (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2️⃣ beta_invites — RLS ENABLE
-- ─────────────────────────────────────────────────────────────────────────────
-- Estructura esperada: id, email, code, created_by, used_at, created_at
-- RLS Policy: Only admins can create/view invites (created_by = auth.uid())

ALTER TABLE public.beta_invites ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see invites they created
CREATE POLICY beta_invites_select_own ON public.beta_invites
  FOR SELECT
  USING (
    created_by = auth.uid()
    OR
    -- OR service role queries (admin)
    auth.jwt() ->> 'role' = 'service_role'
  );

-- Policy: Users can create invites (stored in created_by)
CREATE POLICY beta_invites_insert_own ON public.beta_invites
  FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
  );

-- Policy: Users can only delete their own unused invites
CREATE POLICY beta_invites_delete_own ON public.beta_invites
  FOR DELETE
  USING (
    created_by = auth.uid()
    AND used_at IS NULL
  );

-- Block UPDATE (invites are write-once)
CREATE POLICY beta_invites_no_update ON public.beta_invites
  FOR UPDATE
  USING (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3️⃣ Grant USAGE to service_role (internal access via Edge Functions)
-- ─────────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.demonio_conversaciones TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.beta_invites TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT: Log this security change
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.audit_log (salon_id, action, changes, created_at)
VALUES (
  null,
  'security_rls_enabled',
  '{"tables": ["demonio_conversaciones", "beta_invites"], "timestamp": "2026-06-28T16:00:00Z"}',
  NOW()
);

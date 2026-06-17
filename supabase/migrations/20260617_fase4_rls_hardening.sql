-- ═══════════════════════════════════════════════════════════════════════════
-- DIABOLUS — Fase 4, Item 1: RLS Hardening
-- Todas las tablas: RLS ON + políticas de aislamiento por tenant
-- Gestores: función security definer para acceso cross-tenant controlado
-- Storage: bucket invoices → privado; políticas explícitas en ambos buckets
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Función auxiliar: ¿tiene el gestor link activo con este salon? ─────────
-- SECURITY DEFINER: corre como owner (postgres), evita RLS recursivo
-- Usada en políticas de tablas cruzadas (gestor ↔ salon)
CREATE OR REPLACE FUNCTION public.gestor_has_active_link(
  p_gestor_id uuid,
  p_salon_id  uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.gestor_salon_links
    WHERE gestor_id = p_gestor_id
      AND salon_id  = p_salon_id
      AND status    = 'active'
  );
$$;

-- ─── 1. gestores ─────────────────────────────────────────────────────────────
ALTER TABLE public.gestores ENABLE ROW LEVEL SECURITY;

-- Un propietario de salon puede leer los datos básicos del gestor vinculado a él
CREATE POLICY gestores_linked_salon_owner ON public.gestores
  FOR SELECT TO authenticated
  USING (
    id IN (
      SELECT gsl.gestor_id
      FROM public.gestor_salon_links gsl
      JOIN public.salons s ON s.id = gsl.salon_id
      WHERE s.user_id = auth.uid()
        AND gsl.status = 'active'
    )
  );

-- Sin INSERT/UPDATE/DELETE directo — solo service_role (backend)

-- ─── 2. gestor_salon_links ───────────────────────────────────────────────────
ALTER TABLE public.gestor_salon_links ENABLE ROW LEVEL SECURITY;

-- Propietario ve los vínculos de su salon
CREATE POLICY gsl_salon_owner_select ON public.gestor_salon_links
  FOR SELECT TO authenticated
  USING (
    salon_id IN (
      SELECT id FROM public.salons WHERE user_id = auth.uid()
    )
  );

-- Sin INSERT/UPDATE/DELETE directo — solo service_role (backend gestionado)

-- ─── 3. gestor_messages ──────────────────────────────────────────────────────
ALTER TABLE public.gestor_messages ENABLE ROW LEVEL SECURITY;

-- Propietario de salon puede leer mensajes de su salon
CREATE POLICY gestor_messages_salon_select ON public.gestor_messages
  FOR SELECT TO authenticated
  USING (
    salon_id IN (
      SELECT id FROM public.salons WHERE user_id = auth.uid()
    )
  );

-- Propietario puede insertar mensajes (lado cliente del chat)
CREATE POLICY gestor_messages_salon_insert ON public.gestor_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    salon_id IN (
      SELECT id FROM public.salons WHERE user_id = auth.uid()
    )
  );

-- Sin UPDATE/DELETE — los mensajes son inmutables (append-only)

-- ─── 4. monthly_closings ─────────────────────────────────────────────────────
ALTER TABLE public.monthly_closings ENABLE ROW LEVEL SECURITY;

-- Propietario ve sus cierres
CREATE POLICY monthly_closings_salon_select ON public.monthly_closings
  FOR SELECT TO authenticated
  USING (
    salon_id IN (
      SELECT id FROM public.salons WHERE user_id = auth.uid()
    )
  );

-- Sin INSERT/UPDATE/DELETE — solo service_role (cron backend)

-- ─── 5. commission_ledger ────────────────────────────────────────────────────
ALTER TABLE public.commission_ledger ENABLE ROW LEVEL SECURITY;

-- Propietario ve su ledger de comisiones
CREATE POLICY commission_ledger_salon_select ON public.commission_ledger
  FOR SELECT TO authenticated
  USING (
    salon_id IN (
      SELECT id FROM public.salons WHERE user_id = auth.uid()
    )
  );

-- Sin INSERT/UPDATE/DELETE — append-only, solo service_role

-- ─── 6. gestor_commissions (tabla legacy, bloqueo total directo) ─────────────
ALTER TABLE public.gestor_commissions ENABLE ROW LEVEL SECURITY;
-- Sin políticas = ningún acceso para rol authenticated; service_role bypasses RLS

-- ─── 7. Completar políticas en tablas existentes ─────────────────────────────

-- clients: UPDATE + DELETE
CREATE POLICY clients_salon_owner_update ON public.clients
  FOR UPDATE TO authenticated
  USING (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()))
  WITH CHECK (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

CREATE POLICY clients_salon_owner_delete ON public.clients
  FOR DELETE TO authenticated
  USING (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

-- invoices: INSERT + UPDATE + bloquear DELETE (registros financieros inmutables)
CREATE POLICY invoices_salon_owner_insert ON public.invoices
  FOR INSERT TO authenticated
  WITH CHECK (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

CREATE POLICY invoices_salon_owner_update ON public.invoices
  FOR UPDATE TO authenticated
  USING (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()))
  WITH CHECK (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

CREATE POLICY invoices_no_delete ON public.invoices
  FOR DELETE TO authenticated
  USING (false);

-- transactions: UPDATE + bloquear DELETE (registros financieros inmutables)
CREATE POLICY transactions_salon_owner_update ON public.transactions
  FOR UPDATE TO authenticated
  USING (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()))
  WITH CHECK (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

CREATE POLICY transactions_no_delete ON public.transactions
  FOR DELETE TO authenticated
  USING (false);

-- services: INSERT + UPDATE + DELETE (maestro de servicios, editable)
CREATE POLICY services_salon_owner_insert ON public.services
  FOR INSERT TO authenticated
  WITH CHECK (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

CREATE POLICY services_salon_owner_update ON public.services
  FOR UPDATE TO authenticated
  USING (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()))
  WITH CHECK (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

CREATE POLICY services_salon_owner_delete ON public.services
  FOR DELETE TO authenticated
  USING (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

-- reminders: INSERT + UPDATE + DELETE
CREATE POLICY reminders_salon_owner_insert ON public.reminders
  FOR INSERT TO authenticated
  WITH CHECK (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

CREATE POLICY reminders_salon_owner_update ON public.reminders
  FOR UPDATE TO authenticated
  USING (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()))
  WITH CHECK (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

CREATE POLICY reminders_salon_owner_delete ON public.reminders
  FOR DELETE TO authenticated
  USING (salon_id IN (SELECT id FROM public.salons WHERE user_id = auth.uid()));

-- ─── 8. Storage: invoices bucket → privado ───────────────────────────────────
-- Bucket "invoices" estaba PUBLIC — PDFs de facturas son datos sensibles
-- Con 0 usuarios reales es el momento correcto de cerrarlo
UPDATE storage.buckets SET public = false WHERE id = 'invoices';

-- RLS para storage.objects (invoices bucket)
-- Solo el propietario del salon puede leer sus PDFs
CREATE POLICY invoices_bucket_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'invoices'
    AND (
      (storage.foldername(name))[1] IN (
        SELECT id::text FROM public.salons WHERE user_id = auth.uid()
      )
      OR owner = auth.uid()
    )
  );

CREATE POLICY invoices_bucket_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'invoices'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.salons WHERE user_id = auth.uid()
    )
  );

CREATE POLICY invoices_bucket_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'invoices'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.salons WHERE user_id = auth.uid()
    )
  );

-- RLS para chat-attachments bucket (ya privado, añadir políticas explícitas)
CREATE POLICY chat_attachments_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.salons WHERE user_id = auth.uid()
    )
  );

CREATE POLICY chat_attachments_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.salons WHERE user_id = auth.uid()
    )
  );


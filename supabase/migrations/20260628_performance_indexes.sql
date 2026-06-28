-- 🔧 BLOQUE 3c — PERFORMANCE INDEXES
-- 6 índices críticos para pre-launch
-- 28-Jun-2026

-- 1️⃣ invoices — cobros vencidas + estado
CREATE INDEX idx_invoices_salon_status_due ON public.invoices(salon_id, status, due_date)
WHERE status NOT IN ('paid', 'cancelled', 'draft');

-- 2️⃣ transactions — dashboard activity (recent first)
CREATE INDEX idx_transactions_salon_created ON public.transactions(salon_id, created_at DESC, type);

-- 3️⃣ clients — listados con paginación
CREATE INDEX idx_clients_salon_created ON public.clients(salon_id, created_at DESC);

-- 4️⃣ conversation_history — memoria Diablilla (recent msgs fast)
CREATE INDEX idx_conversation_history_salon_created ON public.conversation_history(salon_id, created_at DESC);

-- 5️⃣ cobros_cazador — historial Cazador (recent reminders fast)
CREATE INDEX idx_cobros_cazador_salon_estado_created ON public.cobros_cazador(salon_id, estado, created_at DESC);

-- 6️⃣ audit_log — compliance logs (recent audits fast)
CREATE INDEX idx_audit_log_salon_created ON public.audit_log(salon_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY — Run this after all indexes created to check sizes + performance
-- ─────────────────────────────────────────────────────────────────────────────
/*
SELECT
  schemaname, tablename, indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) as size
FROM pg_indexes
WHERE schemaname = 'public'
  AND (tablename IN ('invoices', 'transactions', 'clients', 'conversation_history', 'cobros_cazador', 'audit_log'))
ORDER BY pg_relation_size(indexrelid) DESC;

-- Expected sizes (depends on data volume):
-- Each index should be 1-50 MB (small tables = 1-10 MB)
-- Total should be < 500 MB
*/

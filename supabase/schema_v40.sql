-- Diabolus v40 Schema — Multi-tenant with RLS
-- Generated: 2026-06-12

-- SALONS (multi-tenant root)
CREATE TABLE IF NOT EXISTS salons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  profession_type TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_salons_user_id ON salons(user_id);

ALTER TABLE salons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_can_see_own_salons"
  ON salons FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_can_insert_salons"
  ON salons FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_can_update_own_salons"
  ON salons FOR UPDATE
  USING (auth.uid() = user_id);

-- CLIENTS
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_clients_salon_id ON clients(salon_id);

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_can_see_own_salon_clients"
  ON clients FOR SELECT
  USING (
    salon_id IN (
      SELECT id FROM salons WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "users_can_insert_own_salon_clients"
  ON clients FOR INSERT
  WITH CHECK (
    salon_id IN (
      SELECT id FROM salons WHERE user_id = auth.uid()
    )
  );

-- SERVICES
CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  default_price DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_services_salon_id ON services(salon_id);

ALTER TABLE services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_can_see_own_salon_services"
  ON services FOR SELECT
  USING (
    salon_id IN (
      SELECT id FROM salons WHERE user_id = auth.uid()
    )
  );

-- TRANSACTIONS
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  amount DECIMAL(10, 2) NOT NULL,
  concept TEXT NOT NULL,
  client_id UUID REFERENCES clients(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT DEFAULT 'paid' CHECK (status IN ('paid', 'pending')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_transactions_salon_id ON transactions(salon_id);
CREATE INDEX idx_transactions_date ON transactions(salon_id, date);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_can_see_own_salon_transactions"
  ON transactions FOR SELECT
  USING (
    salon_id IN (
      SELECT id FROM salons WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "users_can_insert_own_salon_transactions"
  ON transactions FOR INSERT
  WITH CHECK (
    salon_id IN (
      SELECT id FROM salons WHERE user_id = auth.uid()
    )
  );

-- INVOICES
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id),
  number TEXT NOT NULL,
  total DECIMAL(10, 2) NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid')),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_invoices_salon_id ON invoices(salon_id);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_can_see_own_salon_invoices"
  ON invoices FOR SELECT
  USING (
    salon_id IN (
      SELECT id FROM salons WHERE user_id = auth.uid()
    )
  );

-- REMINDERS
CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  due_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_reminders_salon_id ON reminders(salon_id);

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_can_see_own_salon_reminders"
  ON reminders FOR SELECT
  USING (
    salon_id IN (
      SELECT id FROM salons WHERE user_id = auth.uid()
    )
  );

-- AUDIT_LOG (append-only)
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  payload JSONB,
  result JSONB,
  confirmed BOOLEAN DEFAULT false,
  level SMALLINT CHECK (level BETWEEN 0 AND 3),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_audit_log_salon_id ON audit_log(salon_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_can_see_own_salon_audit"
  ON audit_log FOR SELECT
  USING (
    salon_id IN (
      SELECT id FROM salons WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "users_can_insert_own_salon_audit"
  ON audit_log FOR INSERT
  WITH CHECK (
    salon_id IN (
      SELECT id FROM salons WHERE user_id = auth.uid()
    )
  );

-- Prevent UPDATE/DELETE on audit_log
CREATE POLICY "audit_log_no_update"
  ON audit_log FOR UPDATE
  USING (false);

CREATE POLICY "audit_log_no_delete"
  ON audit_log FOR DELETE
  USING (false);

-- Triggers
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_salons_timestamp BEFORE UPDATE ON salons
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER update_clients_timestamp BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

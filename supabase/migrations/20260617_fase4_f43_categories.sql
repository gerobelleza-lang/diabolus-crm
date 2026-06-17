-- ═══════════════════════════════════════════════════════════════════════════════
-- F4-3: Categorías y Etiquetas
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. CATEGORIES TABLE
CREATE TABLE IF NOT EXISTS categories (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  slug       text        NOT NULL,
  label      text        NOT NULL,
  salon_id   uuid        REFERENCES salons(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

-- Unique: un slug global no puede repetirse; un slug custom tampoco por tenant
CREATE UNIQUE INDEX IF NOT EXISTS categories_slug_global
  ON categories(slug) WHERE salon_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS categories_slug_tenant
  ON categories(slug, salon_id) WHERE salon_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS categories_salon_idx
  ON categories(salon_id);

-- 2. tags TEXT[] en transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS transactions_tags_gin ON transactions USING GIN(tags);

-- 3. SEED categorías estándar globales
INSERT INTO categories (slug, label, salon_id) VALUES
  ('material',               'Material y suministros',   null),
  ('alquiler',               'Alquiler',                  null),
  ('transporte',             'Transporte',                null),
  ('dietas',                 'Dietas y comidas',          null),
  ('software',               'Software y suscripciones',  null),
  ('comunicaciones',         'Comunicaciones',            null),
  ('marketing',              'Marketing y publicidad',    null),
  ('seguros',                'Seguros',                   null),
  ('servicios_profesionales','Servicios profesionales',   null),
  ('servicios',              'Servicios prestados',       null),
  ('otros',                  'Otros',                     null)
ON CONFLICT DO NOTHING;

-- 4. RLS
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "categories_service_all"   ON categories;
DROP POLICY IF EXISTS "categories_read_all"      ON categories;

-- Service role: acceso total (backend usa admin key)
CREATE POLICY "categories_service_all" ON categories
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Usuarios autenticados: solo lectura (global + su tenant)
CREATE POLICY "categories_read_all" ON categories
  FOR SELECT TO authenticated
  USING (salon_id IS NULL OR salon_id IN (
    SELECT salon_id FROM salon_users WHERE user_id = auth.uid()
  ));

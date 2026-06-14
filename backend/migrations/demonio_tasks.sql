-- Create demonio_tasks table for N8N workflow tracking

CREATE TABLE IF NOT EXISTS demonio_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id UUID NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL, -- "import_clients", "reconcile_bank", etc
  status TEXT NOT NULL DEFAULT 'pending', -- pending, executing, requires_approval, completed, failed, rejected
  data JSONB, -- CSV data, files, params, etc
  preview JSONB, -- Preview de cambios antes de aprobar
  result JSONB, -- Resultado final
  error TEXT,
  auto_approve BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Índices para búsqueda rápida
CREATE INDEX idx_demonio_tasks_salon ON demonio_tasks(salon_id);
CREATE INDEX idx_demonio_tasks_user ON demonio_tasks(user_id);
CREATE INDEX idx_demonio_tasks_status ON demonio_tasks(status);
CREATE INDEX idx_demonio_tasks_created ON demonio_tasks(created_at DESC);

-- RLS Policy: Solo el propietario puede ver sus tareas
ALTER TABLE demonio_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own demonio tasks"
  ON demonio_tasks
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own demonio tasks"
  ON demonio_tasks
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own demonio tasks"
  ON demonio_tasks
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Service role can do everything (N8N callbacks)
CREATE POLICY "Service role can manage demonio tasks"
  ON demonio_tasks
  USING (current_setting('role') = 'postgres');

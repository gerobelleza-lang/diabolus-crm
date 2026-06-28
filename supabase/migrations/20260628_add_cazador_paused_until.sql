-- Migration: Add cazador_paused_until column to clients table
-- Date: 28 Jun 2026
-- Feature: 1.16 Pausa manual Cazador
-- Purpose: Allow pausing Cazador reminders per client until a specific date

ALTER TABLE public.clients
ADD COLUMN cazador_paused_until timestamp with time zone DEFAULT NULL;

-- Create index for performance when checking pause status
CREATE INDEX idx_clients_cazador_paused_until
ON public.clients(cazador_paused_until)
WHERE cazador_paused_until IS NOT NULL;

-- Comment for documentation
COMMENT ON COLUMN public.clients.cazador_paused_until IS
'ISO timestamp until which Cazador reminders are paused for this client. NULL = not paused. Used in runCazador() to skip paused clients.';

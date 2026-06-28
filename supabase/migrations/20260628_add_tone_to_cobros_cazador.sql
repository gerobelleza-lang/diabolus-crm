-- Migration: Add tone column to cobros_cazador table
-- Date: 28 Jun 2026
-- Feature: 1.17 Tono adaptativo Cazador
-- Purpose: Track tone (friendly/direct/formal) for each Cazador reminder

ALTER TABLE public.cobros_cazador
ADD COLUMN tone text DEFAULT 'direct' CHECK (tone IN ('friendly', 'direct', 'formal'));

-- Create index for filtering by tone
CREATE INDEX idx_cobros_cazador_tone
ON public.cobros_cazador(tone)
WHERE tone IS NOT NULL;

-- Comment for documentation
COMMENT ON COLUMN public.cobros_cazador.tone IS
'Tone of the reminder: "friendly" (1-2 days), "direct" (3-6 days), "formal" (7+ days). Automatically set based on diasVencida.';

-- Add commentary_log JSONB column to matches table for persisting ball-by-ball commentary
ALTER TABLE matches ADD COLUMN IF NOT EXISTS commentary_log JSONB DEFAULT '[]'::jsonb;

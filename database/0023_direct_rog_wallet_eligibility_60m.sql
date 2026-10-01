-- 0023_direct_rog_wallet_eligibility_60m
-- PHARAOH DIRECT: eligibility ricostruibile dal wallet.
-- T0 = created_at della nuova posizione HUMAN ROG; validita = 60 minuti.
-- Una HUMAN ROG resta monouso grazie a uq_direct_sessions_rog_human_position.

ALTER TABLE direct_donation_sessions
  ADD COLUMN IF NOT EXISTS rog_eligibility_source TEXT,
  ADD COLUMN IF NOT EXISTS rog_eligibility_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rog_eligibility_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rog_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rog_claim_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_direct_sessions_wallet_eligibility
  ON direct_donation_sessions ((LOWER(wallet)), rog_eligibility_expires_at DESC)
  WHERE rog_human_position IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_direct_sessions_claim
  ON direct_donation_sessions (rog_claim_expires_at)
  WHERE rog_claimed_at IS NOT NULL AND completed_at IS NULL;

CREATE TABLE IF NOT EXISTS direct_donation_sessions (
  session_ref TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMMUNITY_CONFIRMED'
    CHECK (status IN ('COMMUNITY_CONFIRMED','ROG_CONFIRMING','ROG_CONFIRMED','PHARAOH_VERIFIED','REGISTRY_SUBMITTED','REGISTRY_CONFIRMED','POSITION_ASSIGNED','CANCELLED')),
  rog_amount_usdc NUMERIC(12,2) NOT NULL DEFAULT 2 CHECK (rog_amount_usdc = 2),
  rog_usdc_tx_hash TEXT,
  rog_register_tx_hash TEXT,
  rog_donation_id TEXT,
  rog_proof JSONB,
  rog_result JSONB,
  rog_confirmed_at TIMESTAMPTZ,
  pharaoh_amount_usdc NUMERIC(12,2) CHECK (pharaoh_amount_usdc IS NULL OR pharaoh_amount_usdc = 100),
  pharaoh_tx_hash TEXT,
  pharaoh_proof JSONB,
  pharaoh_verified_at TIMESTAMPTZ,
  registry_tx_hash TEXT,
  registry_session_id BIGINT,
  registry_block_number BIGINT,
  registry_confirmed_at TIMESTAMPTZ,
  position_result JSONB,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_direct_sessions_wallet ON direct_donation_sessions ((LOWER(wallet)));
CREATE INDEX IF NOT EXISTS idx_direct_sessions_status ON direct_donation_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_sessions_rog_usdc_tx_lower ON direct_donation_sessions ((LOWER(rog_usdc_tx_hash))) WHERE rog_usdc_tx_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_sessions_rog_register_tx_lower ON direct_donation_sessions ((LOWER(rog_register_tx_hash))) WHERE rog_register_tx_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_sessions_rog_donation_id ON direct_donation_sessions (rog_donation_id) WHERE rog_donation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_sessions_pharaoh_tx_lower ON direct_donation_sessions ((LOWER(pharaoh_tx_hash))) WHERE pharaoh_tx_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_sessions_registry_tx_lower ON direct_donation_sessions ((LOWER(registry_tx_hash))) WHERE registry_tx_hash IS NOT NULL;

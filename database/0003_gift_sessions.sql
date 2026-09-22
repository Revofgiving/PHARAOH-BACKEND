ALTER TABLE donazioni
  ADD COLUMN IF NOT EXISTS beneficiary_wallet TEXT,
  ADD COLUMN IF NOT EXISTS source_platform TEXT,
  ADD COLUMN IF NOT EXISTS source_event_key TEXT,
  ADD COLUMN IF NOT EXISTS positions_created INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_donazioni_positions_created') THEN
    ALTER TABLE donazioni ADD CONSTRAINT chk_donazioni_positions_created CHECK (positions_created IS NULL OR positions_created >= 0) NOT VALID;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_donazioni_source_event ON donazioni (source_platform, source_event_key) WHERE source_platform IS NOT NULL AND source_event_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS gift_sessions (
  gift_id TEXT PRIMARY KEY,
  payment_wallet TEXT NOT NULL,
  beneficiary_wallet TEXT NOT NULL,
  gift_message TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED','ROG_PAYMENT_CONFIRMED','ROG_REGISTERED','ROG_COMPLETED','PHARAOH_VERIFIED','POSITION_ASSIGNED','CANCELLED')),
  rog_amount_usdc NUMERIC(12,2) NOT NULL DEFAULT 2 CHECK (rog_amount_usdc = 2),
  rog_usdc_tx_hash TEXT,
  rog_register_tx_hash TEXT,
  rog_donation_id TEXT,
  rog_transfer_proof JSONB,
  rog_registration_proof JSONB,
  rog_result JSONB,
  rog_completed_at TIMESTAMPTZ,
  pharaoh_amount_usdc NUMERIC(12,2) CHECK (pharaoh_amount_usdc IS NULL OR pharaoh_amount_usdc = 100),
  pharaoh_tx_hash TEXT,
  pharaoh_proof JSONB,
  pharaoh_verified_at TIMESTAMPTZ,
  beneficiary_was_community_member BOOLEAN,
  beneficiary_community_checked_at TIMESTAMPTZ,
  position_result JSONB,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gift_distinct_wallets_check CHECK (payment_wallet <> beneficiary_wallet)
);
CREATE INDEX IF NOT EXISTS idx_gift_sessions_payment_wallet ON gift_sessions ((LOWER(payment_wallet)));
CREATE INDEX IF NOT EXISTS idx_gift_sessions_beneficiary_wallet ON gift_sessions ((LOWER(beneficiary_wallet)));
CREATE INDEX IF NOT EXISTS idx_gift_sessions_status ON gift_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_sessions_rog_usdc_tx_lower ON gift_sessions ((LOWER(rog_usdc_tx_hash))) WHERE rog_usdc_tx_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_sessions_rog_register_tx_lower ON gift_sessions ((LOWER(rog_register_tx_hash))) WHERE rog_register_tx_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_sessions_rog_donation_id ON gift_sessions (rog_donation_id) WHERE rog_donation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_sessions_pharaoh_tx_lower ON gift_sessions ((LOWER(pharaoh_tx_hash))) WHERE pharaoh_tx_hash IS NOT NULL;

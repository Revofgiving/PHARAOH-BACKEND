-- Hardening della baseline DIRECT anche quando 0002 era gia applicata con checksum legacy.
-- NOT VALID applica subito il vincolo ai nuovi dati; VALIDATE blocca il deploy se
-- esistono sessioni storiche incompatibili che richiedono riconciliazione esplicita.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_direct_sessions_rog_exact_2' AND conrelid = 'direct_donation_sessions'::regclass) THEN
    ALTER TABLE direct_donation_sessions
      ADD CONSTRAINT chk_direct_sessions_rog_exact_2 CHECK (rog_amount_usdc = 2) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_direct_sessions_pharaoh_exact_100' AND conrelid = 'direct_donation_sessions'::regclass) THEN
    ALTER TABLE direct_donation_sessions
      ADD CONSTRAINT chk_direct_sessions_pharaoh_exact_100
      CHECK (pharaoh_amount_usdc IS NULL OR pharaoh_amount_usdc = 100) NOT VALID;
  END IF;
END $$;
ALTER TABLE direct_donation_sessions VALIDATE CONSTRAINT chk_direct_sessions_rog_exact_2;
ALTER TABLE direct_donation_sessions VALIDATE CONSTRAINT chk_direct_sessions_pharaoh_exact_100;

CREATE TABLE IF NOT EXISTS cross_entry_events (
  event_key TEXT PRIMARY KEY,
  source_platform TEXT NOT NULL CHECK (source_platform = 'URANUS_TO_PHARAOH'),
  payment_wallet TEXT NOT NULL,
  beneficiary_wallet TEXT NOT NULL,
  destination_wallet TEXT NOT NULL,
  amount_usdc NUMERIC(12,2) NOT NULL CHECK (amount_usdc > 0 AND MOD(amount_usdc, 100) = 0),
  positions_expected INTEGER NOT NULL CHECK (positions_expected > 0 AND positions_expected <= 100),
  CONSTRAINT chk_cross_entry_amount_positions CHECK (amount_usdc = positions_expected * 100),
  payment_tx_hash TEXT NOT NULL,
  blockchain_proof JSONB,
  position_result JSONB,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','BLOCKCHAIN_VERIFIED','POSITION_ASSIGNED','FAILED','CANCELLED')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cross_entry_payment_tx_lower ON cross_entry_events ((LOWER(payment_tx_hash)));
CREATE INDEX IF NOT EXISTS idx_cross_entry_beneficiary ON cross_entry_events ((LOWER(beneficiary_wallet)));
CREATE INDEX IF NOT EXISTS idx_cross_entry_status ON cross_entry_events(status);

CREATE TABLE IF NOT EXISTS rha_exit_allocations (
  rha_event_key TEXT PRIMARY KEY,
  beneficiary_wallet TEXT NOT NULL,
  turno BIGINT,
  staff_omaggi_reserved_usdc NUMERIC(12,2) NOT NULL DEFAULT 200 CHECK (staff_omaggi_reserved_usdc = 200),
  rog_usdc NUMERIC(12,2) NOT NULL DEFAULT 200 CHECK (rog_usdc = 200),
  uranus_usdc NUMERIC(12,2) NOT NULL DEFAULT 100 CHECK (uranus_usdc = 100),
  staff_omaggi_status TEXT NOT NULL DEFAULT 'SUSPENDED' CHECK (staff_omaggi_status IN ('SUSPENDED','ALLOCATED')),
  repayable BOOLEAN NOT NULL DEFAULT FALSE CHECK (repayable = FALSE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cross_outbound_operations (
  event_key TEXT PRIMARY KEY,
  rha_event_key TEXT NOT NULL REFERENCES rha_exit_allocations(rha_event_key),
  target_platform TEXT NOT NULL CHECK (target_platform IN ('ROG','URANUS')),
  source_wallet TEXT NOT NULL,
  beneficiary_wallet TEXT NOT NULL,
  destination_wallet TEXT NOT NULL,
  amount_usdc NUMERIC(12,2) NOT NULL CHECK (amount_usdc > 0),
  positions_expected INTEGER NOT NULL CHECK (positions_expected > 0),
  CONSTRAINT chk_cross_outbound_protocol_spec CHECK (
    (target_platform = 'ROG' AND amount_usdc = 200 AND positions_expected = 100) OR
    (target_platform = 'URANUS' AND amount_usdc = 100 AND positions_expected = 5)
  ),
  sender_nonce BIGINT,
  payment_tx_hash TEXT,
  blockchain_proof JSONB,
  notify_response JSONB,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','TRANSFER_SUBMITTING','FUNDS_CONFIRMED','NOTIFY_PENDING','COMPLETED','FAILED','RECONCILIATION_REQUIRED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  funds_confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cross_outbound_tx_lower ON cross_outbound_operations ((LOWER(payment_tx_hash))) WHERE payment_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cross_outbound_status ON cross_outbound_operations(status, created_at);
CREATE INDEX IF NOT EXISTS idx_cross_outbound_rha ON cross_outbound_operations(rha_event_key);

-- RHA legacy: qualunque vecchio credito L3 non deve piu generare debito/restituzione.
-- Gli STANDBY restano sospesi e vengono esclusi dalla FIFO automatica dal codice applicativo.
UPDATE doni_credito
SET obbligo_restituzione = FALSE,
    stato_restituzione = CASE
      WHEN stato_restituzione = 'RESTITUITO' THEN 'RESTITUITO'
      ELSE 'NON_DOVUTO'
    END,
    natura = CASE WHEN status = 'STANDBY' THEN 'OMAGGIO_RHA_LEGACY_SOSPESO' ELSE 'OMAGGIO_RHA_LEGACY' END
WHERE rilasciato_al_livello = 3;

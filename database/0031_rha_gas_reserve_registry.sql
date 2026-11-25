-- PHARAOH 0031: gas reserve accounting for verified RHA gross 6000 / net 5995.
-- Additive only. No historic backfill, no changes to wallets or transfers.
CREATE TABLE IF NOT EXISTS pharaoh_gas_reserve_entries (
  payout_id bigint PRIMARY KEY REFERENCES doni_pendenti(id),
  source_event_key text NOT NULL UNIQUE,
  account_id bigint NOT NULL REFERENCES accounts(id),
  reserve_bucket text NOT NULL UNIQUE REFERENCES pharaoh_economic_buckets(bucket_key),
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic = 5000000),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','AVAILABLE','REVIEW_REQUIRED')),
  confirmed_payout_tx_hash text,
  available_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='AVAILABLE') = (available_at IS NOT NULL AND confirmed_payout_tx_hash IS NOT NULL)),
  CHECK (confirmed_payout_tx_hash IS NULL OR confirmed_payout_tx_hash ~ '^0x[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_pharaoh_gas_reserve_status ON pharaoh_gas_reserve_entries(status);
-- NOTE: balances remain in pharaoh_economic_buckets and are NOT counted twice.

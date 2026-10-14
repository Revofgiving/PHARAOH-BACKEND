-- PHARAOH 0026: additive accounting and S0 materialization.
-- No UPDATE/DELETE/TRUNCATE of pre-existing accounts, positions, wallets or history.
-- No implicit backfill: existing data require a reviewed cutover manifest.
-- The tables do NOT activate the new runtime or authorize any transfer.
CREATE TABLE IF NOT EXISTS pharaoh_economic_activation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','PAUSED')),
  mode text CHECK (mode IN ('FRESH','ADOPTED')),
  evidence_hash text,
  cutover_block_number bigint,
  cutover_block_hash text,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status <> 'ACTIVE' OR (mode IS NOT NULL AND evidence_hash IS NOT NULL AND evidence_hash ~ '^[0-9a-f]{64}$' AND activated_at IS NOT NULL)),
  CHECK(mode IS DISTINCT FROM 'ADOPTED' OR (cutover_block_number IS NOT NULL AND cutover_block_hash IS NOT NULL AND cutover_block_number > 0 AND cutover_block_hash ~ '^0x[0-9a-f]{64}$'))
);
INSERT INTO pharaoh_economic_activation(singleton) VALUES(true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS pharaoh_economic_events (
  event_key text PRIMARY KEY CHECK (length(event_key) BETWEEN 1 AND 512),
  kind text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'STARTED' CHECK (status IN ('STARTED','COMPLETED')),
  context jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS pharaoh_economic_buckets (
  bucket_key text PRIMARY KEY,
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$' AND wallet <> '0x0000000000000000000000000000000000000000'),
  purpose text NOT NULL,
  balance_atomic numeric(78,0) NOT NULL DEFAULT 0 CHECK (balance_atomic >= 0),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pharaoh_buckets_wallet ON pharaoh_economic_buckets(wallet);
CREATE TABLE IF NOT EXISTS pharaoh_economic_journal (
  event_key text NOT NULL REFERENCES pharaoh_economic_events(event_key),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  bucket_key text NOT NULL REFERENCES pharaoh_economic_buckets(bucket_key),
  delta_atomic numeric(78,0) NOT NULL CHECK (delta_atomic <> 0),
  balance_after_atomic numeric(78,0) NOT NULL CHECK (balance_after_atomic >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(event_key, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_pharaoh_journal_bucket ON pharaoh_economic_journal(bucket_key);
CREATE TABLE IF NOT EXISTS pharaoh_economic_proofs (
  proof_key text PRIMARY KEY,
  event_key text NOT NULL REFERENCES pharaoh_economic_events(event_key),
  chain_id numeric(78,0) NOT NULL CHECK(chain_id > 0),
  token text NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL CHECK(log_index >= 0),
  proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id, token, tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS pharaoh_account_economics (
  account_id bigint PRIMARY KEY REFERENCES accounts(id),
  root_account_id bigint NOT NULL REFERENCES accounts(id),
  position_class text NOT NULL CHECK(position_class IN ('HUMAN','PILETTA','FONDO_A','CASSA_PROGETTI','LEGACY_CASSA')),
  owner_wallet text,
  custody_wallet text NOT NULL,
  origin text NOT NULL,
  source_event_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((position_class='PILETTA' AND owner_wallet IS NULL) OR
         (position_class<>'PILETTA' AND owner_wallet IS NOT NULL)),
  CHECK(custody_wallet ~ '^0x[0-9a-f]{40}$'),
  CHECK(owner_wallet IS NULL OR owner_wallet ~ '^0x[0-9a-f]{40}$')
);
CREATE TABLE IF NOT EXISTS pharaoh_s0_counters (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  human_cumulative bigint NOT NULL DEFAULT 0 CHECK(human_cumulative >= 0),
  piletta_cumulative bigint NOT NULL DEFAULT 0 CHECK(piletta_cumulative >= 0 AND piletta_cumulative <= human_cumulative),
  seeded boolean NOT NULL DEFAULT false,
  evidence_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pharaoh_s0_counters(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS pharaoh_s0_memberships (
  posizione_id bigint PRIMARY KEY REFERENCES posizioni(id),
  account_id bigint NOT NULL REFERENCES accounts(id),
  event_key text NOT NULL REFERENCES pharaoh_economic_events(event_key),
  entry_index integer NOT NULL CHECK(entry_index > 0),
  position_class text NOT NULL CHECK(position_class IN ('HUMAN','PILETTA','FONDO_A','CASSA_PROGETTI','LEGACY_CASSA')),
  origin text NOT NULL,
  numero_posizionale bigint NOT NULL CHECK(numero_posizionale > 0),
  amount_atomic numeric(78,0) NOT NULL CHECK(amount_atomic = 100000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_key, entry_index),
  UNIQUE(numero_posizionale)
);
CREATE TABLE IF NOT EXISTS pharaoh_treasury_movements (
  movement_key text PRIMARY KEY,
  reserve_bucket text NOT NULL UNIQUE REFERENCES pharaoh_economic_buckets(bucket_key),
  source_wallet text NOT NULL,
  destination_wallet text NOT NULL,
  amount_atomic numeric(78,0) NOT NULL CHECK(amount_atomic > 0),
  purpose text NOT NULL,
  destination_bucket text,
  destination_purpose text,
  depends_on text REFERENCES pharaoh_treasury_movements(movement_key),
  status text NOT NULL DEFAULT 'PREPARED' CHECK(status IN
    ('PREPARED','SIGNED','SUBMITTED','CONFIRMED','REGISTERED','RECONCILIATION_REQUIRED','CANCELLED')),
  chain_id numeric(78,0),
  token text,
  sender_nonce bigint,
  signed_raw_tx text,
  broadcast_attempted_at timestamptz,
  tx_hash text UNIQUE,
  proof jsonb,
  registry_tx_hash text,
  registry_result jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((signed_raw_tx IS NULL AND tx_hash IS NULL) OR tx_hash IS NOT NULL),
  CHECK(source_wallet <> destination_wallet),
  CHECK(source_wallet ~ '^0x[0-9a-f]{40}$' AND destination_wallet ~ '^0x[0-9a-f]{40}$'),
  CHECK(status NOT IN ('SIGNED','SUBMITTED','CONFIRMED','REGISTERED') OR tx_hash IS NOT NULL),
  CHECK(tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  CHECK((destination_bucket IS NULL) = (destination_purpose IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_pharaoh_movements_status ON pharaoh_treasury_movements(status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pharaoh_signer_nonce ON pharaoh_treasury_movements(source_wallet,sender_nonce) WHERE sender_nonce IS NOT NULL;
CREATE TABLE IF NOT EXISTS pharaoh_operating_bindings (
  operation_type text NOT NULL CHECK(operation_type IN ('PAYOUT','CROSS','POST_COMMIT')),
  operation_key text NOT NULL,
  bucket_key text NOT NULL UNIQUE REFERENCES pharaoh_economic_buckets(bucket_key),
  evidence_hash text NOT NULL,
  PRIMARY KEY(operation_type,operation_key)
);

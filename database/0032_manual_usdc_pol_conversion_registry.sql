-- Additive, no historical backfill. Exact USDC 6 decimals and native POL wei.
CREATE TABLE IF NOT EXISTS pharaoh_gas_conversions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_key text NOT NULL UNIQUE CHECK(length(request_key) BETWEEN 1 AND 128),
 chain_id integer NOT NULL CHECK(chain_id = 137),
 treasury_wallet text NOT NULL CHECK(treasury_wallet ~ '^0x[0-9a-f]{40}$'),
 pol_wallet text NOT NULL CHECK(pol_wallet ~ '^0x[0-9a-f]{40}$'),
 usdc_atomic numeric(78,0) NOT NULL CHECK(usdc_atomic > 0),
 expected_pol_wei numeric(78,0) NOT NULL CHECK(expected_pol_wei > 0),
 status text NOT NULL DEFAULT 'PREPARATA' CHECK(status IN ('PREPARATA','DA_RICONCILIARE','VERIFICATA')),
 tx_hash text,
 verified_usdc_atomic numeric(78,0),
 verified_pol_wei numeric(78,0),
 verified_block bigint,
 verified_block_hash text,
 prepared_at timestamptz NOT NULL DEFAULT now(),
 verified_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT conversion_verification_consistency CHECK (
  (status = 'VERIFICATA') = (tx_hash IS NOT NULL AND verified_usdc_atomic IS NOT NULL AND verified_pol_wei IS NOT NULL AND verified_block IS NOT NULL AND verified_block_hash IS NOT NULL AND verified_at IS NOT NULL)),
 CHECK(tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS pharaoh_gas_conversion_verified_tx_unique
 ON pharaoh_gas_conversions(chain_id,tx_hash) WHERE tx_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS pharaoh_gas_conversion_allocations (
 conversion_id bigint NOT NULL REFERENCES pharaoh_gas_conversions(id),
 payout_id bigint NOT NULL REFERENCES pharaoh_gas_reserve_entries(payout_id),
 amount_atomic numeric(78,0) NOT NULL CHECK(amount_atomic > 0),
 PRIMARY KEY(conversion_id,payout_id)
);
CREATE INDEX IF NOT EXISTS pharaoh_gas_conversion_allocations_payout ON pharaoh_gas_conversion_allocations(payout_id);
CREATE TABLE IF NOT EXISTS pharaoh_gas_conversion_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 conversion_id bigint NOT NULL REFERENCES pharaoh_gas_conversions(id),
 event_type text NOT NULL CHECK(event_type IN ('PREPARATA','DA_RICONCILIARE','VERIFICATA')),
 actor text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION pharaoh_gas_conversion_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GAS_CONVERSION_EVENTS_APPEND_ONLY'; END $$;
CREATE TRIGGER pharaoh_gas_conversion_events_no_update BEFORE UPDATE OR DELETE ON pharaoh_gas_conversion_events
FOR EACH ROW EXECUTE FUNCTION pharaoh_gas_conversion_events_immutable();

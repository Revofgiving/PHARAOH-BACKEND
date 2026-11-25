-- FASE 6 / NON DEPLOY. Records independent, individually signed attestations.
-- Does NOT permit funds release: release remains fail-closed until on-chain reconciliation.
CREATE TABLE IF NOT EXISTS pharaoh_gas_cancellation_attestations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 conversion_id bigint NOT NULL REFERENCES pharaoh_gas_conversions(id),
 operator_id text NOT NULL CHECK (length(operator_id) BETWEEN 1 AND 100),
 evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
 nonce text NOT NULL CHECK (nonce ~ '^[0-9a-f-]{36}$'),
 signed_at timestamptz NOT NULL,
 signature text NOT NULL,
 statement_sha256 text NOT NULL CHECK (statement_sha256 ~ '^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversion_id, operator_id), UNIQUE(operator_id,nonce)
);
CREATE INDEX IF NOT EXISTS pharaoh_gas_cancellation_attestations_conversion_idx
 ON pharaoh_gas_cancellation_attestations(conversion_id);
CREATE FUNCTION pharaoh_gas_cancellation_attestations_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GAS_CANCELLATION_ATTESTATIONS_APPEND_ONLY'; END $$;
CREATE TRIGGER pharaoh_gas_cancellation_attestations_no_mutation
 BEFORE UPDATE OR DELETE ON pharaoh_gas_cancellation_attestations
 FOR EACH ROW EXECUTE FUNCTION pharaoh_gas_cancellation_attestations_immutable();

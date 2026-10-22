-- 0029_direct_pharaoh_server_reconciliation
-- DIRECT PHARAOH: protocollo durevole per il tratto tra autorizzazione,
-- apertura del wallet, hash candidato e verifica on-chain.
-- Nessun campo qui attribuisce una posizione: l'accredito resta subordinato a
-- blockchain-verifier + PharaohRegistry + transazione DB gia esistenti.

ALTER TABLE direct_donation_sessions
  ADD COLUMN IF NOT EXISTS pharaoh_broadcast_intent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pharaoh_broadcast_claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pharaoh_broadcast_eligibility_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pharaoh_broadcast_cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pharaoh_broadcast_cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS pharaoh_candidate_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS pharaoh_candidate_recorded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pharaoh_candidate_source TEXT,
  ADD COLUMN IF NOT EXISTS pharaoh_reconciliation_last_error TEXT,
  ADD COLUMN IF NOT EXISTS pharaoh_reconciliation_updated_at TIMESTAMPTZ;

-- Le sessioni gia verificate prima della 0029 vengono ricondotte allo stesso
-- modello senza cambiare hash, importi, status, wallet o risultato posizione.
UPDATE direct_donation_sessions
   SET pharaoh_broadcast_intent_at = COALESCE(pharaoh_broadcast_intent_at, pharaoh_verified_at, updated_at, created_at),
       pharaoh_broadcast_claim_expires_at = COALESCE(pharaoh_broadcast_claim_expires_at, rog_claim_expires_at),
       pharaoh_broadcast_eligibility_expires_at = COALESCE(pharaoh_broadcast_eligibility_expires_at, rog_eligibility_expires_at),
       pharaoh_candidate_tx_hash = COALESCE(pharaoh_candidate_tx_hash, pharaoh_tx_hash),
       pharaoh_candidate_recorded_at = COALESCE(pharaoh_candidate_recorded_at, pharaoh_verified_at, updated_at, created_at),
       pharaoh_candidate_source = COALESCE(pharaoh_candidate_source, 'BACKFILL_VERIFIED'),
       pharaoh_reconciliation_updated_at = COALESCE(pharaoh_reconciliation_updated_at, pharaoh_verified_at, updated_at, created_at)
 WHERE pharaoh_tx_hash IS NOT NULL;

ALTER TABLE direct_donation_sessions
  DROP CONSTRAINT IF EXISTS chk_direct_pharaoh_candidate_requires_intent;

ALTER TABLE direct_donation_sessions
  ADD CONSTRAINT chk_direct_pharaoh_candidate_requires_intent
  CHECK (
    pharaoh_candidate_tx_hash IS NULL
    OR (pharaoh_broadcast_intent_at IS NOT NULL AND pharaoh_broadcast_cancelled_at IS NULL)
  );

ALTER TABLE direct_donation_sessions
  DROP CONSTRAINT IF EXISTS chk_direct_pharaoh_candidate_hash_format;

ALTER TABLE direct_donation_sessions
  ADD CONSTRAINT chk_direct_pharaoh_candidate_hash_format
  CHECK (pharaoh_candidate_tx_hash IS NULL OR pharaoh_candidate_tx_hash ~* '^0x[0-9a-f]{64}$');

-- Storico append-only dei candidati. Serve anche per le sostituzioni wallet
-- (speed-up/cancel): nessun hash precedente viene cancellato o riassegnato.
CREATE TABLE IF NOT EXISTS direct_pharaoh_tx_candidates (
  id BIGSERIAL PRIMARY KEY,
  session_ref TEXT NOT NULL REFERENCES direct_donation_sessions(session_ref) ON DELETE RESTRICT,
  tx_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  replaces_tx_hash TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT chk_direct_pharaoh_candidate_history_hash
    CHECK (tx_hash ~* '^0x[0-9a-f]{64}$'),
  CONSTRAINT chk_direct_pharaoh_candidate_history_replaces
    CHECK (replaces_tx_hash IS NULL OR (replaces_tx_hash ~* '^0x[0-9a-f]{64}$' AND LOWER(replaces_tx_hash) <> LOWER(tx_hash)))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_pharaoh_candidate_history_tx_lower
  ON direct_pharaoh_tx_candidates ((LOWER(tx_hash)));
CREATE INDEX IF NOT EXISTS idx_direct_pharaoh_candidate_history_session
  ON direct_pharaoh_tx_candidates (session_ref, recorded_at DESC);

INSERT INTO direct_pharaoh_tx_candidates
  (session_ref, tx_hash, source, recorded_at, verified_at)
SELECT session_ref,
       COALESCE(pharaoh_candidate_tx_hash, pharaoh_tx_hash),
       COALESCE(pharaoh_candidate_source, 'BACKFILL_VERIFIED'),
       COALESCE(pharaoh_candidate_recorded_at, pharaoh_verified_at, updated_at, created_at),
       pharaoh_verified_at
  FROM direct_donation_sessions
 WHERE COALESCE(pharaoh_candidate_tx_hash, pharaoh_tx_hash) IS NOT NULL
ON CONFLICT DO NOTHING;

-- Un hash candidato o gia verificato puo appartenere a una sola sessione.
-- COALESCE mantiene la stessa chiave quando il candidato diventa verificato.
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_sessions_pharaoh_effective_tx_lower
  ON direct_donation_sessions ((LOWER(COALESCE(pharaoh_tx_hash, pharaoh_candidate_tx_hash))))
  WHERE COALESCE(pharaoh_tx_hash, pharaoh_candidate_tx_hash) IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_direct_sessions_pharaoh_reconciliation_pending
  ON direct_donation_sessions (pharaoh_candidate_recorded_at, updated_at)
  WHERE pharaoh_candidate_tx_hash IS NOT NULL
    AND pharaoh_tx_hash IS NULL
    AND completed_at IS NULL
    AND status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS idx_direct_sessions_pharaoh_intent_unresolved
  ON direct_donation_sessions (pharaoh_broadcast_intent_at, updated_at)
  WHERE pharaoh_broadcast_intent_at IS NOT NULL
    AND pharaoh_broadcast_cancelled_at IS NULL
    AND pharaoh_tx_hash IS NULL
    AND completed_at IS NULL
    AND status <> 'CANCELLED';

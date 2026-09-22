-- PHARAOH 0014 - prova durevole registerDonation ROG per uscite RHA -> ROG
-- 5 settembre 2026.
--
-- Dopo il Transfer USDC Cassa PHARAOH -> Cassa ROG, la stessa Cassa PHARAOH
-- deve firmare registerDonation(importo) sul contratto ROG. Questi campi
-- rendono la fase recuperabile e impediscono broadcast ciechi dopo crash.

ALTER TABLE cross_outbound_operations
  ADD COLUMN IF NOT EXISTS rog_register_nonce BIGINT,
  ADD COLUMN IF NOT EXISTS rog_register_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS rog_donation_id TEXT,
  ADD COLUMN IF NOT EXISTS rog_register_proof JSONB,
  ADD COLUMN IF NOT EXISTS rog_register_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rog_register_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rog_register_last_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cross_outbound_rog_register_tx_lower
  ON cross_outbound_operations ((LOWER(rog_register_tx_hash)))
  WHERE rog_register_tx_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cross_outbound_rog_donation_id
  ON cross_outbound_operations (rog_donation_id)
  WHERE target_platform = 'ROG' AND rog_donation_id IS NOT NULL;

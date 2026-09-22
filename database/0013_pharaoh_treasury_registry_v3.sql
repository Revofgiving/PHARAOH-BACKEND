-- PHARAOH 0013 - Pharaoh Treasury Registry V3 evidence
-- 4 settembre 2026.
--
-- Il Registry PHARAOH V3 registra esclusivamente transazioni USDC reali
-- in entrata verso o in uscita dalla Cassa PHARAOH. La logica ROG/URANUS,
-- DIRECT, Carta Regalo e progressione PHARAOH resta nel backend.
--
-- Nota compatibilita: direct_donation_sessions e gift_sessions conservano
-- il nome colonna legacy registry_session_id; da V3 il valore memorizzato
-- e il txId del Treasury Registry, non una sessione on-chain.

ALTER TABLE gift_sessions
  ADD COLUMN IF NOT EXISTS registry_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS registry_session_id BIGINT,
  ADD COLUMN IF NOT EXISTS registry_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS registry_confirmed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_gift_sessions_registry_tx_lower
  ON gift_sessions ((LOWER(registry_tx_hash)))
  WHERE registry_tx_hash IS NOT NULL;

ALTER TABLE doni_pendenti
  ADD COLUMN IF NOT EXISTS registry_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS registry_tx_id BIGINT,
  ADD COLUMN IF NOT EXISTS registry_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS registry_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registry_last_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_doni_pendenti_registry_tx_lower
  ON doni_pendenti ((LOWER(registry_tx_hash)))
  WHERE registry_tx_hash IS NOT NULL;

ALTER TABLE cross_outbound_operations
  ADD COLUMN IF NOT EXISTS registry_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS registry_tx_id BIGINT,
  ADD COLUMN IF NOT EXISTS registry_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS registry_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registry_last_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cross_outbound_registry_tx_lower
  ON cross_outbound_operations ((LOWER(registry_tx_hash)))
  WHERE registry_tx_hash IS NOT NULL;

ALTER TABLE cross_entry_events
  ADD COLUMN IF NOT EXISTS registry_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS registry_tx_id BIGINT,
  ADD COLUMN IF NOT EXISTS registry_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS registry_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registry_last_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cross_entry_registry_tx_lower
  ON cross_entry_events ((LOWER(registry_tx_hash)))
  WHERE registry_tx_hash IS NOT NULL;

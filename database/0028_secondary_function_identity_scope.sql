-- PHARAOH migration 0028
-- Corregge lo scope del progressivo delle identita funzionali secondarie.
-- PERPETUO/GEMELLO condividono il wallet reale, ma la genealogia e distinta
-- per account origine: il progressivo 1 e quindi valido per piu account
-- dello stesso wallet (es. A.1 e 1-A.1). SIMBIONTE resta wallet-global.
-- Migrazione solo additiva/indici: nessuna riga storica viene eliminata.

ALTER TABLE identita_funzioni
  ADD COLUMN IF NOT EXISTS account_origine_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_generato_id BIGINT REFERENCES accounts(id);

-- Le identita create dal runtime corrente hanno identity_key FUNZIONE_<id>.
-- Backfill deterministico dai record funzioni, senza ricostruzioni euristiche.
UPDATE identita_funzioni i
SET account_origine_id = COALESCE(i.account_origine_id, f.account_origine_id),
    account_generato_id = COALESCE(i.account_generato_id, f.account_generato_id)
FROM funzioni f
WHERE i.identity_key = ('FUNZIONE_' || f.id::text)
  AND (i.account_origine_id IS NULL OR i.account_generato_id IS NULL);

DROP INDEX IF EXISTS uq_identita_funzioni_progressivo;

CREATE INDEX IF NOT EXISTS idx_identita_funzioni_account_origine
  ON identita_funzioni(account_origine_id);

-- I Simbionti usano un progressivo globale per wallet.
CREATE UNIQUE INDEX IF NOT EXISTS uq_identita_funzioni_simbionte_progressivo
  ON identita_funzioni(wallet_proprietario, progressivo)
  WHERE tipo = 'SIMBIONTE';

-- Perpetui e Gemelli numerano invece per identita/account di origine.
CREATE UNIQUE INDEX IF NOT EXISTS uq_identita_funzioni_secondari_progressivo
  ON identita_funzioni(account_origine_id, tipo, progressivo)
  WHERE tipo IN ('PERPETUO','GEMELLO')
    AND account_origine_id IS NOT NULL;

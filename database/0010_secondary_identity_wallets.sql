-- PHARAOH migration 0010
-- Shared-wallet identity model + autonomous Entrata re-entry roots.
-- Decisioni consolidate 4 settembre 2026:
-- - PERPETUO/GEMELLO usano lo stesso wallet Ethereum reale del Primario proprietario;
-- - l'identita logica e distinta tramite accounts.id + sigla genealogica;
-- - ogni rientro THOT/ISIDE crea una NUOVA radice di percorso ENTRATA,
--   con proprio account_id/ticket/sigla, pur mantenendo lo stesso wallet reale;
-- - vecchi pseudo-wallet _P<n>/_G<n> vengono normalizzati senza perdere
--   l'identita storica del percorso.

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_wallet_key;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS account_key TEXT,
  ADD COLUMN IF NOT EXISTS parent_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS root_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS source_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS source_event_key TEXT,
  ADD COLUMN IF NOT EXISTS origin_kind TEXT NOT NULL DEFAULT 'LEGACY';

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_account_key
  ON accounts(account_key)
  WHERE account_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_wallet_multi ON accounts(LOWER(wallet), id);
CREATE INDEX IF NOT EXISTS idx_accounts_parent_id ON accounts(parent_account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_root_id ON accounts(root_account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_source_event ON accounts(source_event_key);

-- Aggiunge prima i riferimenti identita alle entita operative, in modo da
-- poter catturare la corrispondenza esatta dei vecchi pseudo-wallet PRIMA
-- della loro normalizzazione.
ALTER TABLE posizioni
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_sigla TEXT;
CREATE INDEX IF NOT EXISTS idx_posizioni_account_id ON posizioni(account_id);

ALTER TABLE tavole
  ADD COLUMN IF NOT EXISTS faraone_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS faraone_sigla TEXT;
CREATE INDEX IF NOT EXISTS idx_tavole_faraone_account_id ON tavole(faraone_account_id);

ALTER TABLE turni
  ADD COLUMN IF NOT EXISTS faraone_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS faraone_sigla TEXT;
CREATE INDEX IF NOT EXISTS idx_turni_faraone_account_id ON turni(faraone_account_id);

ALTER TABLE contenitori
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_sigla TEXT;
CREATE INDEX IF NOT EXISTS idx_contenitori_account_id ON contenitori(account_id);

ALTER TABLE funzioni
  ADD COLUMN IF NOT EXISTS account_origine_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_generato_id BIGINT REFERENCES accounts(id);
CREATE INDEX IF NOT EXISTS idx_funzioni_origine_id ON funzioni(account_origine_id);
CREATE INDEX IF NOT EXISTS idx_funzioni_generato_id ON funzioni(account_generato_id);

ALTER TABLE prenotazioni_funzioni
  ADD COLUMN IF NOT EXISTS account_origine_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_destinazione_id BIGINT REFERENCES accounts(id);

ALTER TABLE storico_avanzamenti
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_sigla TEXT;
CREATE INDEX IF NOT EXISTS idx_storico_account_id ON storico_avanzamenti(account_id);

ALTER TABLE doni_pendenti
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_sigla TEXT;
CREATE INDEX IF NOT EXISTS idx_doni_pendenti_account_id ON doni_pendenti(account_id);

ALTER TABLE rha_exit_allocations
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_sigla TEXT;

ALTER TABLE cross_outbound_operations
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_sigla TEXT;

ALTER TABLE thot_exit_allocations
  ADD COLUMN IF NOT EXISTS source_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS source_account_sigla TEXT;

ALTER TABLE iside_exit_allocations
  ADD COLUMN IF NOT EXISTS source_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS source_account_sigla TEXT;

-- 1) Cattura genealogia legacy mentre ogni pseudo-wallet e ancora distinguibile.
UPDATE accounts child
SET parent_account_id = parent.id
FROM accounts parent
WHERE child.parent_account_id IS NULL
  AND child.parent_wallet IS NOT NULL
  AND child.id <> parent.id
  AND LOWER(child.parent_wallet) = LOWER(parent.wallet);

-- 2) Cattura identita operativa legacy tramite corrispondenza esatta del wallet
-- prima di trasformare 0x..._P1 / 0x..._G1 nel wallet Ethereum reale.
UPDATE posizioni p
SET account_id = a.id,
    account_sigla = COALESCE(p.account_sigla, a.sigla)
FROM accounts a
WHERE p.account_id IS NULL
  AND LOWER(p.wallet) = LOWER(a.wallet);

UPDATE tavole t
SET faraone_account_id = a.id,
    faraone_sigla = COALESCE(t.faraone_sigla, a.sigla)
FROM accounts a
WHERE t.faraone_account_id IS NULL
  AND LOWER(t.faraone_wallet) = LOWER(a.wallet);

UPDATE turni t
SET faraone_account_id = a.id,
    faraone_sigla = COALESCE(t.faraone_sigla, a.sigla)
FROM accounts a
WHERE t.faraone_account_id IS NULL
  AND LOWER(t.faraone_wallet) = LOWER(a.wallet);

UPDATE contenitori c
SET account_id = a.id,
    account_sigla = COALESCE(c.account_sigla, a.sigla)
FROM accounts a
WHERE c.account_id IS NULL
  AND LOWER(c.wallet) = LOWER(a.wallet);

UPDATE storico_avanzamenti s
SET account_id = a.id,
    account_sigla = COALESCE(s.account_sigla, a.sigla)
FROM accounts a
WHERE s.account_id IS NULL
  AND LOWER(s.wallet) = LOWER(a.wallet);

UPDATE doni_pendenti d
SET account_id = a.id,
    account_sigla = COALESCE(d.account_sigla, a.sigla)
FROM accounts a
WHERE d.account_id IS NULL
  AND LOWER(d.wallet) = LOWER(a.wallet);

UPDATE funzioni f
SET account_origine_id = a.id
FROM accounts a
WHERE f.account_origine_id IS NULL
  AND LOWER(f.account_origine_wallet) = LOWER(a.wallet);

UPDATE funzioni f
SET account_generato_id = a.id
FROM accounts a
WHERE f.account_generato_id IS NULL
  AND f.account_generato_wallet IS NOT NULL
  AND LOWER(f.account_generato_wallet) = LOWER(a.wallet);

UPDATE prenotazioni_funzioni p
SET account_origine_id = a.id
FROM accounts a
WHERE p.account_origine_id IS NULL
  AND LOWER(p.account_origine_wallet) = LOWER(a.wallet);

UPDATE prenotazioni_funzioni p
SET account_destinazione_id = a.id
FROM accounts a
WHERE p.account_destinazione_id IS NULL
  AND p.account_destinazione_wallet IS NOT NULL
  AND LOWER(p.account_destinazione_wallet) = LOWER(a.wallet);

UPDATE rha_exit_allocations r
SET account_id = a.id,
    account_sigla = COALESCE(r.account_sigla, a.sigla)
FROM accounts a
WHERE r.account_id IS NULL
  AND LOWER(r.beneficiary_wallet) = LOWER(a.wallet);

UPDATE cross_outbound_operations c
SET account_id = a.id,
    account_sigla = COALESCE(c.account_sigla, a.sigla)
FROM accounts a
WHERE c.account_id IS NULL
  AND LOWER(c.beneficiary_wallet) = LOWER(a.wallet);

UPDATE thot_exit_allocations t
SET source_account_id = a.id,
    source_account_sigla = COALESCE(t.source_account_sigla, a.sigla)
FROM accounts a
WHERE t.source_account_id IS NULL
  AND LOWER(t.beneficiary_wallet) = LOWER(a.wallet);

UPDATE iside_exit_allocations i
SET source_account_id = a.id,
    source_account_sigla = COALESCE(i.source_account_sigla, a.sigla)
FROM accounts a
WHERE i.source_account_id IS NULL
  AND LOWER(i.beneficiary_wallet) = LOWER(a.wallet);

-- 3) Normalizza gli account legacy allo stesso wallet Ethereum reale.
UPDATE accounts
SET wallet = LOWER((regexp_match(wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1]),
    origin_kind = CASE
      WHEN tipo IN ('PERPETUO','GEMELLO') THEN 'FUNCTION'
      ELSE origin_kind
    END
WHERE wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE accounts
SET parent_wallet = LOWER((regexp_match(parent_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE parent_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

-- 4) Normalizza gli stessi pseudo-wallet nelle tabelle operative. Gli account_id
-- catturati sopra mantengono la distinzione fra percorsi che condividono il wallet.
UPDATE posizioni
SET wallet = LOWER((regexp_match(wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE tavole
SET faraone_wallet = LOWER((regexp_match(faraone_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE faraone_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE turni
SET faraone_wallet = LOWER((regexp_match(faraone_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE faraone_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE contenitori
SET wallet = LOWER((regexp_match(wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE funzioni
SET account_origine_wallet = LOWER((regexp_match(account_origine_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE account_origine_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE funzioni
SET account_generato_wallet = LOWER((regexp_match(account_generato_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE account_generato_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE prenotazioni_funzioni
SET account_origine_wallet = LOWER((regexp_match(account_origine_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE account_origine_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE prenotazioni_funzioni
SET account_destinazione_wallet = LOWER((regexp_match(account_destinazione_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE account_destinazione_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE storico_avanzamenti
SET wallet = LOWER((regexp_match(wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE doni_pendenti
SET wallet = LOWER((regexp_match(wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE rha_exit_allocations
SET beneficiary_wallet = LOWER((regexp_match(beneficiary_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE beneficiary_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE cross_outbound_operations
SET beneficiary_wallet = LOWER((regexp_match(beneficiary_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE beneficiary_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE thot_exit_allocations
SET beneficiary_wallet = LOWER((regexp_match(beneficiary_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE beneficiary_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

UPDATE iside_exit_allocations
SET beneficiary_wallet = LOWER((regexp_match(beneficiary_wallet, '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$'))[1])
WHERE beneficiary_wallet ~ '^(0x[0-9A-Fa-f]{40})_(?:P|G)[0-9]+$';

-- 5) Costruisce la radice genealogica in modo deterministico.
UPDATE accounts
SET root_account_id = id
WHERE parent_account_id IS NULL
  AND root_account_id IS NULL;

WITH RECURSIVE lineage AS (
  SELECT id, parent_account_id, id AS root_id
  FROM accounts
  WHERE parent_account_id IS NULL
  UNION ALL
  SELECT child.id, child.parent_account_id, lineage.root_id
  FROM accounts child
  JOIN lineage ON child.parent_account_id = lineage.id
), resolved AS (
  SELECT id, MIN(root_id) AS root_id
  FROM lineage
  GROUP BY id
)
UPDATE accounts a
SET root_account_id = resolved.root_id
FROM resolved
WHERE a.id = resolved.id
  AND a.root_account_id IS NULL;

-- 6) Backfill residuo soltanto quando, dopo la normalizzazione, il wallet
-- identifica ancora una singola riga account. Mai scegliere arbitrariamente
-- fra piu percorsi dello stesso MetaMask.
WITH one_account AS (
  SELECT LOWER(wallet) AS wallet_key, MIN(id) AS id, MIN(sigla) AS sigla
  FROM accounts
  GROUP BY LOWER(wallet)
  HAVING COUNT(*) = 1
)
UPDATE posizioni p
SET account_id = oa.id,
    account_sigla = COALESCE(p.account_sigla, oa.sigla)
FROM one_account oa
WHERE p.account_id IS NULL AND LOWER(p.wallet) = oa.wallet_key;

WITH one_account AS (
  SELECT LOWER(wallet) AS wallet_key, MIN(id) AS id, MIN(sigla) AS sigla
  FROM accounts
  GROUP BY LOWER(wallet)
  HAVING COUNT(*) = 1
)
UPDATE tavole t
SET faraone_account_id = oa.id,
    faraone_sigla = COALESCE(t.faraone_sigla, oa.sigla)
FROM one_account oa
WHERE t.faraone_account_id IS NULL AND LOWER(t.faraone_wallet) = oa.wallet_key;

WITH one_account AS (
  SELECT LOWER(wallet) AS wallet_key, MIN(id) AS id, MIN(sigla) AS sigla
  FROM accounts
  GROUP BY LOWER(wallet)
  HAVING COUNT(*) = 1
)
UPDATE turni t
SET faraone_account_id = oa.id,
    faraone_sigla = COALESCE(t.faraone_sigla, oa.sigla)
FROM one_account oa
WHERE t.faraone_account_id IS NULL AND LOWER(t.faraone_wallet) = oa.wallet_key;

-- Vincolo applicativo: i nuovi pseudo-wallet non devono piu entrare nel modello.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS ck_accounts_real_wallet;
ALTER TABLE accounts
  ADD CONSTRAINT ck_accounts_real_wallet
  CHECK (wallet ~* '^0x[0-9a-f]{40}$') NOT VALID;
ALTER TABLE accounts VALIDATE CONSTRAINT ck_accounts_real_wallet;

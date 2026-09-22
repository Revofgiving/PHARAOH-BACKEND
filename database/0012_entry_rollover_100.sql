-- PHARAOH 0012 - riporto strutturale Entrata 100 USDC
-- Recovery 4 settembre 2026.
--
-- Regola definitiva:
-- - Tavola Entrata 1 (Fondo A): 6 donatori reali x 100 = 600 USDC.
--   500 USDC finanziano la progressione; i 100 USDC eccedenti NON vengono
--   trasferiti a un wallet di riserva: restano nella Cassa PHARAOH e vengono
--   materializzati nella tavola successiva.
-- - Dalla Tavola 2 in poi: 1 posizione ROLLOVER da 100 USDC (wallet Cassa
--   PHARAOH) + 5 nuovi donatori/rientri = 600 USDC. Alla chiusura, 100 USDC
--   vengono riportati ancora alla tavola seguente.
-- - ROLLOVER non crea account, ticket o sdoppiamento.
-- - ROLLOVER e ingressi Entrata non possono occupare caselle riservate alle Funzioni.

ALTER TABLE posizioni DROP CONSTRAINT IF EXISTS posizioni_tipo_check;
ALTER TABLE posizioni DROP CONSTRAINT IF EXISTS chk_posizioni_tipo;
ALTER TABLE posizioni
  ADD CONSTRAINT chk_posizioni_tipo
  CHECK (tipo IN (
    'DONATORE','EREDE','FARAONE','SIMBIONTE','PERPETUO','GEMELLO','PROGREDITO','ROLLOVER'
  ));

CREATE TABLE IF NOT EXISTS entry_rollovers (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  source_tavola_id BIGINT NOT NULL REFERENCES tavole(id),
  source_tavola_numero BIGINT NOT NULL,
  target_tavola_id BIGINT NOT NULL REFERENCES tavole(id),
  target_tavola_numero BIGINT NOT NULL,
  target_turno BIGINT NOT NULL CHECK (target_turno >= 2),
  cassa_wallet TEXT NOT NULL,
  amount_usdc NUMERIC(12,2) NOT NULL DEFAULT 100 CHECK (amount_usdc = 100),
  target_casella INTEGER NOT NULL CHECK (target_casella BETWEEN 1 AND 6),
  posizione_id BIGINT NOT NULL REFERENCES posizioni(id),
  status TEXT NOT NULL DEFAULT 'MATERIALIZED'
    CHECK (status IN ('MATERIALIZED','CANCELLED','ERROR')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_tavola_id),
  UNIQUE(target_tavola_id)
);

CREATE INDEX IF NOT EXISTS idx_entry_rollovers_target_turno
  ON entry_rollovers(target_turno);

-- Il vecchio modello trasferiva i 100 USDC a una terza stringa.
-- Le sole richieste non ancora inviate e sicuramente prive di tx vengono neutralizzate.
UPDATE doni_pendenti
SET status = 'CANCELLED',
    errore = COALESCE(errore, 'Neutralizzato da 0012: quota Entrata sostituita dal riporto interno alla tavola successiva')
WHERE tipo_uscita = 'RISERVA_ENTRATA'
  AND status IN ('PENDING','FAILED')
  AND tx_hash IS NULL;

-- Fail closed su stati legacy potenzialmente gia accettati/in elaborazione:
-- richiedono riconciliazione manuale, non devono essere cancellati o reinviati automaticamente.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM doni_pendenti
    WHERE tipo_uscita = 'RISERVA_ENTRATA'
      AND status IN ('PROCESSING','ACCEPTED')
  ) THEN
    RAISE EXCEPTION
      '0012_ENTRY_ROLLOVER_RECONCILIATION_REQUIRED: esistono quote Entrata legacy PROCESSING/ACCEPTED';
  END IF;
END $$;

-- PHARAOH 0021 - numero_posizionale unico e definitivo
--
-- Obiettivi:
-- 1) eliminare dal modello corrente il concetto legacy di ticket;
-- 2) mantenere un solo numero valido del movimento PHARAOH: numero_posizionale;
-- 3) fissare numero_posizionale ENTRATA = ((tavola - 1) * 6) + casella;
-- 4) includere nel progressivo anche la posizione CASSA/ROLLOVER;
-- 5) dalla Tavola 2 in poi la CASSA deve essere in casella 1;
-- 6) conservare le prenotazioni Funzioni rinominandole come prenotazioni posizionali.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='accounts' AND column_name='ticket_number')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='accounts' AND column_name='numero_posizionale') THEN
    ALTER TABLE accounts RENAME COLUMN ticket_number TO numero_posizionale;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='funzioni' AND column_name='ticket_prenotato')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='funzioni' AND column_name='numero_posizionale_prenotato') THEN
    ALTER TABLE funzioni RENAME COLUMN ticket_prenotato TO numero_posizionale_prenotato;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prenotazioni_funzioni' AND column_name='ticket_number')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prenotazioni_funzioni' AND column_name='numero_posizionale') THEN
    ALTER TABLE prenotazioni_funzioni RENAME COLUMN ticket_number TO numero_posizionale;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='contenitori' AND column_name='ticket_number')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='contenitori' AND column_name='numero_posizionale') THEN
    ALTER TABLE contenitori RENAME COLUMN ticket_number TO numero_posizionale;
  END IF;
END $$;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS numero_posizionale BIGINT;
ALTER TABLE funzioni ADD COLUMN IF NOT EXISTS numero_posizionale_prenotato BIGINT;
ALTER TABLE prenotazioni_funzioni ADD COLUMN IF NOT EXISTS numero_posizionale BIGINT;
ALTER TABLE contenitori ADD COLUMN IF NOT EXISTS numero_posizionale BIGINT;
ALTER TABLE posizioni ADD COLUMN IF NOT EXISTS numero_posizionale BIGINT;

-- Fail-closed: non applichiamo silenziosamente la nuova regola se esistono rollover
-- storici in una casella diversa dalla 1. Prima del deploy vanno riconciliati in modo
-- esplicito, per non cambiare retroattivamente l'identita posizionale di un utente.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM posizioni p
    JOIN tavole t ON t.id = p.tavola_id
    WHERE t.sezione = 'ENTRATA'
      AND t.livello = 0
      AND t.numero > 1
      AND p.tipo = 'ROLLOVER'
      AND p.casella <> 1
  ) THEN
    RAISE EXCEPTION '0021_ENTRY_ROLLOVER_SLOT1_RECONCILIATION_REQUIRED';
  END IF;
END $$;

-- Materializza il numero canonico su ogni casella ENTRATA, inclusa CASSA/ROLLOVER.
UPDATE posizioni p
SET numero_posizionale = (((t.numero - 1) * 6) + p.casella)::bigint
FROM tavole t
WHERE t.id = p.tavola_id
  AND t.sezione = 'ENTRATA'
  AND t.livello = 0
  AND p.numero_posizionale IS DISTINCT FROM (((t.numero - 1) * 6) + p.casella)::bigint;

-- Nessuna posizione non-ENTRATA deve introdurre un secondo progressivo parallelo.
UPDATE posizioni p
SET numero_posizionale = NULL
FROM tavole t
WHERE t.id = p.tavola_id
  AND NOT (t.sezione = 'ENTRATA' AND t.livello = 0)
  AND p.numero_posizionale IS NOT NULL;

-- Allinea ogni account alla sua prima vera posizione ENTRATA.
WITH prima_entrata AS (
  SELECT DISTINCT ON (p.account_id)
    p.account_id,
    p.numero_posizionale
  FROM posizioni p
  JOIN tavole t ON t.id = p.tavola_id
  WHERE p.account_id IS NOT NULL
    AND t.sezione = 'ENTRATA'
    AND t.livello = 0
    AND p.tipo <> 'ROLLOVER'
  ORDER BY p.account_id, p.numero_posizionale ASC, p.id ASC
)
UPDATE accounts a
SET numero_posizionale = pe.numero_posizionale,
    sigla = CASE
      WHEN a.tipo = 'PRIMARIO' AND (a.sigla IS NULL OR a.sigla ~ '^[0-9]+$')
      THEN pe.numero_posizionale::text
      ELSE a.sigla
    END
FROM prima_entrata pe
WHERE pe.account_id = a.id;

-- I vecchi numeri assegnati a un account senza una reale posizione ENTRATA non sono
-- piu numeri del movimento. Le prenotazioni Funzioni restano nelle tabelle dedicate.
UPDATE accounts a
SET numero_posizionale = NULL
WHERE numero_posizionale IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM posizioni p
    JOIN tavole t ON t.id = p.tavola_id
    WHERE p.account_id = a.id
      AND t.sezione = 'ENTRATA'
      AND t.livello = 0
      AND p.tipo <> 'ROLLOVER'
  );

DROP INDEX IF EXISTS idx_accounts_ticket;
DROP INDEX IF EXISTS idx_prenotazioni_funzioni_ticket_stato;
DROP INDEX IF EXISTS idx_accounts_numero_posizionale;
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_numero_posizionale
  ON accounts(numero_posizionale)
  WHERE numero_posizionale IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_posizioni_entrata_numero_posizionale
  ON posizioni(numero_posizionale)
  WHERE numero_posizionale IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prenotazioni_funzioni_numero_posizionale_stato
  ON prenotazioni_funzioni(numero_posizionale, stato)
  WHERE numero_posizionale IS NOT NULL;

-- PHARAOH 0025 - Progressivo ENTRATA globale indipendente da tavola/casella
-- 01 ottobre 2026
--
-- Regola definitiva verificata sulla lista operativa:
-- - numero_posizionale = progressivo unico 1 -> infinito;
-- - le posizioni materializzate ENTRATA (HUMAN/CASSA) consumano il prossimo
--   numero libero in ordine cronologico;
-- - i numeri riservati alle Funzioni/Gemelli (26,40,54,68,... e qualsiasi
--   prenotazione esplicita persistita) restano vuoti nel flusso ENTRATA ma
--   consumano il progressivo globale;
-- - una prenotazione NON occupa una casella fisica della tavola ENTRATA;
-- - Tavola 1 = 6 HUMAN; Tavola 2+ = CASSA in casella 1 + 5 HUMAN;
-- - la CASSA usa lo stesso progressivo globale e quindi slitta quando una
--   prenotazione Funzione cade prima della CASSA successiva.
--
-- Esempi attesi:
-- CASSA: 7,13,19,25,32,38,45,51,58,64,71,77,84,90,97,103,109,116,122...
-- GEMELLI riservati: 26,40,54,68,82,96,110...

-- 1) Contatore transazionale monotono del progressivo ENTRATA.
CREATE TABLE IF NOT EXISTS entry_position_counter (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  last_issued BIGINT NOT NULL DEFAULT 0 CHECK (last_issued >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Fail-closed: non possono esistere due prenotazioni posizionali diverse
--    sullo stesso numero globale attivo.
DO $$
BEGIN
  IF EXISTS (
    SELECT numero_posizionale
    FROM prenotazioni_funzioni
    WHERE numero_posizionale IS NOT NULL
      AND stato IN ('RESERVED','MATERIALIZED','CONSUMED')
    GROUP BY numero_posizionale
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION '0025_DUPLICATE_ACTIVE_FUNCTION_POSITION_RESERVATION';
  END IF;
END $$;

-- 3) Libera temporaneamente i numeri delle posizioni ENTRATA e dei relativi
--    account, in modo da poterli riallineare senza collisioni sui vincoli UNIQUE.
--    Gli account Funzione/Gemello senza posizione ENTRATA restano intatti.
UPDATE accounts a
SET numero_posizionale = NULL
WHERE EXISTS (
  SELECT 1
  FROM posizioni p
  JOIN tavole t ON t.id = p.tavola_id
  WHERE p.account_id = a.id
    AND t.sezione = 'ENTRATA'
    AND t.livello = 0
);

UPDATE posizioni p
SET numero_posizionale = NULL
FROM tavole t
WHERE t.id = p.tavola_id
  AND t.sezione = 'ENTRATA'
  AND t.livello = 0;

-- 4) Assegna alle posizioni ENTRATA il progressivo globale in ordine fisico
--    di materializzazione, saltando i numeri riservati.
WITH ordered_positions AS (
  SELECT
    p.id,
    ROW_NUMBER() OVER (ORDER BY t.numero ASC, p.casella ASC, p.id ASC) AS rn
  FROM posizioni p
  JOIN tavole t ON t.id = p.tavola_id
  WHERE t.sezione = 'ENTRATA'
    AND t.livello = 0
),
bounds AS (
  SELECT GREATEST(
    (SELECT COUNT(*) FROM ordered_positions) * 3
      + (SELECT COUNT(*) FROM prenotazioni_funzioni WHERE numero_posizionale IS NOT NULL AND stato IN ('RESERVED','MATERIALIZED','CONSUMED'))
      + (SELECT COUNT(*) FROM funzioni WHERE numero_posizionale_prenotato IS NOT NULL)
      + 100,
    1000
  )::bigint AS max_candidate
),
available_numbers AS (
  SELECT
    g.n,
    ROW_NUMBER() OVER (ORDER BY g.n ASC) AS rn
  FROM bounds b
  CROSS JOIN LATERAL generate_series(1::bigint, b.max_candidate, 1::bigint) AS g(n)
  WHERE NOT (g.n >= 26 AND MOD(g.n - 26, 14) = 0)
    AND NOT EXISTS (
      SELECT 1
      FROM prenotazioni_funzioni pf
      WHERE pf.numero_posizionale = g.n
        AND pf.stato IN ('RESERVED','MATERIALIZED','CONSUMED')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM funzioni f
      WHERE f.numero_posizionale_prenotato = g.n
    )
),
mapping AS (
  SELECT op.id AS posizione_id, an.n AS numero_posizionale
  FROM ordered_positions op
  JOIN available_numbers an ON an.rn = op.rn
)
UPDATE posizioni p
SET numero_posizionale = m.numero_posizionale
FROM mapping m
WHERE p.id = m.posizione_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM posizioni p
    JOIN tavole t ON t.id = p.tavola_id
    WHERE t.sezione = 'ENTRATA'
      AND t.livello = 0
      AND p.numero_posizionale IS NULL
  ) THEN
    RAISE EXCEPTION '0025_ENTRY_POSITION_MAPPING_INCOMPLETE';
  END IF;
END $$;

-- 5) Riallinea l'identita dell'account alla sua prima posizione ENTRATA.
--    Ogni percorso autonomo deve avere il proprio account_id; DISTINCT ON e
--    mantenuto come protezione per dati legacy con piu righe sullo stesso account.
WITH first_entry AS (
  SELECT DISTINCT ON (p.account_id)
    p.account_id,
    p.numero_posizionale
  FROM posizioni p
  JOIN tavole t ON t.id = p.tavola_id
  WHERE p.account_id IS NOT NULL
    AND t.sezione = 'ENTRATA'
    AND t.livello = 0
  ORDER BY p.account_id, p.numero_posizionale ASC, p.id ASC
)
UPDATE accounts a
SET numero_posizionale = fe.numero_posizionale,
    sigla = CASE
      WHEN a.tipo = 'PRIMARIO' AND (a.sigla IS NULL OR a.sigla ~ '^[0-9]+$')
      THEN fe.numero_posizionale::text
      ELSE a.sigla
    END
FROM first_entry fe
WHERE fe.account_id = a.id;

-- 6) Riallinea metadati CASSA al nuovo numero globale. Si usa un prefisso
--    temporaneo per evitare collisioni durante l'aggiornamento delle account_key.
UPDATE accounts
SET account_key = 'TMP:0025:CASSA:' || id::text
WHERE origin_kind = 'CASSA_ENTRY';

WITH cassa_positions AS (
  SELECT DISTINCT ON (p.account_id)
    p.account_id,
    p.numero_posizionale
  FROM posizioni p
  JOIN tavole t ON t.id = p.tavola_id
  WHERE p.tipo = 'CASSA'
    AND p.account_id IS NOT NULL
    AND t.sezione = 'ENTRATA'
    AND t.livello = 0
  ORDER BY p.account_id, p.id ASC
)
UPDATE accounts a
SET numero_posizionale = cp.numero_posizionale,
    sigla = cp.numero_posizionale::text,
    nome = 'CASSA PHARAOH #' || cp.numero_posizionale::text,
    account_key = 'SYSTEM:CASSA:ENTRATA:' || cp.numero_posizionale::text,
    source_event_key = 'PHARAOH:ENTRATA:CASSA:' || cp.numero_posizionale::text,
    origin_kind = 'CASSA_ENTRY'
FROM cassa_positions cp
WHERE a.id = cp.account_id;

UPDATE posizioni p
SET account_sigla = a.sigla,
    nome = CASE
      WHEN p.tipo = 'CASSA' THEN 'CASSA PHARAOH #' || p.numero_posizionale::text
      ELSE p.nome
    END
FROM accounts a
WHERE p.account_id = a.id
  AND p.numero_posizionale IS NOT NULL;

-- La tavola personale mantiene la propria numerazione sequenziale indipendente;
-- aggiorniamo soltanto l'identita/sigla del percorso centrale.
UPDATE tavole s
SET faraone_sigla = a.sigla
FROM posizioni p
JOIN accounts a ON a.id = p.account_id
WHERE p.sdoppiamento_tavola_id = s.id
  AND p.numero_posizionale IS NOT NULL
  AND s.sezione = 'ENTRATA'
  AND s.livello = 0;

-- 7) Inizializza il contatore al massimo numero materializzato, NON al massimo
--    numero prenotato: le prenotazioni future devono essere saltate quando il
--    progressivo le raggiunge, non anticipare artificialmente il contatore.
INSERT INTO entry_position_counter (id, last_issued)
VALUES (
  1,
  COALESCE((
    SELECT MAX(p.numero_posizionale)
    FROM posizioni p
    JOIN tavole t ON t.id = p.tavola_id
    WHERE t.sezione = 'ENTRATA' AND t.livello = 0
  ), 0)
)
ON CONFLICT (id) DO UPDATE
SET last_issued = EXCLUDED.last_issued,
    updated_at = NOW();

-- 8) Invarianti finali.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM posizioni p
    JOIN tavole t ON t.id = p.tavola_id
    WHERE t.sezione = 'ENTRATA'
      AND t.livello = 0
      AND (
        p.numero_posizionale IS NULL
        OR (p.numero_posizionale >= 26 AND MOD(p.numero_posizionale - 26, 14) = 0)
      )
  ) THEN
    RAISE EXCEPTION '0025_ENTRY_POSITION_USES_RESERVED_GEMELLO_NUMBER';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM posizioni p
    JOIN tavole t ON t.id = p.tavola_id
    JOIN prenotazioni_funzioni pf
      ON pf.numero_posizionale = p.numero_posizionale
     AND pf.stato IN ('RESERVED','MATERIALIZED','CONSUMED')
    WHERE t.sezione = 'ENTRATA'
      AND t.livello = 0
  ) THEN
    RAISE EXCEPTION '0025_ENTRY_POSITION_USES_FUNCTION_RESERVATION';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM posizioni p
    JOIN tavole t ON t.id = p.tavola_id
    WHERE p.tipo = 'CASSA'
      AND t.sezione = 'ENTRATA'
      AND t.livello = 0
      AND NOT (
        t.numero > 1
        AND p.casella = 1
        AND p.account_id IS NOT NULL
        AND p.numero_posizionale IS NOT NULL
        AND p.sdoppiamento_tavola_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION '0025_CASSA_FINAL_INVARIANT_FAILED';
  END IF;

  -- L'ordine fisico delle posizioni materializzate deve corrispondere
  -- ESATTAMENTE alla sequenza crescente dei numeri non riservati.
  IF EXISTS (
    WITH ordered_positions AS (
      SELECT
        p.id,
        p.numero_posizionale,
        ROW_NUMBER() OVER (ORDER BY t.numero ASC, p.casella ASC, p.id ASC) AS rn
      FROM posizioni p
      JOIN tavole t ON t.id = p.tavola_id
      WHERE t.sezione = 'ENTRATA' AND t.livello = 0
    ),
    bounds AS (
      SELECT GREATEST(
        (SELECT COUNT(*) FROM ordered_positions) * 3
          + (SELECT COUNT(*) FROM prenotazioni_funzioni WHERE numero_posizionale IS NOT NULL AND stato IN ('RESERVED','MATERIALIZED','CONSUMED'))
          + (SELECT COUNT(*) FROM funzioni WHERE numero_posizionale_prenotato IS NOT NULL)
          + 100,
        1000
      )::bigint AS max_candidate
    ),
    available_numbers AS (
      SELECT
        g.n,
        ROW_NUMBER() OVER (ORDER BY g.n ASC) AS rn
      FROM bounds b
      CROSS JOIN LATERAL generate_series(1::bigint, b.max_candidate, 1::bigint) AS g(n)
      WHERE NOT (g.n >= 26 AND MOD(g.n - 26, 14) = 0)
        AND NOT EXISTS (
          SELECT 1 FROM prenotazioni_funzioni pf
          WHERE pf.numero_posizionale = g.n
            AND pf.stato IN ('RESERVED','MATERIALIZED','CONSUMED')
        )
        AND NOT EXISTS (
          SELECT 1 FROM funzioni f
          WHERE f.numero_posizionale_prenotato = g.n
        )
    )
    SELECT 1
    FROM ordered_positions op
    JOIN available_numbers an ON an.rn = op.rn
    WHERE op.numero_posizionale <> an.n
  ) THEN
    RAISE EXCEPTION '0025_ENTRY_GLOBAL_SEQUENCE_INVARIANT_FAILED';
  END IF;
END $$;

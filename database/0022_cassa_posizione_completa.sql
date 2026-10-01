-- PHARAOH 0022 - CASSA PHARAOH come posizione completa ENTRATA
-- 29 settembre 2026
--
-- Correzione definitiva:
-- - dalla Tavola ENTRATA 2 in poi, casella 1 = CASSA PHARAOH;
-- - la CASSA NON e una posizione tecnica: e una posizione PRIMARIO completa;
-- - possiede account_id autonomo, numero_posizionale, sigla e tavola di sdoppiamento;
-- - progredisce nel sistema, puo generare Funzioni e puo ricevere doni;
-- - entry_rollovers resta soltanto audit della provenienza economica dei 100 USDC.
--
-- Questa migration riconcilia anche le CASSA gia presenti nel piccolo database live,
-- senza cancellare gli HUMAN. Le tavole personali ancora APERTE vengono riallineate
-- al principio deterministico: tavola personale ENTRATA = numero_posizionale + 1.

-- 1) Consenti temporaneamente sia il tipo storico ROLLOVER sia il nuovo CASSA.
ALTER TABLE posizioni DROP CONSTRAINT IF EXISTS chk_posizioni_tipo;
ALTER TABLE posizioni DROP CONSTRAINT IF EXISTS posizioni_tipo_check;
ALTER TABLE posizioni
  ADD CONSTRAINT chk_posizioni_tipo
  CHECK (tipo IN (
    'DONATORE','EREDE','FARAONE','SIMBIONTE','PERPETUO','GEMELLO','PROGREDITO','ROLLOVER','CASSA'
  ));

-- 2) Fail-closed: ogni vecchio ROLLOVER deve essere esattamente la casella 1 di una tavola ENTRATA > 1.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM posizioni p
    JOIN tavole t ON t.id = p.tavola_id
    WHERE p.tipo = 'ROLLOVER'
      AND NOT (
        t.sezione = 'ENTRATA'
        AND t.livello = 0
        AND t.numero > 1
        AND p.casella = 1
      )
  ) THEN
    RAISE EXCEPTION '0022_CASSA_LEGACY_POSITION_INVALID';
  END IF;
END $$;

-- 3) Canonicalizza il numero posizionale delle vecchie CASSA.
UPDATE posizioni p
SET numero_posizionale = (((t.numero - 1) * 6) + p.casella)::bigint
FROM tavole t
WHERE t.id = p.tavola_id
  AND t.sezione = 'ENTRATA'
  AND t.livello = 0
  AND p.tipo = 'ROLLOVER';

-- 4) Crea un account PRIMARIO autonomo per ciascuna posizione CASSA gia esistente.
--    Lo stesso wallet CASSA puo avere piu account/percorsi, distinti da account_key.
DO $$
DECLARE
  r RECORD;
  v_account_id BIGINT;
  v_key TEXT;
BEGIN
  FOR r IN
    SELECT p.id AS posizione_id,
           p.wallet,
           p.numero_posizionale,
           p.tavola_id
    FROM posizioni p
    JOIN tavole t ON t.id = p.tavola_id
    WHERE t.sezione = 'ENTRATA'
      AND t.livello = 0
      AND p.tipo = 'ROLLOVER'
    ORDER BY p.numero_posizionale
  LOOP
    v_key := 'SYSTEM:CASSA:ENTRATA:' || r.numero_posizionale::text;

    SELECT id INTO v_account_id
    FROM accounts
    WHERE account_key = v_key
    LIMIT 1;

    IF v_account_id IS NULL THEN
      INSERT INTO accounts (
        wallet, nome, numero_posizionale, tipo, sigla,
        parent_wallet, status, account_key,
        parent_account_id, root_account_id,
        source_account_id, source_event_key, origin_kind
      ) VALUES (
        LOWER(r.wallet),
        'CASSA PHARAOH #' || r.numero_posizionale::text,
        r.numero_posizionale,
        'PRIMARIO',
        r.numero_posizionale::text,
        NULL,
        'ATTIVO',
        v_key,
        NULL,
        NULL,
        NULL,
        'PHARAOH:ENTRATA:CASSA:' || r.numero_posizionale::text,
        'CASSA_ENTRY'
      ) RETURNING id INTO v_account_id;

      UPDATE accounts
      SET root_account_id = id
      WHERE id = v_account_id;
    ELSE
      UPDATE accounts
      SET wallet = LOWER(r.wallet),
          nome = 'CASSA PHARAOH #' || r.numero_posizionale::text,
          numero_posizionale = r.numero_posizionale,
          tipo = 'PRIMARIO',
          sigla = r.numero_posizionale::text,
          status = 'ATTIVO',
          root_account_id = v_account_id,
          origin_kind = 'CASSA_ENTRY'
      WHERE id = v_account_id;
    END IF;

    UPDATE posizioni
    SET tipo = 'CASSA',
        account_id = v_account_id,
        account_sigla = r.numero_posizionale::text,
        nome = 'CASSA PHARAOH #' || r.numero_posizionale::text
    WHERE id = r.posizione_id;
  END LOOP;
END $$;

-- 5) Le tavole personali ENTRATA ancora APERTE devono seguire l'ordine reale delle posizioni.
--    Spostamento temporaneo evita collisioni sull'indice unico (sezione, numero).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tavole t
    LEFT JOIN posizioni p
      ON p.account_id = t.faraone_account_id
     AND p.numero_posizionale IS NOT NULL
    LEFT JOIN tavole pt ON pt.id = p.tavola_id
    WHERE t.sezione = 'ENTRATA'
      AND t.livello = 0
      AND t.tipo = 'SDOPPIAMENTO'
      AND t.status = 'APERTA'
      AND (p.id IS NULL OR pt.sezione <> 'ENTRATA' OR pt.livello <> 0)
  ) THEN
    RAISE EXCEPTION '0022_ENTRY_OPEN_SPLIT_WITHOUT_POSITION_IDENTITY';
  END IF;
END $$;

UPDATE tavole
SET numero = numero + 1000000000
WHERE sezione = 'ENTRATA'
  AND livello = 0
  AND tipo = 'SDOPPIAMENTO'
  AND status = 'APERTA';

UPDATE tavole t
SET numero = p.numero_posizionale + 1,
    faraone_sigla = COALESCE(a.sigla, p.account_sigla)
FROM posizioni p
JOIN tavole pt ON pt.id = p.tavola_id
JOIN accounts a ON a.id = p.account_id
WHERE t.sezione = 'ENTRATA'
  AND t.livello = 0
  AND t.tipo = 'SDOPPIAMENTO'
  AND t.status = 'APERTA'
  AND t.faraone_account_id = p.account_id
  AND pt.sezione = 'ENTRATA'
  AND pt.livello = 0
  AND p.numero_posizionale IS NOT NULL;

-- 6) Crea la tavola personale mancante per ciascuna CASSA gia materializzata.
DO $$
DECLARE
  r RECORD;
  v_tavola_id BIGINT;
  v_expected_num BIGINT;
BEGIN
  FOR r IN
    SELECT p.id AS posizione_id,
           p.wallet,
           p.account_id,
           p.account_sigla,
           p.numero_posizionale,
           pt.turno AS source_turno,
           p.sdoppiamento_tavola_id
    FROM posizioni p
    JOIN tavole pt ON pt.id = p.tavola_id
    WHERE pt.sezione = 'ENTRATA'
      AND pt.livello = 0
      AND p.tipo = 'CASSA'
    ORDER BY p.numero_posizionale
  LOOP
    v_expected_num := r.numero_posizionale + 1;
    v_tavola_id := r.sdoppiamento_tavola_id;

    IF v_tavola_id IS NULL THEN
      SELECT id INTO v_tavola_id
      FROM tavole
      WHERE sezione = 'ENTRATA'
        AND livello = 0
        AND tipo = 'SDOPPIAMENTO'
        AND faraone_account_id = r.account_id
      ORDER BY id ASC
      LIMIT 1;
    END IF;

    IF v_tavola_id IS NULL THEN
      INSERT INTO tavole (
        numero, sezione, livello, blocco, tipo, capacita,
        faraone_wallet, turno, doni_ricevuti, status,
        faraone_account_id, faraone_sigla
      ) VALUES (
        v_expected_num, 'ENTRATA', 0, NULL, 'SDOPPIAMENTO', 6,
        LOWER(r.wallet), r.source_turno, 0, 'APERTA',
        r.account_id, r.account_sigla
      ) RETURNING id INTO v_tavola_id;
    ELSE
      UPDATE tavole
      SET numero = v_expected_num,
          faraone_wallet = LOWER(r.wallet),
          faraone_account_id = r.account_id,
          faraone_sigla = r.account_sigla,
          tipo = 'SDOPPIAMENTO',
          livello = 0,
          sezione = 'ENTRATA',
          capacita = 6
      WHERE id = v_tavola_id
        AND status = 'APERTA';
    END IF;

    UPDATE posizioni
    SET sdoppiamento_tavola_id = v_tavola_id
    WHERE id = r.posizione_id;
  END LOOP;
END $$;

-- 7) Riallinea anche il conteggio del turno: 6 posizioni fisiche, inclusa la CASSA.
UPDATE turni tr
SET sacerdoti_necessari = 6,
    sacerdoti_entrati = COALESCE((
      SELECT COUNT(*)::integer
      FROM tavole t
      JOIN posizioni p ON p.tavola_id = t.id
      WHERE t.sezione = 'ENTRATA'
        AND t.livello = 0
        AND t.tipo = 'PERCORSO'
        AND t.turno = tr.numero_turno
    ), 0)
WHERE tr.sezione = 'ENTRATA'
  AND tr.livello = 0;

-- 8) Riallinea il contatore Tavole ENTRATA dopo la rinumerazione chirurgica.
INSERT INTO contatori_tavole (sezione, ultimo_numero)
VALUES ('ENTRATA', (SELECT COALESCE(MAX(numero), 0) FROM tavole WHERE sezione = 'ENTRATA'))
ON CONFLICT (sezione) DO UPDATE
SET ultimo_numero = EXCLUDED.ultimo_numero,
    updated_at = NOW();

-- 9) Vincolo finale pulito: ROLLOVER non e piu un tipo posizione operativo.
ALTER TABLE posizioni DROP CONSTRAINT IF EXISTS chk_posizioni_tipo;
ALTER TABLE posizioni
  ADD CONSTRAINT chk_posizioni_tipo
  CHECK (tipo IN (
    'DONATORE','EREDE','FARAONE','SIMBIONTE','PERPETUO','GEMELLO','PROGREDITO','CASSA'
  ));

-- 10) Invarianti finali fail-closed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM posizioni WHERE tipo = 'ROLLOVER') THEN
    RAISE EXCEPTION '0022_ROLLOVER_POSITION_STILL_PRESENT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM posizioni p
    JOIN tavole t ON t.id = p.tavola_id
    WHERE p.tipo = 'CASSA'
      AND NOT (
        t.sezione = 'ENTRATA'
        AND t.livello = 0
        AND t.numero > 1
        AND p.casella = 1
        AND p.numero_posizionale = ((t.numero - 1) * 6) + 1
        AND p.account_id IS NOT NULL
        AND p.sdoppiamento_tavola_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION '0022_CASSA_FINAL_INVARIANT_FAILED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM posizioni p
    JOIN tavole s ON s.id = p.sdoppiamento_tavola_id
    WHERE p.tipo = 'CASSA'
      AND s.numero <> p.numero_posizionale + 1
  ) THEN
    RAISE EXCEPTION '0022_CASSA_SPLIT_NUMBER_FAILED';
  END IF;
END $$;

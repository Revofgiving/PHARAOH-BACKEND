-- ============================================================
-- PHARAON Backend — Schema PostgreSQL
-- ============================================================
-- Esegui su un DB PostgreSQL vuoto:
--   psql $DATABASE_URL -f database/init.sql
--
-- Su Coolify: incolla questo script nella sezione
--   "Init scripts" del servizio PostgreSQL,
--   oppure eseguilo una volta dal pannello SQL.
--
-- Idempotente: usa CREATE TABLE IF NOT EXISTS e
-- CREATE INDEX IF NOT EXISTS — sicuro da rieseguire.
-- ============================================================

-- ─── TABELLE ─────────────────────────────────────────────────

-- Account registrati nel sistema
CREATE TABLE IF NOT EXISTS accounts (
  id            BIGSERIAL PRIMARY KEY,
  wallet        TEXT NOT NULL UNIQUE,
  nome          TEXT,
  ticket_number BIGINT UNIQUE,                      -- NULL finché non rilasciato
  tipo          TEXT NOT NULL DEFAULT 'PRIMARIO'
    CHECK (tipo IN ('PRIMARIO','PERPETUO','GEMELLO','SIMBIONTE','FONDO')),
  sigla         TEXT,                                -- es. A, A.1, 1-A, 2-A ...
  parent_wallet TEXT,                                -- wallet dell'account origine
  status        TEXT NOT NULL DEFAULT 'REGISTRATO'
    CHECK (status IN ('REGISTRATO','IN_CODA','ATTIVO','COMPLETATO')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Le sigle genealogiche degli account secondari identificano una sola entità.
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_tipo_sigla_secondari
  ON accounts(tipo, sigla)
  WHERE tipo IN ('PERPETUO', 'GEMELLO') AND sigla IS NOT NULL;

-- Identità persistenti delle Funzioni genealogiche.
CREATE TABLE IF NOT EXISTS identita_funzioni (
  id                      BIGSERIAL PRIMARY KEY,
  identity_key            TEXT NOT NULL UNIQUE,
  wallet_proprietario     TEXT NOT NULL,
  account_origine_wallet  TEXT NOT NULL,
  tipo                    TEXT NOT NULL
    CHECK (tipo IN ('PERPETUO', 'GEMELLO', 'SIMBIONTE')),
  sigla                   TEXT NOT NULL,
  progressivo             BIGINT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'ATTIVA'
    CONSTRAINT chk_identita_funzioni_status
    CHECK (status IN ('ATTIVA', 'SOSPESA', 'CHIUSA')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE identita_funzioni
  ALTER COLUMN progressivo TYPE BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_identita_funzioni_status'
      AND conrelid = 'identita_funzioni'::regclass
  ) THEN
    ALTER TABLE identita_funzioni
      ADD CONSTRAINT chk_identita_funzioni_status
      CHECK (status IN ('ATTIVA', 'SOSPESA', 'CHIUSA'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_identita_funzioni_wallet
  ON identita_funzioni(wallet_proprietario);

CREATE UNIQUE INDEX IF NOT EXISTS uq_identita_funzioni_progressivo
  ON identita_funzioni(wallet_proprietario, tipo, progressivo);

-- Tavole (numero sequenziale indipendente per sezione)
CREATE TABLE IF NOT EXISTS tavole (
  id             BIGSERIAL PRIMARY KEY,
  numero         BIGINT NOT NULL,                     -- sequenziale dentro la sezione
  sezione        TEXT NOT NULL CHECK (sezione IN ('ENTRATA','PHARAOH')),
  livello        INTEGER NOT NULL DEFAULT 0 CHECK (livello BETWEEN 0 AND 5),
  blocco         INTEGER CHECK (blocco IS NULL OR blocco IN (1,2)),
  tipo           TEXT NOT NULL DEFAULT 'PERCORSO' CHECK (tipo IN ('PERCORSO','SDOPPIAMENTO')),
  capacita       INTEGER NOT NULL CHECK (capacita IN (2,3,6)),
  faraone_wallet TEXT,                                -- wallet del Faraone/Erede al centro
  turno          BIGINT NOT NULL DEFAULT 1 CHECK (turno >= 1),
  doni_ricevuti  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (doni_ricevuti >= 0),
  status         TEXT NOT NULL DEFAULT 'APERTA' CHECK (status IN ('APERTA','COMPLETATA','CHIUSA')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ENTRATA e PHARAOH hanno numerazioni indipendenti (entrambe iniziano da 1).
ALTER TABLE tavole DROP CONSTRAINT IF EXISTS tavole_numero_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tavole_sezione_numero
  ON tavole(sezione, numero);

-- Numeratori atomici indipendenti. L'UPSERT su una riga per sezione
-- serializza le assegnazioni concorrenti senza confondere ENTRATA e PHARAOH.
CREATE TABLE IF NOT EXISTS contatori_tavole (
  sezione        TEXT PRIMARY KEY CHECK (sezione IN ('ENTRATA', 'PHARAOH')),
  ultimo_numero  BIGINT NOT NULL DEFAULT 0 CHECK (ultimo_numero >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migrazione idempotente: allinea il contatore a eventuali tavole preesistenti
-- e non lo riporta mai indietro.
INSERT INTO contatori_tavole (sezione, ultimo_numero)
SELECT sezione, COALESCE(MAX(numero), 0)
FROM tavole
WHERE sezione IN ('ENTRATA', 'PHARAOH')
GROUP BY sezione
ON CONFLICT (sezione) DO UPDATE
SET ultimo_numero = GREATEST(
      contatori_tavole.ultimo_numero,
      EXCLUDED.ultimo_numero
    ),
    updated_at = NOW();

-- Posizioni (caselle) dentro ogni tavola
CREATE TABLE IF NOT EXISTS posizioni (
  id                     BIGSERIAL PRIMARY KEY,
  tavola_id              BIGINT NOT NULL REFERENCES tavole(id),
  casella                INTEGER NOT NULL CHECK (casella BETWEEN 1 AND 6),
  wallet                 TEXT NOT NULL,
  nome                   TEXT,
  tipo                   TEXT NOT NULL
    CHECK (tipo IN ('DONATORE','EREDE','FARAONE','SIMBIONTE','PERPETUO','GEMELLO','PROGREDITO')),
  dono_importo           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (dono_importo >= 0),
  sdoppiamento_tavola_id BIGINT REFERENCES tavole(id),
  status                 TEXT NOT NULL DEFAULT 'ATTIVO' CHECK (status IN ('ATTIVO','COMPLETATO')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tavola_id, casella)
);

-- Turni di gioco per ogni livello
CREATE TABLE IF NOT EXISTS turni (
  id                  BIGSERIAL PRIMARY KEY,
  sezione             TEXT NOT NULL CHECK (sezione IN ('ENTRATA','PHARAOH')),
  livello             INTEGER NOT NULL CHECK (livello BETWEEN 0 AND 5),
  blocco              INTEGER CHECK (blocco IS NULL OR blocco IN (1,2)),
  numero_turno        BIGINT NOT NULL CHECK (numero_turno >= 1),
  faraone_wallet      TEXT NOT NULL,                  -- wallet del Faraone di turno
  faraone_tipo        TEXT NOT NULL DEFAULT 'PRIMARIO'
    CHECK (faraone_tipo IN ('PRIMARIO','PERPETUO','GEMELLO','FONDO','EREDE','SECONDARIO')),
  tavola_faraone_num  BIGINT,
  sacerdoti_necessari INTEGER NOT NULL CHECK (sacerdoti_necessari >= 0),
  sacerdoti_entrati   INTEGER NOT NULL DEFAULT 0 CHECK (sacerdoti_entrati >= 0),
  tavole_create       INTEGER NOT NULL DEFAULT 0 CHECK (tavole_create >= 0),
  prima_tavola_num    BIGINT,
  ultima_tavola_num   BIGINT,
  doni_totali         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (doni_totali >= 0),
  status              TEXT NOT NULL DEFAULT 'IN_CORSO' CHECK (status IN ('IN_CORSO','COMPLETATO')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Funzioni rilasciate (Perpetuo, Gemello, Simbionti, Crediti)
CREATE TABLE IF NOT EXISTS funzioni (
  id                      BIGSERIAL PRIMARY KEY,
  tipo                    TEXT NOT NULL CHECK (tipo IN ('PERPETUO','GEMELLO','SIMBIONTE','CREDITO')),
  account_origine_wallet  TEXT NOT NULL,              -- Faraone che ha rilasciato
  account_generato_wallet TEXT,                       -- wallet del Perpetuo/Gemello generato
  sigla                   TEXT,                       -- A.1, 1-A, ecc.
  ticket_prenotato        BIGINT,
  importo                 NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (importo >= 0),
  turno_rilascio          BIGINT NOT NULL CHECK (turno_rilascio >= 1),
  turno_entrata           BIGINT,
  tavola_posizionamento   BIGINT,
  posizione_in_tavola     TEXT,                       -- es. 'HORUS_TAV1_POS2'
  status                  TEXT NOT NULL DEFAULT 'RILASCIATO'
    CHECK (status IN ('RILASCIATO','POSIZIONATO','USATO','COMPLETATO')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prenotazioni delle posizioni fisse delle Funzioni nel turno successivo.
CREATE TABLE IF NOT EXISTS prenotazioni_funzioni (
  id                            BIGSERIAL PRIMARY KEY,
  event_key                     TEXT NOT NULL UNIQUE,
  funzione_id                   BIGINT REFERENCES funzioni(id),
  tipo_funzione                 TEXT NOT NULL
    CHECK (tipo_funzione IN ('SIMBIONTE', 'PERPETUO', 'GEMELLO')),
  account_origine_wallet        TEXT NOT NULL,
  account_destinazione_wallet   TEXT,
  turno_origine                 BIGINT NOT NULL CHECK (turno_origine >= 1),
  turno_destinazione            BIGINT NOT NULL CHECK (turno_destinazione >= 1),
  livello_destinazione          INTEGER NOT NULL CHECK (livello_destinazione BETWEEN 0 AND 5),
  blocco_destinazione           INTEGER CHECK (blocco_destinazione IS NULL OR blocco_destinazione IN (1,2)),
  tavola_relativa               BIGINT NOT NULL CHECK (tavola_relativa >= 1),
  tavola_numero                 BIGINT,
  casella                       INTEGER NOT NULL CHECK (casella BETWEEN 1 AND 6),
  ticket_number                 BIGINT,
  stato                         TEXT NOT NULL DEFAULT 'RESERVED'
    CHECK (stato IN ('RESERVED', 'MATERIALIZED', 'CONSUMED', 'CANCELLED', 'ERROR')),
  posizione_id                  BIGINT REFERENCES posizioni(id),
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  materialized_at               TIMESTAMPTZ,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_prenotazioni_funzioni_posizione
  ON prenotazioni_funzioni (
    turno_destinazione,
    livello_destinazione,
    COALESCE(blocco_destinazione, 0),
    tavola_relativa,
    casella
  );

CREATE INDEX IF NOT EXISTS idx_prenotazioni_funzioni_stato
  ON prenotazioni_funzioni(stato);

CREATE INDEX IF NOT EXISTS idx_prenotazioni_funzioni_destinazione
  ON prenotazioni_funzioni(
    turno_destinazione,
    livello_destinazione,
    blocco_destinazione,
    tavola_relativa
  );

-- Contenitori (code FIFO)
CREATE TABLE IF NOT EXISTS contenitori (
  id                  BIGSERIAL PRIMARY KEY,
  tipo                TEXT NOT NULL CONSTRAINT chk_contenitori_tipo
    CHECK (tipo IN ('5','5.1','5.2','5.3')),
  wallet              TEXT NOT NULL,
  ticket_number       BIGINT,
  nome                TEXT,
  importo_disponibile NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (importo_disponibile >= 0),
  provenienza         TEXT,                           -- ISCRIZIONE | USCITA_ENTRATA | CREDITO
  status              TEXT NOT NULL DEFAULT 'IN_ATTESA' CONSTRAINT chk_contenitori_status
    CHECK (status IN ('IN_ATTESA','CHIAMATO','USATO')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Una sola dichiarazione attiva per wallet nella lista 5.1. Il wallet può
-- rientrare soltanto dopo che la dichiarazione precedente è stata usata.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contenitori_attesa_wallet
  ON contenitori ((LOWER(wallet)))
  WHERE tipo = '5.1' AND status IN ('IN_ATTESA', 'CHIAMATO');

-- Donazioni registrate (on-chain)
CREATE TABLE IF NOT EXISTS donazioni (
  id                  BIGSERIAL PRIMARY KEY,
  donor_wallet        TEXT NOT NULL,
  importo             NUMERIC(12,2) NOT NULL CHECK (importo > 0),
  tx_hash             TEXT UNIQUE,
  tipo                TEXT NOT NULL DEFAULT 'DONO' CHECK (tipo IN ('DONO','CREDITO','FUNZIONE')),
  destinatario_wallet TEXT,
  tavola_id           BIGINT REFERENCES tavole(id),
  livello             INTEGER CHECK (livello IS NULL OR livello BETWEEN 0 AND 5),
  turno               BIGINT,
  blockchain_proof    JSONB,
  blockchain_verified_at TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'COMPLETATA' CHECK (status IN ('COMPLETATA','FALLITA','ANNULLATA')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE donazioni
  ADD COLUMN IF NOT EXISTS blockchain_proof JSONB,
  ADD COLUMN IF NOT EXISTS blockchain_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_donazioni_tx_hash_lower
  ON donazioni ((LOWER(tx_hash)))
  WHERE tx_hash IS NOT NULL;

-- Doni a credito (rilasciati dai Faraoni, assegnati a chi non ha il dono)
CREATE TABLE IF NOT EXISTS doni_credito (
  id                    BIGSERIAL PRIMARY KEY,
  rilasciato_da_wallet  TEXT NOT NULL,               -- Faraone che ha rilasciato
  rilasciato_al_livello INTEGER NOT NULL CHECK (rilasciato_al_livello IN (3,4,5)),
  importo               NUMERIC(12,2) NOT NULL DEFAULT 100 CHECK (importo > 0),
  assegnato_a_wallet    TEXT,
  turno_rilascio        BIGINT,
  event_key             TEXT NOT NULL,
  event_index           INTEGER NOT NULL CHECK (event_index >= 0),
  natura                TEXT NOT NULL DEFAULT 'ANTICIPO',
  obbligo_restituzione  BOOLEAN NOT NULL DEFAULT TRUE,
  restituito_at         TIMESTAMPTZ,
  restituzione_tx_hash  TEXT,
  stato_restituzione    TEXT NOT NULL DEFAULT 'DA_RESTITUIRE'
    CONSTRAINT chk_doni_credito_restituzione
    CHECK (stato_restituzione IN ('DA_RESTITUIRE','RESTITUITO','NON_DOVUTO')),
  status                TEXT NOT NULL DEFAULT 'STANDBY' CONSTRAINT chk_doni_credito_status
    CHECK (status IN ('STANDBY','ASSEGNATO','USATO')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE doni_credito
  ADD COLUMN IF NOT EXISTS natura TEXT NOT NULL DEFAULT 'ANTICIPO',
  ADD COLUMN IF NOT EXISTS obbligo_restituzione BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS restituito_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS restituzione_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS stato_restituzione TEXT NOT NULL DEFAULT 'DA_RESTITUIRE',
  ADD COLUMN IF NOT EXISTS event_key TEXT,
  ADD COLUMN IF NOT EXISTS event_index INTEGER;

-- Collega in modo verificabile il credito assegnato alla successiva coda 5.
ALTER TABLE contenitori
  ADD COLUMN IF NOT EXISTS credito_id BIGINT REFERENCES doni_credito(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contenitori_credito
  ON contenitori(credito_id)
  WHERE credito_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_contenitori_tipo') THEN
    ALTER TABLE contenitori ADD CONSTRAINT chk_contenitori_tipo
      CHECK (tipo IN ('5', '5.1', '5.2', '5.3')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_contenitori_status') THEN
    ALTER TABLE contenitori ADD CONSTRAINT chk_contenitori_status
      CHECK (status IN ('IN_ATTESA', 'CHIAMATO', 'USATO')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_doni_credito_status') THEN
    ALTER TABLE doni_credito ADD CONSTRAINT chk_doni_credito_status
      CHECK (status IN ('STANDBY', 'ASSEGNATO', 'USATO')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_doni_credito_restituzione') THEN
    ALTER TABLE doni_credito ADD CONSTRAINT chk_doni_credito_restituzione
      CHECK (stato_restituzione IN ('DA_RESTITUIRE', 'RESTITUITO', 'NON_DOVUTO')) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_doni_credito_event
  ON doni_credito(event_key, event_index);

-- Doni pendenti (payout controllato)
CREATE TABLE IF NOT EXISTS doni_pendenti (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  wallet TEXT NOT NULL,
  importo NUMERIC(12,2) NOT NULL CHECK (importo > 0),
  livello INTEGER NOT NULL CHECK (livello IN (0,3,4,5)),
  tipo_uscita TEXT NOT NULL,
  tipo_account TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','ACCEPTED','SENT','EXPIRED','FAILED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  tx_hash TEXT UNIQUE,
  errore TEXT,
  dettagli JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Il livello 0 identifica il trasferimento automatico della quota Entrata
-- verso la terza stringa. La migrazione è idempotente sui database esistenti.
ALTER TABLE doni_pendenti
  DROP CONSTRAINT IF EXISTS doni_pendenti_livello_check;
ALTER TABLE doni_pendenti
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE doni_pendenti
  ADD CONSTRAINT doni_pendenti_livello_check
  CHECK (livello IN (0,3,4,5));

CREATE INDEX IF NOT EXISTS idx_doni_pendenti_wallet_status
  ON doni_pendenti(wallet, status);
CREATE INDEX IF NOT EXISTS idx_doni_pendenti_expiry
  ON doni_pendenti(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_doni_pendenti_processing
  ON doni_pendenti(status, processing_started_at);

-- Audit immutabile doni pendenti
CREATE TABLE IF NOT EXISTS audit_doni_pendenti (
  id BIGSERIAL PRIMARY KEY,
  dono_pendente_id BIGINT NOT NULL REFERENCES doni_pendenti(id),
  evento TEXT NOT NULL,
  dettagli JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stato globale persistente (chiave/valore JSON)
-- Usato anche per il kill switch: key = 'sistema_blocco'
CREATE TABLE IF NOT EXISTS state_persistence (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Registro operazioni post-COMMIT
CREATE TABLE IF NOT EXISTS post_commit_operations (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  operation_type TEXT NOT NULL,
  tx_hash TEXT,
  source_tavola_id BIGINT,
  source_tavola_numero BIGINT,
  turno_id BIGINT,
  turno_numero BIGINT,
  wallet TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_post_commit_operations_status
  ON post_commit_operations(status);

CREATE INDEX IF NOT EXISTS idx_post_commit_operations_source_tavola
  ON post_commit_operations(source_tavola_id);

-- Storico avanzamenti Faraone (audit trail completo)
CREATE TABLE IF NOT EXISTS storico_avanzamenti (
  id              BIGSERIAL PRIMARY KEY,
  wallet          TEXT NOT NULL,
  tipo_account    TEXT,
  da_livello      INTEGER,
  a_livello       INTEGER,
  da_blocco       INTEGER,
  a_blocco        INTEGER,
  turno           BIGINT,
  doni_ricevuti   NUMERIC(12,2),
  doni_trattenuti NUMERIC(12,2),
  netto           NUMERIC(12,2),
  evento          TEXT,       -- USCITA_ENTRATA | USCITA_L3 | USCITA_L4 | USCITA_L5 | RILASCIO_FUNZIONI
  event_key       TEXT,
  dettagli        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_storico_avanzamenti_event_key
  ON storico_avanzamenti(event_key)
  WHERE event_key IS NOT NULL;

-- Verifiche KYC (Polygon ID ZK-KYC) — richiesta all'uscita L3 (payout 6.000 USDC)
CREATE TABLE IF NOT EXISTS kyc_verifications (
  id          BIGSERIAL PRIMARY KEY,
  wallet      TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','EXPIRED')),
  session_id  TEXT,                              -- UUID sessione ZK corrente
  proof_id    TEXT,                              -- identificatore proof (no dati personali)
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Testimonianze partecipanti (moderazione admin)
CREATE TABLE IF NOT EXISTS testimonianze (
  id                  BIGSERIAL PRIMARY KEY,
  wallet              TEXT NOT NULL,
  posizioni_count     INTEGER NOT NULL DEFAULT 0 CHECK (posizioni_count >= 0),
  livello             INTEGER CHECK (livello IS NULL OR livello BETWEEN 0 AND 5),
  livello_label       TEXT,
  dono_ricevuto       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (dono_ricevuto >= 0),
  testo               TEXT NOT NULL,
  immagine_url        TEXT,
  stato               TEXT NOT NULL DEFAULT 'IN_ATTESA'
    CHECK (stato IN ('IN_ATTESA','APPROVATA','RIFIUTATA','NASCOSTA')),
  mostra_pubblicamente BOOLEAN NOT NULL DEFAULT false,
  in_evidenza         BOOLEAN NOT NULL DEFAULT false,
  note_admin          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Comunicazioni community
CREATE TABLE IF NOT EXISTS comunicazioni (
  id              BIGSERIAL PRIMARY KEY,
  titolo          TEXT NOT NULL,
  contenuto       TEXT NOT NULL,
  immagine_url    TEXT,
  categoria       TEXT NOT NULL DEFAULT 'AGGIORNAMENTO',
  stato           TEXT NOT NULL DEFAULT 'BOZZA' CHECK (stato IN ('BOZZA','PUBBLICATA')),
  fissata         BOOLEAN NOT NULL DEFAULT false,
  scheduled_for   TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Risorse condivise alla community
CREATE TABLE IF NOT EXISTS risorse (
  id              BIGSERIAL PRIMARY KEY,
  titolo          TEXT NOT NULL,
  descrizione     TEXT,
  categoria       TEXT NOT NULL DEFAULT 'Guide',
  tipo            TEXT NOT NULL DEFAULT 'LINK' CHECK (tipo IN ('FILE','LINK','VIDEO')),
  file_url        TEXT,
  file_name       TEXT,
  file_size       TEXT,
  mime_type       TEXT,
  link_url        TEXT,
  anteprima_url   TEXT,
  visibilita      TEXT NOT NULL DEFAULT 'COMMUNITY' CHECK (visibilita IN ('PUBBLICA','COMMUNITY','ADMIN')),
  stato           TEXT NOT NULL DEFAULT 'BOZZA' CHECK (stato IN ('BOZZA','PUBBLICATA')),
  autore_wallet   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Eventi PHARAOH
CREATE TABLE IF NOT EXISTS eventi (
  id                   BIGSERIAL PRIMARY KEY,
  titolo               TEXT NOT NULL,
  descrizione          TEXT,
  data_evento          DATE NOT NULL,
  orario_evento        TEXT,
  piattaforma_link     TEXT,
  immagine_url         TEXT,
  stato                TEXT NOT NULL DEFAULT 'PROGRAMMATO' CHECK (stato IN ('PROGRAMMATO','CONCLUSO','ANNULLATO')),
  visibilita           TEXT NOT NULL DEFAULT 'COMMUNITY' CHECK (visibilita IN ('PUBBLICA','COMMUNITY','ADMIN')),
  registrazione_link   TEXT,
  created_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Impostazioni pannello admin (key/value JSON)
CREATE TABLE IF NOT EXISTS admin_settings (
  key          TEXT PRIMARY KEY,
  value        JSONB NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Note amministrative per wallet partecipante
CREATE TABLE IF NOT EXISTS admin_notes (
  id          BIGSERIAL PRIMARY KEY,
  wallet      TEXT NOT NULL,
  nota        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit minimale delle API privilegiate. Non contiene header, body, query,
-- chiavi amministrative o indirizzi IP in chiaro.
CREATE TABLE IF NOT EXISTS api_audit_log (
  id                    BIGSERIAL PRIMARY KEY,
  request_id            UUID NOT NULL UNIQUE,
  method                TEXT NOT NULL,
  path                  TEXT NOT NULL,
  status_code           INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  admin_authenticated   BOOLEAN NOT NULL DEFAULT false,
  ip_hash               TEXT,
  duration_ms           INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_audit_log_created
  ON api_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_audit_log_path_status
  ON api_audit_log(path, status_code);

-- ─── INDICI ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_accounts_wallet        ON accounts(wallet);
CREATE INDEX IF NOT EXISTS idx_accounts_ticket        ON accounts(ticket_number);
CREATE INDEX IF NOT EXISTS idx_tavole_numero          ON tavole(numero);
CREATE INDEX IF NOT EXISTS idx_tavole_status          ON tavole(status);
CREATE INDEX IF NOT EXISTS idx_tavole_livello_turno   ON tavole(livello, turno);
CREATE INDEX IF NOT EXISTS idx_posizioni_tavola       ON posizioni(tavola_id);
CREATE INDEX IF NOT EXISTS idx_posizioni_wallet       ON posizioni(wallet);
CREATE INDEX IF NOT EXISTS idx_contenitori_tipo_status ON contenitori(tipo, status);
CREATE INDEX IF NOT EXISTS idx_funzioni_tipo_status   ON funzioni(tipo, status);
CREATE INDEX IF NOT EXISTS idx_turni_livello_status   ON turni(livello, status);
CREATE INDEX IF NOT EXISTS idx_doni_credito_status    ON doni_credito(status);
CREATE INDEX IF NOT EXISTS idx_doni_credito_fifo      ON doni_credito(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_contenitori_fifo       ON contenitori(tipo, status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_doni_pendenti_status   ON doni_pendenti(status);
CREATE INDEX IF NOT EXISTS idx_kyc_wallet             ON kyc_verifications(wallet);
CREATE INDEX IF NOT EXISTS idx_kyc_status             ON kyc_verifications(status);
CREATE INDEX IF NOT EXISTS idx_testimonianze_wallet   ON testimonianze(wallet);
CREATE INDEX IF NOT EXISTS idx_testimonianze_stato    ON testimonianze(stato);
CREATE INDEX IF NOT EXISTS idx_testimonianze_created  ON testimonianze(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comunicazioni_stato    ON comunicazioni(stato);
CREATE INDEX IF NOT EXISTS idx_comunicazioni_pub      ON comunicazioni(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_risorse_stato          ON risorse(stato);
CREATE INDEX IF NOT EXISTS idx_risorse_categoria      ON risorse(categoria);
CREATE INDEX IF NOT EXISTS idx_eventi_data            ON eventi(data_evento DESC);
CREATE INDEX IF NOT EXISTS idx_eventi_stato           ON eventi(stato);
CREATE INDEX IF NOT EXISTS idx_admin_notes_wallet     ON admin_notes(wallet);

-- ─── STATO INIZIALE ───────────────────────────────────────────
-- Inserisce il record di sistema_blocco in stato sbloccato.
-- Il backend farà initDatabase() al primo avvio e scriverà il resto.

INSERT INTO state_persistence (key, value)
VALUES ('sistema_blocco', '{"bloccato": false}')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Fine schema PHARAON — versione 1.0
-- ============================================================

/**
 * 🏛️ PHARAOH - Database Manager
 *
 * Schema PostgreSQL completo + query helper per tutti i moduli.
 * Implementa il modello dati del sistema PHARAOH a 1+5 livelli.
 */

const pg = require('./pg-connection-manager');

// ========================================
// SCHEMA
// ========================================

const SCHEMA_SQL = `

-- Account registrati nel sistema
CREATE TABLE IF NOT EXISTS accounts (
  id            BIGSERIAL PRIMARY KEY,
  wallet        TEXT NOT NULL UNIQUE,
  nome          TEXT,
  ticket_number BIGINT UNIQUE,                      -- NULL finché non rilasciato
  tipo          TEXT NOT NULL DEFAULT 'PRIMARIO'
    CHECK (tipo IN ('PRIMARIO','PERPETUO','GEMELLO','SIMBIONTE','FONDO')),
  sigla         TEXT,                                -- es. A.1, 1-A, 2-A ...
  parent_wallet TEXT,                                -- wallet dell'account origine
  status        TEXT NOT NULL DEFAULT 'REGISTRATO'
    CHECK (status IN ('REGISTRATO','IN_CODA','ATTIVO','COMPLETATO')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_tipo_sigla_secondari
  ON accounts(tipo, sigla)
  WHERE tipo IN ('PERPETUO', 'GEMELLO') AND sigla IS NOT NULL;

CREATE TABLE IF NOT EXISTS identita_funzioni (
  id BIGSERIAL PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  wallet_proprietario TEXT NOT NULL,
  account_origine_wallet TEXT NOT NULL,
  tipo TEXT NOT NULL
    CHECK (tipo IN ('PERPETUO','GEMELLO','SIMBIONTE')),
  sigla TEXT NOT NULL,
  progressivo BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ATTIVA'
    CONSTRAINT chk_identita_funzioni_status
    CHECK (status IN ('ATTIVA', 'SOSPESA', 'CHIUSA')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  ON identita_funzioni (
    wallet_proprietario,
    tipo,
    progressivo
  );

-- Tavole (numero sequenziale indipendente per sezione)
CREATE TABLE IF NOT EXISTS tavole (
  id            BIGSERIAL PRIMARY KEY,
  numero        BIGINT NOT NULL,                     -- sequenziale dentro la sezione
  sezione       TEXT NOT NULL CHECK (sezione IN ('ENTRATA','PHARAOH')),
  livello       INTEGER NOT NULL DEFAULT 0 CHECK (livello BETWEEN 0 AND 5),
  blocco        INTEGER CHECK (blocco IS NULL OR blocco IN (1,2)),
  tipo          TEXT NOT NULL DEFAULT 'PERCORSO' CHECK (tipo IN ('PERCORSO','SDOPPIAMENTO')),
  capacita      INTEGER NOT NULL CHECK (capacita IN (2,3,6)),
  faraone_wallet TEXT,                                -- wallet del Faraone/Erede al centro
  turno         BIGINT NOT NULL DEFAULT 1 CHECK (turno >= 1),
  doni_ricevuti NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (doni_ricevuti >= 0),
  status        TEXT NOT NULL DEFAULT 'APERTA' CHECK (status IN ('APERTA','COMPLETATA','CHIUSA')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ENTRATA e PHARAOH hanno numerazioni indipendenti (entrambe iniziano da 1).
ALTER TABLE tavole DROP CONSTRAINT IF EXISTS tavole_numero_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tavole_sezione_numero
  ON tavole(sezione, numero);

-- Numeratori atomici indipendenti per sezione.
CREATE TABLE IF NOT EXISTS contatori_tavole (
  sezione        TEXT PRIMARY KEY CHECK (sezione IN ('ENTRATA', 'PHARAOH')),
  ultimo_numero  BIGINT NOT NULL DEFAULT 0 CHECK (ultimo_numero >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  id            BIGSERIAL PRIMARY KEY,
  tavola_id     BIGINT NOT NULL REFERENCES tavole(id),
  casella       INTEGER NOT NULL CHECK (casella BETWEEN 1 AND 6),
  wallet        TEXT NOT NULL,
  nome          TEXT,
  tipo          TEXT NOT NULL
    CHECK (tipo IN ('DONATORE','EREDE','FARAONE','SIMBIONTE','PERPETUO','GEMELLO','PROGREDITO','ROLLOVER')),
  dono_importo  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (dono_importo >= 0),
  sdoppiamento_tavola_id BIGINT REFERENCES tavole(id),
  status        TEXT NOT NULL DEFAULT 'ATTIVO' CHECK (status IN ('ATTIVO','COMPLETATO')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tavola_id, casella)
);

-- Turni di gioco per ogni livello
CREATE TABLE IF NOT EXISTS turni (
  id                  BIGSERIAL PRIMARY KEY,
  sezione             TEXT NOT NULL CHECK (sezione IN ('ENTRATA','PHARAOH')),
  livello             INTEGER NOT NULL CHECK (livello BETWEEN 0 AND 5),
  blocco              INTEGER CHECK (blocco IS NULL OR blocco IN (1,2)),
  numero_turno        BIGINT NOT NULL CHECK (numero_turno >= 1),
  faraone_wallet      TEXT NOT NULL,                   -- wallet del Faraone di turno
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

-- Funzioni rilasciate (Perpetuo, Gemello, Simbionti)
CREATE TABLE IF NOT EXISTS funzioni (
  id                      BIGSERIAL PRIMARY KEY,
  tipo                    TEXT NOT NULL CHECK (tipo IN ('PERPETUO','GEMELLO','SIMBIONTE')),
  account_origine_wallet  TEXT NOT NULL,                -- Faraone che ha rilasciato
  account_generato_wallet TEXT,                         -- wallet del Perpetuo/Gemello generato
  sigla                   TEXT,                         -- A.1, 1-A, ecc.
  ticket_prenotato        BIGINT,
  importo                 NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (importo >= 0),
  turno_rilascio          BIGINT NOT NULL CHECK (turno_rilascio >= 1),
  turno_entrata           BIGINT,
  tavola_posizionamento   BIGINT,
  posizione_in_tavola     TEXT,                         -- es. 'HORUS_TAV1_POS2'
  status                  TEXT NOT NULL DEFAULT 'RILASCIATO'
    CHECK (status IN ('RILASCIATO','POSIZIONATO','USATO','COMPLETATO')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prenotazioni_funzioni (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  funzione_id BIGINT REFERENCES funzioni(id),
  tipo_funzione TEXT NOT NULL
    CHECK (tipo_funzione IN ('SIMBIONTE','PERPETUO','GEMELLO')),
  account_origine_wallet TEXT NOT NULL,
  account_destinazione_wallet TEXT,
  turno_origine BIGINT NOT NULL CHECK (turno_origine >= 1),
  turno_destinazione BIGINT NOT NULL CHECK (turno_destinazione >= 1),
  livello_destinazione INTEGER NOT NULL CHECK (livello_destinazione BETWEEN 0 AND 5),
  blocco_destinazione INTEGER CHECK (blocco_destinazione IS NULL OR blocco_destinazione IN (1,2)),
  tavola_relativa BIGINT NOT NULL CHECK (tavola_relativa >= 1),
  tavola_numero BIGINT,
  casella INTEGER NOT NULL CHECK (casella BETWEEN 1 AND 6),
  ticket_number BIGINT,
  stato TEXT NOT NULL DEFAULT 'RESERVED'
    CHECK (stato IN ('RESERVED','MATERIALIZED','CONSUMED','CANCELLED','ERROR')),
  posizione_id BIGINT REFERENCES posizioni(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  materialized_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  id                BIGSERIAL PRIMARY KEY,
  tipo              TEXT NOT NULL CONSTRAINT chk_contenitori_tipo
    CHECK (tipo IN ('5','5.2')),
  wallet            TEXT NOT NULL,
  ticket_number     BIGINT,
  nome              TEXT,
  importo_disponibile NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (importo_disponibile >= 0),
  provenienza       TEXT,                               -- ISCRIZIONE | USCITA_ENTRATA
  status            TEXT NOT NULL DEFAULT 'IN_ATTESA' CONSTRAINT chk_contenitori_status
    CHECK (status IN ('IN_ATTESA','CHIAMATO','USATO')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Donazioni registrate
CREATE TABLE IF NOT EXISTS donazioni (
  id            BIGSERIAL PRIMARY KEY,
  donor_wallet  TEXT NOT NULL,
  importo       NUMERIC(12,2) NOT NULL CHECK (importo > 0),
  tx_hash       TEXT UNIQUE,
  tipo          TEXT NOT NULL DEFAULT 'DONO' CHECK (tipo IN ('DONO','FUNZIONE')),
  destinatario_wallet TEXT,
  tavola_id     BIGINT REFERENCES tavole(id),
  livello       INTEGER CHECK (livello IS NULL OR livello BETWEEN 0 AND 5),
  turno         BIGINT,
  blockchain_proof JSONB,
  blockchain_verified_at TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'COMPLETATA' CHECK (status IN ('COMPLETATA','FALLITA','ANNULLATA')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE donazioni
  ADD COLUMN IF NOT EXISTS blockchain_proof JSONB,
  ADD COLUMN IF NOT EXISTS blockchain_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_donazioni_tx_hash_lower
  ON donazioni ((LOWER(tx_hash)))
  WHERE tx_hash IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_contenitori_tipo') THEN
    ALTER TABLE contenitori ADD CONSTRAINT chk_contenitori_tipo
      CHECK (tipo IN ('5', '5.2')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_contenitori_status') THEN
    ALTER TABLE contenitori ADD CONSTRAINT chk_contenitori_status
      CHECK (status IN ('IN_ATTESA', 'CHIAMATO', 'USATO')) NOT VALID;
  END IF;
END $$;

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

-- Il livello 0 resta disponibile nello storico dei doni pendenti legacy.
-- Dal recovery 0012 la quota Entrata da 100 non viene piu trasferita: e un riporto interno.
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

-- Stato globale persistente (chiave/valore)
CREATE TABLE IF NOT EXISTS state_persistence (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

-- Storico avanzamenti Faraone (per audit trail)
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
  evento          TEXT,                                -- USCITA_ENTRATA | USCITA_L3 | USCITA_L4 | USCITA_L5 | RILASCIO_FUNZIONI
  event_key       TEXT,
  dettagli        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_storico_avanzamenti_event_key
  ON storico_avanzamenti(event_key)
  WHERE event_key IS NOT NULL;

-- Verifica KYC (Polygon ID ZK-KYC) — richiesta all'uscita da L3 (ricezione 6.000 USDC)
CREATE TABLE IF NOT EXISTS kyc_verifications (
  id          BIGSERIAL PRIMARY KEY,
  wallet      TEXT NOT NULL UNIQUE,              -- wallet del Faraone
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','EXPIRED')),
  session_id  TEXT,                              -- UUID sessione corrente
  proof_id    TEXT,                              -- identificatore proof ZK (no dati personali)
  verified_at TIMESTAMPTZ,                       -- quando è stata verificata
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Testimonianze partecipanti (moderazione admin)
CREATE TABLE IF NOT EXISTS testimonianze (
  id                   BIGSERIAL PRIMARY KEY,
  wallet               TEXT NOT NULL,
  posizioni_count      INTEGER NOT NULL DEFAULT 0 CHECK (posizioni_count >= 0),
  livello              INTEGER CHECK (livello IS NULL OR livello BETWEEN 0 AND 5),
  livello_label        TEXT,
  dono_ricevuto        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (dono_ricevuto >= 0),
  testo                TEXT NOT NULL,
  immagine_url         TEXT,
  stato                TEXT NOT NULL DEFAULT 'IN_ATTESA'
    CHECK (stato IN ('IN_ATTESA','APPROVATA','RIFIUTATA','NASCOSTA')),
  mostra_pubblicamente BOOLEAN NOT NULL DEFAULT false,
  in_evidenza          BOOLEAN NOT NULL DEFAULT false,
  note_admin           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Comunicazioni community
CREATE TABLE IF NOT EXISTS comunicazioni (
  id             BIGSERIAL PRIMARY KEY,
  titolo         TEXT NOT NULL,
  contenuto      TEXT NOT NULL,
  immagine_url   TEXT,
  categoria      TEXT NOT NULL DEFAULT 'AGGIORNAMENTO',
  stato          TEXT NOT NULL DEFAULT 'BOZZA' CHECK (stato IN ('BOZZA','PUBBLICATA')),
  fissata        BOOLEAN NOT NULL DEFAULT false,
  scheduled_for  TIMESTAMPTZ,
  published_at   TIMESTAMPTZ,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Risorse community
CREATE TABLE IF NOT EXISTS risorse (
  id            BIGSERIAL PRIMARY KEY,
  titolo        TEXT NOT NULL,
  descrizione   TEXT,
  categoria     TEXT NOT NULL DEFAULT 'Guide',
  tipo          TEXT NOT NULL DEFAULT 'LINK' CHECK (tipo IN ('FILE','LINK','VIDEO')),
  file_url      TEXT,
  file_name     TEXT,
  file_size     TEXT,
  mime_type     TEXT,
  link_url      TEXT,
  anteprima_url TEXT,
  visibilita    TEXT NOT NULL DEFAULT 'COMMUNITY' CHECK (visibilita IN ('PUBBLICA','COMMUNITY','ADMIN')),
  stato         TEXT NOT NULL DEFAULT 'BOZZA' CHECK (stato IN ('BOZZA','PUBBLICATA')),
  autore_wallet TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Eventi PHARAOH
CREATE TABLE IF NOT EXISTS eventi (
  id                 BIGSERIAL PRIMARY KEY,
  titolo             TEXT NOT NULL,
  descrizione        TEXT,
  data_evento        DATE NOT NULL,
  orario_evento      TEXT,
  piattaforma_link   TEXT,
  immagine_url       TEXT,
  stato              TEXT NOT NULL DEFAULT 'PROGRAMMATO' CHECK (stato IN ('PROGRAMMATO','CONCLUSO','ANNULLATO')),
  visibilita         TEXT NOT NULL DEFAULT 'COMMUNITY' CHECK (visibilita IN ('PUBBLICA','COMMUNITY','ADMIN')),
  registrazione_link TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Impostazioni pannello admin
CREATE TABLE IF NOT EXISTS admin_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Note amministrative partecipanti
CREATE TABLE IF NOT EXISTS admin_notes (
  id         BIGSERIAL PRIMARY KEY,
  wallet     TEXT NOT NULL,
  nota       TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_audit_log (
  id                  BIGSERIAL PRIMARY KEY,
  request_id          UUID NOT NULL UNIQUE,
  method              TEXT NOT NULL,
  path                TEXT NOT NULL,
  status_code         INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  admin_authenticated BOOLEAN NOT NULL DEFAULT false,
  ip_hash             TEXT,
  duration_ms         INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_audit_log_created
  ON api_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_audit_log_path_status
  ON api_audit_log(path, status_code);

-- Indici
CREATE INDEX IF NOT EXISTS idx_accounts_wallet ON accounts(wallet);
CREATE INDEX IF NOT EXISTS idx_accounts_ticket ON accounts(ticket_number);
CREATE INDEX IF NOT EXISTS idx_tavole_numero ON tavole(numero);
CREATE INDEX IF NOT EXISTS idx_tavole_status ON tavole(status);
CREATE INDEX IF NOT EXISTS idx_tavole_livello_turno ON tavole(livello, turno);
CREATE INDEX IF NOT EXISTS idx_posizioni_tavola ON posizioni(tavola_id);
-- Identita logica separata dal wallet: un wallet puo possedere piu percorsi.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_wallet_key;
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS account_key TEXT,
  ADD COLUMN IF NOT EXISTS parent_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS root_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS source_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS source_event_key TEXT,
  ADD COLUMN IF NOT EXISTS origin_kind TEXT NOT NULL DEFAULT 'LEGACY';
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_account_key
  ON accounts(account_key) WHERE account_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_wallet_multi ON accounts(LOWER(wallet), id);

ALTER TABLE posizioni
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_sigla TEXT;
ALTER TABLE tavole
  ADD COLUMN IF NOT EXISTS faraone_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS faraone_sigla TEXT;
ALTER TABLE turni
  ADD COLUMN IF NOT EXISTS faraone_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS faraone_sigla TEXT;
ALTER TABLE contenitori
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_sigla TEXT;
ALTER TABLE funzioni
  ADD COLUMN IF NOT EXISTS account_origine_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_generato_id BIGINT REFERENCES accounts(id);
ALTER TABLE prenotazioni_funzioni
  ADD COLUMN IF NOT EXISTS account_origine_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_destinazione_id BIGINT REFERENCES accounts(id);
ALTER TABLE storico_avanzamenti
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_sigla TEXT;
ALTER TABLE doni_pendenti
  ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS account_sigla TEXT;

CREATE INDEX IF NOT EXISTS idx_posizioni_wallet ON posizioni(wallet);
CREATE INDEX IF NOT EXISTS idx_posizioni_account_id ON posizioni(account_id);
CREATE INDEX IF NOT EXISTS idx_tavole_faraone_account_id ON tavole(faraone_account_id);
CREATE INDEX IF NOT EXISTS idx_turni_faraone_account_id ON turni(faraone_account_id);
CREATE INDEX IF NOT EXISTS idx_contenitori_tipo_status ON contenitori(tipo, status);
CREATE INDEX IF NOT EXISTS idx_funzioni_tipo_status ON funzioni(tipo, status);
CREATE INDEX IF NOT EXISTS idx_turni_livello_status ON turni(livello, status);
CREATE INDEX IF NOT EXISTS idx_contenitori_fifo ON contenitori(tipo, status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_doni_pendenti_status ON doni_pendenti(status);
CREATE INDEX IF NOT EXISTS idx_kyc_wallet ON kyc_verifications(wallet);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_verifications(status);
CREATE INDEX IF NOT EXISTS idx_testimonianze_wallet ON testimonianze(wallet);
CREATE INDEX IF NOT EXISTS idx_testimonianze_stato ON testimonianze(stato);
CREATE INDEX IF NOT EXISTS idx_testimonianze_created ON testimonianze(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comunicazioni_stato ON comunicazioni(stato);
CREATE INDEX IF NOT EXISTS idx_comunicazioni_pub ON comunicazioni(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_risorse_stato ON risorse(stato);
CREATE INDEX IF NOT EXISTS idx_risorse_categoria ON risorse(categoria);
CREATE INDEX IF NOT EXISTS idx_eventi_data ON eventi(data_evento DESC);
CREATE INDEX IF NOT EXISTS idx_eventi_stato ON eventi(stato);
CREATE INDEX IF NOT EXISTS idx_admin_notes_wallet ON admin_notes(wallet);

-- Guard ticket/caselle riservate alle Funzioni e audit riporto Entrata da 100 USDC.
CREATE INDEX IF NOT EXISTS idx_prenotazioni_funzioni_ticket_stato
  ON prenotazioni_funzioni(ticket_number, stato)
  WHERE ticket_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prenotazioni_funzioni_entry_slot
  ON prenotazioni_funzioni(turno_destinazione, livello_destinazione, tavola_numero, tavola_relativa, casella, stato);

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
  status TEXT NOT NULL DEFAULT 'MATERIALIZED' CHECK (status IN ('MATERIALIZED','CANCELLED','ERROR')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_tavola_id),
  UNIQUE(target_tavola_id)
);
CREATE INDEX IF NOT EXISTS idx_entry_rollovers_target_turno ON entry_rollovers(target_turno);

INSERT INTO state_persistence (key, value)
VALUES ('sistema_blocco', '{"bloccato": false}')
ON CONFLICT (key) DO NOTHING;
`;

// ========================================
// INIZIALIZZAZIONE
// ========================================

let initialized = false;

async function initDatabase() {
  if (initialized) return;

  console.log('🏛️  Inizializzazione database PHARAOH...');
  await pg.query(SCHEMA_SQL);
  initialized = true;
  console.log('✅ Database PHARAOH pronto');
}

/**
 * Assegna il prossimo ticket Gemello disponibile (26, 40, 54...).
 * Operazione transazionale e protetta da lock.
 */
async function assignNextGemelloTicket(wallet, client = null) {
  if (!client) {
    await initDatabase();
  }
  const w = wallet.toLowerCase();
  const dbClient = client || await pg.getClient();
  const shouldManageTx = !client;
  try {
    if (shouldManageTx) {
      await dbClient.query('BEGIN');
    }
    await lockTicketAllocation(dbClient);

    const existing = await getExistingTicketForUpdate(dbClient, w);
    if (!existing) {
      throw new Error(`Account ${w} non trovato`);
    }
    if (existing.ticket_number) {
      if (shouldManageTx) {
        await dbClient.query('COMMIT');
      }
      return existing;
    }

    const candidate = await findNextGemelloTicket(dbClient);
    if (!candidate) {
      throw new Error('Nessun ticket Gemello disponibile');
    }

    const occupato = await dbClient.query(
      'SELECT id, wallet FROM accounts WHERE ticket_number = $1 FOR UPDATE',
      [candidate]
    );
    if (occupato.rows.length > 0) {
      throw new Error(
        `Ticket Gemello ${candidate} già occupato dall’account ${occupato.rows[0].wallet}`
      );
    }

    const updated = await dbClient.query(
      'UPDATE accounts SET ticket_number = $1, status = $2 WHERE wallet = $3 RETURNING *',
      [candidate, 'IN_CODA', w]
    );

    if (shouldManageTx) {
      await dbClient.query('COMMIT');
    }
    return updated.rows[0] || null;
  } catch (err) {
    if (shouldManageTx) {
      try {
        await dbClient.query('ROLLBACK');
      } catch (_) {}
    }
    throw err;
  } finally {
    if (shouldManageTx) {
      dbClient.release();
    }
  }
}

// ========================================
// ACCOUNTS
// ========================================

async function createAccount({
  wallet,
  nome,
  tipo = 'PRIMARIO',
  sigla = null,
  parentWallet = null,
  accountKey = null,
  parentAccountId = null,
  rootAccountId = null,
  sourceAccountId = null,
  sourceEventKey = null,
  originKind = 'LEGACY'
}, client = null) {
  if (!client) await initDatabase();
  const w = String(wallet || '').trim().toLowerCase();
  if (!w) throw new Error('Wallet account obbligatorio');
  const key = accountKey ? String(accountKey).trim() : null;
  const runner = client || pg;

  if (key) {
    const existingByKey = await runner.query(
      'SELECT * FROM accounts WHERE account_key = $1 LIMIT 1',
      [key]
    );
    const row = existingByKey.rows?.[0] || existingByKey;
    if (row && row.id) {
      if (String(row.wallet).toLowerCase() !== w || row.tipo !== tipo) {
        throw new Error(`account_key gia usata con identita differente: ${key}`);
      }
      return row;
    }
  } else {
    const existingSql = sigla == null
      ? `SELECT * FROM accounts WHERE LOWER(wallet) = $1 AND tipo = $2 AND sigla IS NULL ORDER BY id ASC LIMIT 1`
      : `SELECT * FROM accounts WHERE LOWER(wallet) = $1 AND tipo = $2 AND sigla = $3 ORDER BY id ASC LIMIT 1`;
    const existingParams = sigla == null ? [w, tipo] : [w, tipo, sigla];
    const existing = client
      ? (await client.query(existingSql, existingParams)).rows[0] || null
      : await pg.queryOne(existingSql, existingParams);
    if (existing) return existing;
  }

  const sql = `INSERT INTO accounts (
      wallet, nome, tipo, sigla, parent_wallet, account_key,
      parent_account_id, root_account_id, source_account_id, source_event_key, origin_kind
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *`;
  const params = [
    w, nome, tipo, sigla, parentWallet ? parentWallet.toLowerCase() : null, key,
    parentAccountId, rootAccountId, sourceAccountId, sourceEventKey, originKind
  ];
  if (client) return (await client.query(sql, params)).rows[0] || null;
  return await pg.queryOne(sql, params);
}


// ========================================
// POST-COMMIT OPERATIONS
// ========================================

async function createPostCommitOperation({
  eventKey,
  operationType,
  txHash = null,
  sourceTavolaId = null,
  sourceTavolaNumero = null,
  turnoId = null,
  turnoNumero = null,
  wallet = null,
  payload = {}
}, client = null) {
  await initDatabase();
  if (!eventKey || typeof eventKey !== 'string' || !eventKey.trim()) {
    throw new Error('eventKey obbligatorio');
  }
  if (!operationType || typeof operationType !== 'string' || !operationType.trim()) {
    throw new Error('operationType obbligatorio');
  }

  const eventKeyNormalizzato = eventKey.trim();
  const operationTypeNormalizzato = operationType.trim();
  const txHashNormalizzato = txHash ? txHash.toLowerCase() : null;
  const walletNormalizzato = wallet ? wallet.toLowerCase() : null;
  const payloadNormalizzato = payload && typeof payload === 'object' ? payload : {};

  const sqlInsert = `INSERT INTO post_commit_operations (
      event_key,
      operation_type,
      tx_hash,
      source_tavola_id,
      source_tavola_numero,
      turno_id,
      turno_numero,
      wallet,
      payload
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (event_key) DO NOTHING
    RETURNING *`;
  const params = [
    eventKeyNormalizzato,
    operationTypeNormalizzato,
    txHashNormalizzato,
    sourceTavolaId,
    sourceTavolaNumero,
    turnoId,
    turnoNumero,
    walletNormalizzato,
    JSON.stringify(payloadNormalizzato)
  ];

  const inserted = client
    ? (await client.query(sqlInsert, params)).rows[0] || null
    : await pg.queryOne(sqlInsert, params);
  if (inserted) return inserted;

  const sqlSelect = 'SELECT * FROM post_commit_operations WHERE event_key = $1';
  return client
    ? (await client.query(sqlSelect, [eventKeyNormalizzato])).rows[0] || null
    : await pg.queryOne(sqlSelect, [eventKeyNormalizzato]);
}

async function getPostCommitOperationByEventKey(eventKey, client = null) {
  await initDatabase();
  if (!eventKey || typeof eventKey !== 'string' || !eventKey.trim()) return null;
  const eventKeyNormalizzato = eventKey.trim();
  const sql = 'SELECT * FROM post_commit_operations WHERE event_key = $1';
  return client
    ? (await client.query(sql, [eventKeyNormalizzato])).rows[0] || null
    : await pg.queryOne(sql, [eventKeyNormalizzato]);
}

async function markPostCommitOperationInProgress(eventKey, client = null) {
  await initDatabase();
  if (!eventKey || typeof eventKey !== 'string' || !eventKey.trim()) return null;
  const eventKeyNormalizzato = eventKey.trim();
  const sql = `UPDATE post_commit_operations
    SET status = 'IN_PROGRESS',
        attempts = attempts + 1,
        started_at = NOW(),
        last_error = NULL,
        updated_at = NOW()
    WHERE event_key = $1
      AND status IN ('PENDING','FAILED')
    RETURNING *`;
  return client
    ? (await client.query(sql, [eventKeyNormalizzato])).rows[0] || null
    : await pg.queryOne(sql, [eventKeyNormalizzato]);
}

async function markPostCommitOperationCompleted(eventKey, client = null) {
  await initDatabase();
  if (!eventKey || typeof eventKey !== 'string' || !eventKey.trim()) return null;
  const eventKeyNormalizzato = eventKey.trim();
  const sql = `UPDATE post_commit_operations
    SET status = 'COMPLETED',
        completed_at = NOW(),
        updated_at = NOW(),
        last_error = NULL
    WHERE event_key = $1
    RETURNING *`;
  return client
    ? (await client.query(sql, [eventKeyNormalizzato])).rows[0] || null
    : await pg.queryOne(sql, [eventKeyNormalizzato]);
}

async function markPostCommitOperationFailed(eventKey, errorMessage, client = null) {
  await initDatabase();
  if (!eventKey || typeof eventKey !== 'string' || !eventKey.trim()) return null;
  const eventKeyNormalizzato = eventKey.trim();
  const sql = `UPDATE post_commit_operations
    SET status = 'FAILED',
        last_error = $2,
        updated_at = NOW()
    WHERE event_key = $1
    RETURNING *`;
  return client
    ? (await client.query(sql, [eventKeyNormalizzato, errorMessage])).rows[0] || null
    : await pg.queryOne(sql, [eventKeyNormalizzato, errorMessage]);
}

async function listRecoverablePostCommitOperations(limit = 100, client = null) {
  await initDatabase();
  let limitValue = Number(limit);
  if (!Number.isFinite(limitValue)) {
    limitValue = 100;
  }
  limitValue = Math.min(500, Math.max(1, Math.floor(limitValue)));
  const sql = `SELECT *
    FROM post_commit_operations
    WHERE status IN ('PENDING','FAILED')
    ORDER BY created_at ASC, id ASC
    LIMIT $1`;
  return client
    ? (await client.query(sql, [limitValue])).rows
    : await pg.queryMany(sql, [limitValue]);
}

async function getAccount(wallet, client = null) {
  if (!client) await initDatabase();
  const w = String(wallet || '').trim().toLowerCase();
  const sql = `SELECT * FROM accounts
    WHERE LOWER(wallet) = $1
    ORDER BY CASE tipo WHEN 'FONDO' THEN 0 WHEN 'PRIMARIO' THEN 1 ELSE 2 END, id ASC
    LIMIT 1`;
  if (client) return (await client.query(sql, [w])).rows[0] || null;
  return await pg.queryOne(sql, [w]);
}

async function getAccountsByWallet(wallet, client = null) {
  if (!client) await initDatabase();
  const w = String(wallet || '').trim().toLowerCase();
  const sql = 'SELECT * FROM accounts WHERE LOWER(wallet) = $1 ORDER BY id ASC';
  if (client) return (await client.query(sql, [w])).rows;
  return await pg.queryMany(sql, [w]);
}

async function getAccountById(accountId, client = null) {
  if (!client) await initDatabase();
  const id = Number(accountId);
  if (!Number.isInteger(id) || id < 1) return null;
  const sql = 'SELECT * FROM accounts WHERE id = $1 LIMIT 1';
  if (client) return (await client.query(sql, [id])).rows[0] || null;
  return await pg.queryOne(sql, [id]);
}

async function getAccountByKey(accountKey, client = null) {
  if (!client) await initDatabase();
  const key = String(accountKey || '').trim();
  if (!key) return null;
  const sql = 'SELECT * FROM accounts WHERE account_key = $1 LIMIT 1';
  if (client) return (await client.query(sql, [key])).rows[0] || null;
  return await pg.queryOne(sql, [key]);
}

async function getAccountByIdentity({ accountId = null, wallet = null, sigla = null, tipo = null } = {}, client = null) {
  let account = null;
  if (accountId != null) account = await getAccountById(accountId, client);
  else if (wallet && sigla) {
    if (!client) await initDatabase();
    const params = [String(wallet).toLowerCase(), String(sigla)];
    let sql = 'SELECT * FROM accounts WHERE LOWER(wallet) = $1 AND sigla = $2';
    if (tipo) { sql += ' AND tipo = $3'; params.push(tipo); }
    sql += ' ORDER BY id ASC LIMIT 1';
    account = client ? (await client.query(sql, params)).rows[0] || null : await pg.queryOne(sql, params);
  } else if (wallet) account = await getAccount(wallet, client);
  if (!account) return null;
  if (wallet && String(account.wallet).toLowerCase() !== String(wallet).toLowerCase()) return null;
  if (sigla && String(account.sigla || '') !== String(sigla)) return null;
  if (tipo && account.tipo !== tipo) return null;
  return account;
}

async function updateAccountIdentity(accountId, { sigla = undefined, rootAccountId = undefined } = {}, client = null) {
  if (!client) await initDatabase();
  const id = Number(accountId);
  if (!Number.isInteger(id) || id < 1) throw new Error('accountId non valido');
  const sql = `UPDATE accounts SET
      sigla = CASE WHEN $2::boolean THEN $3 ELSE sigla END,
      root_account_id = CASE WHEN $4::boolean THEN $5 ELSE root_account_id END
    WHERE id = $1 RETURNING *`;
  const params = [id, sigla !== undefined, sigla === undefined ? null : sigla, rootAccountId !== undefined, rootAccountId === undefined ? null : rootAccountId];
  if (client) return (await client.query(sql, params)).rows[0] || null;
  return await pg.queryOne(sql, params);
}

/**
 * Restituisce true se il numero ticket è pre-riservato per un Gemello (reg.10).
 * Formula: 26, 40, 54, 68... = 26 + n×14  (n = 0, 1, 2, ...)
 */
function isTicketGemello(n) {
  return n >= 26 && (n - 26) % 14 === 0;
}

const TICKET_ADVISORY_LOCK_KEY = 42801;

async function lockTicketAllocation(client) {
  await client.query('SELECT pg_advisory_xact_lock($1) AS locked', [TICKET_ADVISORY_LOCK_KEY]);
}

async function getAccountForUpdate(client, wallet) {
  return await client.query(
    'SELECT * FROM accounts WHERE wallet = $1 FOR UPDATE',
    [wallet.toLowerCase()]
  );
}

async function getExistingTicketForUpdate(client, wallet) {
  const res = await getAccountForUpdate(client, wallet);
  return res.rows[0] || null;
}

async function findNextOrdinaryTicket(client) {
  const res = await client.query(
    `WITH RECURSIVE candidates(n) AS (
       SELECT 1

       UNION ALL

       SELECT n + 1
       FROM candidates
       WHERE EXISTS (
         SELECT 1
         FROM accounts
         WHERE ticket_number = n
       )
       OR (
         n >= 26
         AND (n - 26) % 14 = 0
       )
       OR EXISTS (
         SELECT 1
         FROM prenotazioni_funzioni pf
         WHERE pf.ticket_number = n
           AND pf.stato IN ('RESERVED','MATERIALIZED')
       )
       OR EXISTS (
         SELECT 1
         FROM funzioni f
         WHERE f.ticket_prenotato = n
           AND f.status IN ('RILASCIATO','POSIZIONATO')
       )
     )
     SELECT n
     FROM candidates
     WHERE NOT EXISTS (
       SELECT 1
       FROM accounts
       WHERE ticket_number = n
     )
       AND NOT (
         n >= 26
         AND (n - 26) % 14 = 0
       )
       AND NOT EXISTS (
         SELECT 1
         FROM prenotazioni_funzioni pf
         WHERE pf.ticket_number = n
           AND pf.stato IN ('RESERVED','MATERIALIZED')
       )
       AND NOT EXISTS (
         SELECT 1
         FROM funzioni f
         WHERE f.ticket_prenotato = n
           AND f.status IN ('RILASCIATO','POSIZIONATO')
       )
     ORDER BY n
     LIMIT 1`
  );

  return res.rows[0]?.n ?? null;
}

async function findNextGemelloTicket(client) {
  const res = await client.query(
    `WITH RECURSIVE candidates(n) AS (
       SELECT 26

       UNION ALL

       SELECT n + 14
       FROM candidates
       WHERE EXISTS (
         SELECT 1
         FROM accounts
         WHERE ticket_number = n
       )
     )
     SELECT n
     FROM candidates
     WHERE NOT EXISTS (
       SELECT 1
       FROM accounts
       WHERE ticket_number = n
     )
     ORDER BY n
     LIMIT 1`
  );

  return res.rows[0]?.n ?? null;
}

/**
 * Assegna il prossimo ticket disponibile all'account, SALTANDO
 * i numeri pre-riservati ai Gemelli (26, 40, 54... = 26 + n×14).
 *
 * Questi slot sono tenuti liberi dal sistema fin dall'inizio (reg.10)
 * in modo che il ticket di ogni Gemello sia prenotato ancor prima
 * che l'Account si iscriva.
 */
async function assignTicketToAccountId(accountId, client = null) {
  if (!client) await initDatabase();
  const id = Number(accountId);
  if (!Number.isInteger(id) || id < 1) throw new Error('accountId non valido');
  const shouldManageTx = !client;
  const dbClient = shouldManageTx ? await pg.getClient() : client;
  try {
    if (shouldManageTx) await dbClient.query('BEGIN');
    await lockTicketAllocation(dbClient);
    const existingRes = await dbClient.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [id]);
    const existing = existingRes.rows[0];
    if (!existing) throw new Error(`Account ${id} non trovato`);
    if (existing.ticket_number) {
      if (shouldManageTx) await dbClient.query('COMMIT');
      return existing;
    }
    const candidate = await findNextOrdinaryTicket(dbClient);
    if (!candidate) throw new Error('Nessun ticket ordinario disponibile');
    const updated = await dbClient.query(
      'UPDATE accounts SET ticket_number = $1, status = $2 WHERE id = $3 RETURNING *',
      [candidate, 'IN_CODA', id]
    );
    if (shouldManageTx) await dbClient.query('COMMIT');
    return updated.rows[0] || null;
  } catch (err) {
    if (shouldManageTx) { try { await dbClient.query('ROLLBACK'); } catch (_) {} }
    throw err;
  } finally { if (shouldManageTx) dbClient.release(); }
}

async function assignNextGemelloTicketToAccountId(accountId, client = null) {
  if (!client) await initDatabase();
  const id = Number(accountId);
  if (!Number.isInteger(id) || id < 1) throw new Error('accountId non valido');
  const shouldManageTx = !client;
  const dbClient = shouldManageTx ? await pg.getClient() : client;
  try {
    if (shouldManageTx) await dbClient.query('BEGIN');
    await lockTicketAllocation(dbClient);
    const existingRes = await dbClient.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [id]);
    const existing = existingRes.rows[0];
    if (!existing) throw new Error(`Account ${id} non trovato`);
    if (existing.ticket_number) {
      if (shouldManageTx) await dbClient.query('COMMIT');
      return existing;
    }
    const candidate = await findNextGemelloTicket(dbClient);
    if (!candidate) throw new Error('Nessun ticket Gemello disponibile');
    const occupato = await dbClient.query('SELECT id FROM accounts WHERE ticket_number = $1 FOR UPDATE', [candidate]);
    if (occupato.rows.length) throw new Error(`Ticket Gemello ${candidate} gia occupato`);
    const updated = await dbClient.query(
      'UPDATE accounts SET ticket_number = $1, status = $2 WHERE id = $3 RETURNING *',
      [candidate, 'IN_CODA', id]
    );
    if (shouldManageTx) await dbClient.query('COMMIT');
    return updated.rows[0] || null;
  } catch (err) {
    if (shouldManageTx) { try { await dbClient.query('ROLLBACK'); } catch (_) {} }
    throw err;
  } finally { if (shouldManageTx) dbClient.release(); }
}

async function assignTicket(wallet, client = null) {
  const account = await getAccount(wallet, client);
  if (!account) throw new Error(`Account ${String(wallet).toLowerCase()} non trovato`);
  return await assignTicketToAccountId(account.id, client);
}


/**
 * Assegna un numero di ticket SPECIFICO (pre-riservato) a un account.
 * Usato esclusivamente per i Gemelli che hanno il ticket prenotato (reg.10).
 *
 * @param {string} wallet
 * @param {number} ticketNumber  - Il numero esatto da assegnare (26, 40, 54...)
 */
async function assignSpecificTicket(wallet, ticketNumber) {
  await initDatabase();
  const w = wallet.toLowerCase();
  const requestedTicket = Number(ticketNumber);

  if (!Number.isInteger(requestedTicket) || requestedTicket <= 0) {
    throw new Error(`Numero ticket non valido: ${ticketNumber}`);
  }

  const client = await pg.getClient();

  try {
    await client.query('BEGIN');
    await lockTicketAllocation(client);

    const existing = await getExistingTicketForUpdate(client, w);

    if (!existing) {
      throw new Error(`Account ${w} non trovato`);
    }

    if (
      existing.ticket_number !== null &&
      existing.ticket_number !== undefined
    ) {
      const currentTicket = Number(existing.ticket_number);

      if (currentTicket === requestedTicket) {
        await client.query('COMMIT');
        return existing;
      }

      throw new Error(
        `Account ${w} possiede già il ticket ${currentTicket}; impossibile assegnare il ticket ${requestedTicket}`
      );
    }

    const occupato = await client.query(
      `SELECT id, wallet
       FROM accounts
       WHERE ticket_number = $1
       FOR UPDATE`,
      [requestedTicket]
    );

    if (occupato.rows.length > 0) {
      throw new Error(
        `Ticket ${requestedTicket} già occupato dall’account ${occupato.rows[0].wallet}`
      );
    }

    const updated = await client.query(
      `UPDATE accounts
       SET ticket_number = $1,
           status = $2
       WHERE wallet = $3
         AND ticket_number IS NULL
       RETURNING *`,
      [requestedTicket, 'IN_CODA', w]
    );

    if (updated.rows.length !== 1) {
      throw new Error(
        `Assegnazione del ticket ${requestedTicket} non completata per l’account ${w}`
      );
    }

    await client.query('COMMIT');
    return updated.rows[0];
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Nessuna azione aggiuntiva.
    }

    throw err;
  } finally {
    client.release();
  }
}

async function getAccountByTicket(ticketNumber) {
  await initDatabase();
  return await pg.queryOne('SELECT * FROM accounts WHERE ticket_number = $1', [ticketNumber]);
}

// ========================================
// TAVOLE
// ========================================

async function getNextTavolaNumero(client = null, sezione = null) {
  if (!client) {
    await initDatabase();
  }
  const sezioneNormalizzata = String(sezione || '').trim().toUpperCase();
  if (!['ENTRATA', 'PHARAOH'].includes(sezioneNormalizzata)) {
    throw new Error('Sezione obbligatoria per la numerazione tavole: ENTRATA o PHARAOH');
  }

  const sql = `INSERT INTO contatori_tavole (sezione, ultimo_numero)
     VALUES (
       $1,
       COALESCE((SELECT MAX(numero) FROM tavole WHERE sezione = $1), 0) + 1
     )
     ON CONFLICT (sezione) DO UPDATE
     SET ultimo_numero = GREATEST(
           contatori_tavole.ultimo_numero,
           EXCLUDED.ultimo_numero - 1
         ) + 1,
         updated_at = NOW()
     RETURNING ultimo_numero AS next_num`;
  const params = [sezioneNormalizzata];
  const row = client
    ? (await client.query(sql, params)).rows[0] || null
    : await pg.queryOne(sql, params);
  const nextNumero = Number(row?.next_num);
  if (!Number.isInteger(nextNumero) || nextNumero < 1) {
    throw new Error(`Numeratore tavole ${sezioneNormalizzata} non disponibile`);
  }
  return nextNumero;
}

async function createTavola({ numero, sezione, livello, blocco = null, tipo = 'PERCORSO', capacita, faraoneWallet, faraoneAccountId = null, faraoneSigla = null, turno = 1 }, client = null) {
  if (!client) {
    await initDatabase();
  }
  if (client) {
    const result = await client.query(
      `INSERT INTO tavole (numero, sezione, livello, blocco, tipo, capacita, faraone_wallet, faraone_account_id, faraone_sigla, turno)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [numero, sezione, livello, blocco, tipo, capacita, faraoneWallet ? faraoneWallet.toLowerCase() : null, faraoneAccountId, faraoneSigla, turno]
    );
    return result.rows[0] || null;
  }
  return await pg.queryOne(
    `INSERT INTO tavole (numero, sezione, livello, blocco, tipo, capacita, faraone_wallet, faraone_account_id, faraone_sigla, turno)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [numero, sezione, livello, blocco, tipo, capacita, faraoneWallet ? faraoneWallet.toLowerCase() : null, faraoneAccountId, faraoneSigla, turno]
  );
}

async function getTavola(numero, sezione = null) {
  await initDatabase();
  if (sezione) {
    return await pg.queryOne(
      'SELECT * FROM tavole WHERE sezione = $1 AND numero = $2',
      [sezione, numero]
    );
  }
  return await pg.queryOne(
    `SELECT * FROM tavole WHERE numero = $1
     ORDER BY CASE WHEN sezione = 'PHARAOH' THEN 0 ELSE 1 END
     LIMIT 1`,
    [numero]
  );
}

async function getTavolaById(id) {
  await initDatabase();
  return await pg.queryOne('SELECT * FROM tavole WHERE id = $1', [id]);
}

async function updateTavolaStatus(numero, status, client = null, sezione = null) {
  if (!client) {
    await initDatabase();
  }
  const sql = sezione
    ? 'UPDATE tavole SET status = $1 WHERE numero = $2 AND sezione = $3 RETURNING *'
    : 'UPDATE tavole SET status = $1 WHERE numero = $2 RETURNING *';
  const params = sezione ? [status, numero, sezione] : [status, numero];
  if (client) {
    const result = await client.query(
      sql,
      params
    );
    return result.rows[0] || null;
  }
  return await pg.queryOne(
    sql,
    params
  );
}

async function updateTavolaDoni(numero, importo, client = null, sezione = null) {
  if (!client) {
    await initDatabase();
  }
  const sql = sezione
    ? 'UPDATE tavole SET doni_ricevuti = doni_ricevuti + $1 WHERE numero = $2 AND sezione = $3 RETURNING *'
    : 'UPDATE tavole SET doni_ricevuti = doni_ricevuti + $1 WHERE numero = $2 RETURNING *';
  const params = sezione ? [importo, numero, sezione] : [importo, numero];
  if (client) {
    const result = await client.query(
      sql,
      params
    );
    return result.rows[0] || null;
  }
  return await pg.queryOne(
    sql,
    params
  );
}

async function countPosizioniInTavola(tavolaId, client = null) {
  if (!client) {
    await initDatabase();
  }
  const row = client
    ? (await client.query(
      'SELECT COUNT(*) AS cnt FROM posizioni WHERE tavola_id = $1 AND tipo != $2',
      [tavolaId, 'EREDE']
    )).rows[0] || null
    : await pg.queryOne(
      'SELECT COUNT(*) AS cnt FROM posizioni WHERE tavola_id = $1 AND tipo != $2',
      [tavolaId, 'EREDE']
    );
  return Number(row?.cnt) || 0;
}

// ========================================
// POSIZIONI
// ========================================

async function createPosizione({ tavolaId, casella, wallet, nome, tipo, donoImporto = 0, accountId = null, accountSigla = null }, client = null) {
  if (!client) {
    await initDatabase();
  }
  if (client) {
    const result = await client.query(
      `INSERT INTO posizioni (tavola_id, casella, wallet, nome, tipo, dono_importo, account_id, account_sigla)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tavolaId, casella, wallet.toLowerCase(), nome, tipo, donoImporto, accountId, accountSigla]
    );
    return result.rows[0] || null;
  }
  return await pg.queryOne(
    `INSERT INTO posizioni (tavola_id, casella, wallet, nome, tipo, dono_importo, account_id, account_sigla)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [tavolaId, casella, wallet.toLowerCase(), nome, tipo, donoImporto, accountId, accountSigla]
  );
}

async function getPosizioniTavola(tavolaId, client = null) {
  if (!client) await initDatabase();
  const sql = 'SELECT * FROM posizioni WHERE tavola_id = $1 ORDER BY casella ASC';
  const params = [tavolaId];
  return client ? (await client.query(sql, params)).rows : await pg.queryMany(sql, params);
}

async function updatePosizioneSdoppiamento(posizioneId, sdoppiamentoTavolaId, client = null) {
  if (!client) {
    await initDatabase();
  }
  if (client) {
    const result = await client.query(
      'UPDATE posizioni SET sdoppiamento_tavola_id = $1 WHERE id = $2 RETURNING *',
      [sdoppiamentoTavolaId, posizioneId]
    );
    return result.rows[0] || null;
  }
  return await pg.queryOne(
    'UPDATE posizioni SET sdoppiamento_tavola_id = $1 WHERE id = $2 RETURNING *',
    [sdoppiamentoTavolaId, posizioneId]
  );
}

/**
 * Restituisce le caselle del livello Entrata riservate/materializzate per Funzioni.
 * La protezione e fail-closed: una posizione ordinaria o di riporto non puo consumarle.
 */
async function getEntryReservedSlots({ turnoNumero, tavolaNumero, tavolaRelativa = 1 }, client = null) {
  if (!client) await initDatabase();
  const sql = `SELECT DISTINCT casella
     FROM prenotazioni_funzioni
     WHERE turno_destinazione = $1
       AND livello_destinazione = 0
       AND stato IN ('RESERVED','MATERIALIZED')
       AND (
         tavola_numero = $2
         OR (tavola_numero IS NULL AND tavola_relativa = $3)
       )
     ORDER BY casella ASC`;
  const params = [Number(turnoNumero), Number(tavolaNumero), Number(tavolaRelativa)];
  const rows = client ? (await client.query(sql, params)).rows : await pg.queryMany(sql, params);
  return rows.map(row => Number(row.casella)).filter(Number.isInteger);
}

async function getEntryRolloverBySourceTable(sourceTavolaId, client = null) {
  if (!client) await initDatabase();
  const sql = 'SELECT * FROM entry_rollovers WHERE source_tavola_id = $1 LIMIT 1';
  const params = [Number(sourceTavolaId)];
  return client ? (await client.query(sql, params)).rows[0] || null : await pg.queryOne(sql, params);
}

async function createEntryRolloverAudit({
  eventKey,
  sourceTavolaId,
  sourceTavolaNumero,
  targetTavolaId,
  targetTavolaNumero,
  targetTurno,
  cassaWallet,
  amountUsdc,
  targetCasella,
  posizioneId
}, client = null) {
  if (!client) await initDatabase();
  const sql = `INSERT INTO entry_rollovers (
      event_key, source_tavola_id, source_tavola_numero,
      target_tavola_id, target_tavola_numero, target_turno,
      cassa_wallet, amount_usdc, target_casella, posizione_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (source_tavola_id) DO NOTHING
    RETURNING *`;
  const params = [
    eventKey, Number(sourceTavolaId), Number(sourceTavolaNumero),
    Number(targetTavolaId), Number(targetTavolaNumero), Number(targetTurno),
    String(cassaWallet).toLowerCase(), Number(amountUsdc), Number(targetCasella), Number(posizioneId)
  ];
  const inserted = client ? (await client.query(sql, params)).rows[0] || null : await pg.queryOne(sql, params);
  if (inserted) return inserted;
  return await getEntryRolloverBySourceTable(sourceTavolaId, client);
}

// ========================================
// TURNI
// ========================================

async function createTurno({ sezione, livello, blocco, numeroTurno, faraoneWallet, faraoneTipo = 'PRIMARIO', faraoneAccountId = null, faraoneSigla = null, tavolaFaraoneNum = null, sacerdotiNecessari }, client = null) {
  if (!client) {
    await initDatabase();
  }
  const sql = `INSERT INTO turni (sezione, livello, blocco, numero_turno, faraone_wallet, faraone_tipo, faraone_account_id, faraone_sigla, tavola_faraone_num, sacerdoti_necessari)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`;
  const params = [sezione, livello, blocco, numeroTurno, faraoneWallet.toLowerCase(), faraoneTipo, faraoneAccountId, faraoneSigla, tavolaFaraoneNum, sacerdotiNecessari];
  if (client) {
    const result = await client.query(sql, params);
    return result.rows[0] || null;
  }
  return await pg.queryOne(sql, params);
}

async function getTurnoCorrente(sezione, livello, client = null) {
  if (!client) {
    await initDatabase();
  }
  if (client) {
    const result = await client.query(
      `SELECT * FROM turni WHERE sezione = $1 AND livello = $2 AND status = 'IN_CORSO' ORDER BY numero_turno DESC LIMIT 1`,
      [sezione, livello]
    );
    return result.rows[0] || null;
  }
  return await pg.queryOne(
    `SELECT * FROM turni WHERE sezione = $1 AND livello = $2 AND status = 'IN_CORSO' ORDER BY numero_turno DESC LIMIT 1`,
    [sezione, livello]
  );
}

async function incrementSacerdotiEntrati(turnoId, client = null) {
  if (!client) {
    await initDatabase();
  }
  if (client) {
    const result = await client.query(
      `UPDATE turni SET sacerdoti_entrati = sacerdoti_entrati + 1 WHERE id = $1 RETURNING *`,
      [turnoId]
    );
    return result.rows[0] || null;
  }
  return await pg.queryOne(
    `UPDATE turni SET sacerdoti_entrati = sacerdoti_entrati + 1 WHERE id = $1 RETURNING *`,
    [turnoId]
  );
}

async function incrementTavolaCreate(turnoId) {
  await initDatabase();
  return await pg.queryOne(
    'UPDATE turni SET tavole_create = tavole_create + 1 WHERE id = $1 RETURNING *',
    [turnoId]
  );
}

async function completaTurno(turnoId, doniTotali, client = null) {
  if (!client) {
    await initDatabase();
  }
  const sql = `UPDATE turni SET status = 'COMPLETATO', doni_totali = $1 WHERE id = $2 RETURNING *`;
  const params = [doniTotali, turnoId];
  if (client) {
    const result = await client.query(sql, params);
    return result.rows[0] || null;
  }
  return await pg.queryOne(sql, params);
}

// ========================================
// CONTENITORI
// ========================================

async function addToContenitore({ tipo, wallet, ticketNumber, nome, importo, provenienza, accountId = null, accountSigla = null }, client = null) {
  if (!client) await initDatabase();
  const sql = `INSERT INTO contenitori (tipo, wallet, ticket_number, nome, importo_disponibile, provenienza, account_id, account_sigla)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`;
  const params = [tipo, wallet.toLowerCase(), ticketNumber, nome, importo, provenienza, accountId, accountSigla];
  if (client) {
    const result = await client.query(sql, params);
    return result.rows[0] || null;
  }
  return await pg.queryOne(sql, params);
}

async function getNextFromContenitore(tipo, client = null) {
  if (!client) await initDatabase();
  const sql = `SELECT * FROM contenitori
     WHERE tipo = $1 AND status = 'IN_ATTESA'
     ORDER BY ticket_number ASC NULLS LAST, id ASC
     LIMIT 1`;
  if (client) {
    const result = await client.query(sql, [tipo]);
    return result.rows[0] || null;
  }
  return await pg.queryOne(sql, [tipo]);
}

async function markContenitoreUsato(id, client = null) {
  if (!client) await initDatabase();
  const sql = `UPDATE contenitori SET status = 'USATO'
     WHERE id = $1
     RETURNING *`;
  if (client) {
    const result = await client.query(sql, [id]);
    return result.rows[0] || null;
  }
  return await pg.queryOne(sql, [id]);
}

async function countInContenitore(tipo, client = null) {
  if (!client) await initDatabase();
  const sql = `SELECT COUNT(*) AS cnt FROM contenitori WHERE tipo = $1 AND status = 'IN_ATTESA'`;
  const row = client
    ? (await client.query(sql, [tipo])).rows[0]
    : await pg.queryOne(sql, [tipo]);
  return Number(row?.cnt) || 0;
}

// ========================================
// FUNZIONI
// ========================================

async function createFunzione({ tipo, accountOrigineWallet, accountGeneratoWallet, accountOrigineId = null, accountGeneratoId = null, sigla, ticketPrenotato, importo, turnoRilascio, turnoEntrata, tavolaPosizionamento, posizioneInTavola }, client = null) {
  if (!client) {
    await initDatabase();
  }
  const sql = `INSERT INTO funzioni (tipo, account_origine_wallet, account_generato_wallet, account_origine_id, account_generato_id, sigla, ticket_prenotato, importo, turno_rilascio, turno_entrata, tavola_posizionamento, posizione_in_tavola)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`;
  const params = [tipo, accountOrigineWallet.toLowerCase(), accountGeneratoWallet ? accountGeneratoWallet.toLowerCase() : null, accountOrigineId, accountGeneratoId, sigla, ticketPrenotato, importo, turnoRilascio, turnoEntrata ?? null, tavolaPosizionamento, posizioneInTavola];
  if (client) {
    const result = await client.query(sql, params);
    return result.rows[0] || null;
  }
  return await pg.queryOne(sql, params);
}

async function createIdentitaFunzione({
  identityKey,
  walletProprietario,
  accountOrigineWallet,
  tipo,
  sigla,
  progressivo
}, client = null) {
  if (!client) {
    await initDatabase();
  }
  if (typeof identityKey !== 'string' || !identityKey.trim()) {
    throw new Error('identityKey non valida');
  }

  if (typeof walletProprietario !== 'string' || !walletProprietario.trim()) {
    throw new Error('walletProprietario non valido');
  }

  if (typeof accountOrigineWallet !== 'string' || !accountOrigineWallet.trim()) {
    throw new Error('accountOrigineWallet non valido');
  }

  if (!['PERPETUO', 'GEMELLO', 'SIMBIONTE'].includes(tipo)) {
    throw new Error('tipo identità non valido');
  }

  if (typeof sigla !== 'string' || !sigla.trim()) {
    throw new Error('sigla non valida');
  }

  let progressivoNormalizzato;

  try {
    if (
      typeof progressivo !== 'number' &&
      typeof progressivo !== 'string' &&
      typeof progressivo !== 'bigint'
    ) {
      throw new Error();
    }
    if (
      typeof progressivo === 'number' &&
      !Number.isSafeInteger(progressivo)
    ) {
      throw new Error();
    }

    if (
      typeof progressivo === 'string' &&
      !/^[1-9]\d*$/.test(progressivo.trim())
    ) {
      throw new Error();
    }

    progressivoNormalizzato = BigInt(progressivo);

    if (progressivoNormalizzato <= 0n) {
      throw new Error();
    }
  } catch {
    throw new Error('progressivo non valido');
  }

  const progressivoDb = progressivoNormalizzato.toString();
  const dbClient = client || await pg.getClient();
  const shouldManageTx = !client;
  try {
    if (shouldManageTx) {
      await dbClient.query('BEGIN');
    }
    await dbClient.query(
      'SELECT pg_advisory_xact_lock($1)',
      [42802]
    );
    const existingProgressivo = await dbClient.query(
      `SELECT *
       FROM identita_funzioni
       WHERE wallet_proprietario = $1
         AND tipo = $2
         AND progressivo = $3`,
      [walletProprietario.toLowerCase(), tipo, progressivoDb]
    );
    const existingProgressivoRow = existingProgressivo.rows[0];

    if (existingProgressivoRow) {
      const sameProgressivoMatch =
        existingProgressivoRow.identity_key === identityKey &&
        existingProgressivoRow.account_origine_wallet ===
          accountOrigineWallet.toLowerCase() &&
        existingProgressivoRow.sigla === sigla;

      if (sameProgressivoMatch) {
        if (shouldManageTx) {
          await dbClient.query('COMMIT');
        }
        return existingProgressivoRow;
      }

      throw new Error(
        'Progressivo già assegnato a un’altra identità funzionale per questo wallet e tipo'
      );
    }

    const inserted = await dbClient.query(
      `INSERT INTO identita_funzioni (
        identity_key,
        wallet_proprietario,
        account_origine_wallet,
        tipo,
        sigla,
        progressivo
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (identity_key) DO NOTHING
      RETURNING *`,
      [
        identityKey,
        walletProprietario.toLowerCase(),
        accountOrigineWallet.toLowerCase(),
        tipo,
        sigla,
        progressivoDb
      ]
    );
    const insertedRow = inserted.rows[0];

    if (insertedRow) {
      if (shouldManageTx) {
        await dbClient.query('COMMIT');
      }
      return insertedRow;
    }
    const existing = await dbClient.query(
      `SELECT *
       FROM identita_funzioni
       WHERE identity_key = $1`,
      [identityKey]
    );
    const existingRow = existing.rows[0];

    const sameMatch = existingRow
      && existingRow.wallet_proprietario === walletProprietario.toLowerCase()
      && existingRow.account_origine_wallet === accountOrigineWallet.toLowerCase()
      && existingRow.tipo === tipo
      && existingRow.sigla === sigla
      && String(existingRow.progressivo) === progressivoDb;

    if (sameMatch) {
      if (shouldManageTx) {
        await dbClient.query('COMMIT');
      }
      return existingRow;
    }

    throw new Error('identity_key già usata con dati differenti');
  } catch (error) {
    if (shouldManageTx) {
      await dbClient.query('ROLLBACK');
    }
    throw error;
  } finally {
    if (shouldManageTx) {
      dbClient.release();
    }
  }
}

async function getIdentitaFunzioneByKey(identityKey) {
  await initDatabase();
  if (typeof identityKey !== 'string' || !identityKey.trim()) {
    throw new Error('identityKey non valida');
  }

  return await pg.queryOne(
    `SELECT *
     FROM identita_funzioni
     WHERE identity_key = $1`,
    [identityKey]
  );
}

async function getIdentitaFunzioniByWallet(walletProprietario) {
  await initDatabase();
  if (
    typeof walletProprietario !== 'string' ||
    !walletProprietario.trim()
  ) {
    throw new Error('walletProprietario non valido');
  }

  return await pg.queryMany(
    `SELECT *
     FROM identita_funzioni
     WHERE wallet_proprietario = $1
     ORDER BY tipo, progressivo`,
    [walletProprietario.toLowerCase()]
  );
}

async function updateIdentitaFunzioneStatus(identityKey, nuovoStatus) {
  await initDatabase();
  if (typeof identityKey !== 'string' || !identityKey.trim()) {
    throw new Error('identityKey non valida');
  }

  if (!['ATTIVA', 'SOSPESA', 'CHIUSA'].includes(nuovoStatus)) {
    throw new Error('status identità non valido');
  }

  const updated = await pg.queryOne(
    `UPDATE identita_funzioni
     SET status = $2
     WHERE identity_key = $1
     RETURNING *`,
    [identityKey, nuovoStatus]
  );

  if (!updated) {
    throw new Error('identità funzionale non trovata');
  }

  return updated;
}

async function getIdentitaFunzioniByTipo(tipo) {
  await initDatabase();

  if (!['PERPETUO', 'GEMELLO', 'SIMBIONTE'].includes(tipo)) {
    throw new Error('tipo identità non valido');
  }

  return await pg.queryMany(
    `SELECT *
     FROM identita_funzioni
     WHERE tipo = $1
     ORDER BY progressivo`,
    [tipo]
  );
}

async function createPrenotazioneFunzione({
  eventKey,
  funzioneId = null,
  tipoFunzione,
  accountOrigineWallet,
  accountDestinazioneWallet = null,
  accountOrigineId = null,
  accountDestinazioneId = null,
  turnoOrigine,
  turnoDestinazione,
  livelloDestinazione,
  bloccoDestinazione = null,
  tavolaRelativa,
  tavolaNumero = null,
  casella,
  ticketNumber = null
}, client = null) {
  if (!client) {
    await initDatabase();
  }
  const sql = `INSERT INTO prenotazioni_funzioni (
      event_key,
      funzione_id,
      tipo_funzione,
      account_origine_wallet,
      account_destinazione_wallet,
      account_origine_id,
      account_destinazione_id,
      turno_origine,
      turno_destinazione,
      livello_destinazione,
      blocco_destinazione,
      tavola_relativa,
      tavola_numero,
      casella,
      ticket_number
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (event_key) DO NOTHING
    RETURNING *`;
  const params = [
    eventKey,
    funzioneId,
    tipoFunzione,
    accountOrigineWallet.toLowerCase(),
    accountDestinazioneWallet
      ? accountDestinazioneWallet.toLowerCase()
      : null,
    accountOrigineId,
    accountDestinazioneId,
    turnoOrigine,
    turnoDestinazione,
    livelloDestinazione,
    bloccoDestinazione,
    tavolaRelativa,
    tavolaNumero,
    casella,
    ticketNumber
  ];
  let inserted;
  if (client) {
    const result = await client.query(sql, params);
    inserted = result.rows[0] || null;
  } else {
    inserted = await pg.queryOne(sql, params);
  }

  if (inserted) {
    return inserted;
  }

  const existing = client
    ? (await client.query(
      `SELECT *
     FROM prenotazioni_funzioni
     WHERE event_key = $1`,
      [eventKey]
    )).rows[0] || null
    : await pg.queryOne(
    `SELECT *
     FROM prenotazioni_funzioni
     WHERE event_key = $1`,
    [eventKey]
  );

  if (!existing) {
    throw new Error(`event_key già usato con dati differenti`);
  }

  const sameMatch = existing.tipo_funzione === tipoFunzione
    && Number(existing.turno_destinazione) === Number(turnoDestinazione)
    && Number(existing.livello_destinazione) === Number(livelloDestinazione)
    && Number(existing.tavola_relativa) === Number(tavolaRelativa)
    && Number(existing.casella) === Number(casella)
    && Number(existing.funzione_id) === Number(funzioneId)
    && existing.account_origine_wallet === accountOrigineWallet.toLowerCase()
    && existing.account_destinazione_wallet === (
      accountDestinazioneWallet
        ? accountDestinazioneWallet.toLowerCase()
        : null
    )
    && (
      (existing.tavola_numero === null && tavolaNumero === null)
      || Number(existing.tavola_numero) === Number(tavolaNumero)
    )
    && (
      (existing.ticket_number === null && ticketNumber === null)
      || Number(existing.ticket_number) === Number(ticketNumber)
    )
    && (
      (existing.blocco_destinazione === null && bloccoDestinazione === null)
      || Number(existing.blocco_destinazione) === Number(bloccoDestinazione)
    );

  if (sameMatch) {
    return existing;
  }

  throw new Error(`event_key già usato con dati differenti`);
}

async function getPrenotazioneByEventKey(eventKey) {
  await initDatabase();

  return await pg.queryOne(
    `SELECT *
     FROM prenotazioni_funzioni
     WHERE event_key = $1`,
    [eventKey]
  );
}
async function getPrenotazioniByFunzioneId(funzioneId) {
  await initDatabase();

  return await pg.queryMany(
    `SELECT *
     FROM prenotazioni_funzioni
     WHERE funzione_id = $1
     ORDER BY id ASC`,
    [funzioneId]
  );
}
async function getPrenotazioneById(id) {
  await initDatabase();

  return await pg.queryOne(
    `SELECT *
     FROM prenotazioni_funzioni
     WHERE id = $1`,
    [id]
  );
}
async function getPrenotazioneByPosizione({
  turnoDestinazione,
  livelloDestinazione,
  bloccoDestinazione = null,
  tavolaRelativa,
  casella
}, client = null) {
  if (!client) {
    await initDatabase();
  }
  const sql = `SELECT *
     FROM prenotazioni_funzioni
     WHERE turno_destinazione = $1
       AND livello_destinazione = $2
       AND COALESCE(blocco_destinazione, 0) = COALESCE($3, 0)
       AND tavola_relativa = $4
       AND casella = $5`;
  const params = [
    turnoDestinazione,
    livelloDestinazione,
    bloccoDestinazione,
    tavolaRelativa,
    casella
  ];
  if (client) {
    const result = await client.query(sql, params);
    return result.rows[0] || null;
  }
  return await pg.queryOne(
    `SELECT *
     FROM prenotazioni_funzioni
     WHERE turno_destinazione = $1
       AND livello_destinazione = $2
       AND COALESCE(blocco_destinazione, 0) = COALESCE($3, 0)
       AND tavola_relativa = $4
       AND casella = $5`,
    [
      turnoDestinazione,
      livelloDestinazione,
      bloccoDestinazione,
      tavolaRelativa,
      casella
    ]
  );
}
async function getPrenotazioniRiservate({
  turnoDestinazione,
  livelloDestinazione,
  bloccoDestinazione = null,
  tavolaRelativa
}, client = null) {
  if (!client) {
    await initDatabase();
  }
  const sql = `SELECT *
     FROM prenotazioni_funzioni
     WHERE turno_destinazione = $1
       AND livello_destinazione = $2
       AND COALESCE(blocco_destinazione, 0) = COALESCE($3, 0)
       AND tavola_relativa = $4
       AND stato = 'RESERVED'
     ORDER BY casella ASC`;
  const params = [
    turnoDestinazione,
    livelloDestinazione,
    bloccoDestinazione,
    tavolaRelativa
  ];
  if (client) {
    const result = await client.query(sql, params);
    return result.rows;
  }
  return await pg.queryMany(
    `SELECT *
     FROM prenotazioni_funzioni
     WHERE turno_destinazione = $1
       AND livello_destinazione = $2
       AND COALESCE(blocco_destinazione, 0) = COALESCE($3, 0)
       AND tavola_relativa = $4
       AND stato = 'RESERVED'
     ORDER BY casella ASC`,
    [
      turnoDestinazione,
      livelloDestinazione,
      bloccoDestinazione,
      tavolaRelativa
    ]
  );
}

function isTransizionePrenotazioneValida(statoAttuale, nuovoStato) {
  const transizioni = {
    RESERVED: ['MATERIALIZED', 'CANCELLED', 'ERROR'],
    MATERIALIZED: ['CONSUMED', 'ERROR'],
    CONSUMED: [],
    CANCELLED: [],
    ERROR: []
  };

  return transizioni[statoAttuale]?.includes(nuovoStato) === true;
}

async function updatePrenotazioneFunzione({
  id,
  stato,
  posizioneId = null,
  tavolaNumero = null
}) {
  await initDatabase();
  if (
    stato === 'MATERIALIZED' &&
    (!posizioneId || tavolaNumero === null)
  ) {
    throw new Error(
      'MATERIALIZED richiede posizioneId e tavolaNumero'
    );
  }
  const statiValidi = [
    'RESERVED',
    'MATERIALIZED',
    'CONSUMED',
    'CANCELLED',
    'ERROR'
  ];

  if (!statiValidi.includes(stato)) {
    throw new Error(`Stato prenotazione non valido: ${stato}`);
  }
  const current = await getPrenotazioneById(id);

  if (!current) {
    throw new Error(`Prenotazione ${id} non trovata`);
  }

  if (!isTransizionePrenotazioneValida(current.stato, stato)) {
    throw new Error(
      `Transizione non valida: ${current.stato} → ${stato}`
    );
  }

  const updated = await pg.queryOne(
    `UPDATE prenotazioni_funzioni
     SET stato = $1,
         posizione_id = COALESCE($2, posizione_id),
         tavola_numero = COALESCE($3, tavola_numero),
         materialized_at = CASE
           WHEN $1 = 'MATERIALIZED' THEN NOW()
           ELSE materialized_at
         END,
         updated_at = NOW()
     WHERE id = $4
       AND stato = $5
     RETURNING *`,
    [stato, posizioneId, tavolaNumero, id, current.stato]
  );

  if (!updated) {
    throw new Error(
      `Prenotazione ${id} modificata contemporaneamente`
    );
  }
  return updated;
}

async function getFunzioniByOrigine(wallet, client = null, accountOrigineId = null) {
  const sql = accountOrigineId
    ? 'SELECT * FROM funzioni WHERE account_origine_id = $1 ORDER BY created_at ASC'
    : 'SELECT * FROM funzioni WHERE account_origine_wallet = $1 ORDER BY created_at ASC';
  const params = [accountOrigineId || wallet.toLowerCase()];
  if (client) {
    const result = await client.query(sql, params);
    return result.rows || [];
  }
  await initDatabase();
  return await pg.queryMany(sql, params);
}

async function getFunzioniPendentiPerTurno(turno, tipo = null) {
  await initDatabase();
  const params = [turno];
  let sql = `SELECT * FROM funzioni WHERE turno_entrata = $1 AND status = 'RILASCIATO'`;
  if (tipo) {
    sql += ' AND tipo = $2';
    params.push(tipo);
  }
  sql += ' ORDER BY id ASC';
  return await pg.queryMany(sql, params);
}

// ========================================
// CONTROLLO POSIZIONE ATTIVA
// ========================================

/**
 * Verifica se un wallet ha già una posizione ATTIVA in una tavola APERTA
 * del livello di entrata (livello 0).
 *
 * Usato per garantire: un wallet = una posizione alla volta.
 * L'utente può rientrare solo DOPO che la sua tavola si è chiusa
 * (lui è uscito come erede e la tavola è COMPLETATA).
 *
 * @param {string} wallet
 * @returns {Object|null} La posizione attiva con dettagli tavola, oppure null
 */
async function getPosizioneAttivaEntrata(wallet) {
  await initDatabase();
  return await pg.queryOne(
    `SELECT p.id, p.casella, p.tipo, p.status AS posizione_status,
            t.numero AS tavola_numero, t.status AS tavola_status, t.turno
     FROM posizioni p
     JOIN tavole t ON p.tavola_id = t.id
     WHERE p.wallet  = $1
       AND t.livello = 0
       AND t.status  = 'APERTA'
       AND p.tipo    = 'DONATORE'
       AND p.status  = 'ATTIVO'
     LIMIT 1`,
    [wallet.toLowerCase()]
  );
}

// ========================================
// DONAZIONI
// ========================================

async function createDonazione({
  donorWallet,
  importo,
  txHash,
  tipo = 'DONO',
  destinatarioWallet = null,
  beneficiaryWallet = null,
  sourcePlatform = null,
  sourceEventKey = null,
  positionsCreated = null,
  tavolaId = null,
  livello = null,
  turno = null,
  blockchainProof = null
}, client = null) {
  if (!client) await initDatabase();
  const canonicalTxHash = txHash && /^0x[a-fA-F0-9]{64}$/.test(txHash) ? txHash.toLowerCase() : txHash;
  if (process.env.NODE_ENV === 'production' && tipo === 'DONO' && canonicalTxHash && !blockchainProof) {
    throw new Error('BLOCKCHAIN_PROOF_REQUIRED: impossibile registrare il dono senza prova on-chain');
  }
  const proofJson = blockchainProof ? JSON.stringify(blockchainProof) : null;
  const verifiedAt = blockchainProof?.verifiedAt || new Date().toISOString();
  const sql = `INSERT INTO donazioni
      (donor_wallet, importo, tx_hash, tipo, destinatario_wallet,
       beneficiary_wallet, source_platform, source_event_key, positions_created,
       tavola_id, livello, turno, blockchain_proof, blockchain_verified_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
    RETURNING *`;
  const params = [
    donorWallet.toLowerCase(), importo, canonicalTxHash, tipo,
    destinatarioWallet ? destinatarioWallet.toLowerCase() : null,
    beneficiaryWallet ? beneficiaryWallet.toLowerCase() : null,
    sourcePlatform ? String(sourcePlatform).trim().toUpperCase() : null,
    sourceEventKey ? String(sourceEventKey).trim() : null,
    positionsCreated == null ? null : Number(positionsCreated),
    tavolaId, livello, turno, proofJson, verifiedAt
  ];
  if (client) return (await client.query(sql, params)).rows[0] || null;
  return await pg.queryOne(sql, params);
}

// ========================================
// THOT EXIT ALLOCATIONS
// ========================================

async function createThotExitAllocation({
  eventKey,
  beneficiaryWallet,
  cassaWallet,
  sourceAccountId = null,
  sourceAccountSigla = null,
  turno,
  humanitarianUsdc,
  humanitarianDestination,
  reentryUsdc,
  reentryUnitUsdc,
  reentryPositionsExpected,
  protocolVersion = 'THOT_500_HUMANITARIAN_500_REENTRY_V1'
}, client = null) {
  if (!client) await initDatabase();
  const runner = client || pg;
  const event = String(eventKey || '').trim();
  if (!event) throw new Error('eventKey THOT obbligatoria');
  const beneficiary = String(beneficiaryWallet || '').trim().toLowerCase();
  const treasury = String(cassaWallet || '').trim().toLowerCase();
  if (!beneficiary || !treasury) throw new Error('Wallet THOT obbligatori');

  await runner.query(
    `INSERT INTO thot_exit_allocations (
       thot_event_key, beneficiary_wallet, cassa_wallet, source_account_id, source_account_sigla, turno,
       humanitarian_reserved_usdc, humanitarian_destination,
       reentry_usdc, reentry_unit_usdc, reentry_positions_expected,
       protocol_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (thot_event_key) DO NOTHING`,
    [
      event,
      beneficiary,
      treasury,
      sourceAccountId,
      sourceAccountSigla,
      turno,
      humanitarianUsdc,
      humanitarianDestination,
      reentryUsdc,
      reentryUnitUsdc,
      reentryPositionsExpected,
      protocolVersion
    ]
  );
  const result = await runner.query(
    'SELECT * FROM thot_exit_allocations WHERE thot_event_key = $1 LIMIT 1',
    [event]
  );
  return result.rows[0] || null;
}

async function getThotExitAllocation(eventKey, client = null) {
  if (!client) await initDatabase();
  const event = String(eventKey || '').trim();
  if (!event) return null;
  const runner = client || pg;
  const result = await runner.query(
    'SELECT * FROM thot_exit_allocations WHERE thot_event_key = $1 LIMIT 1',
    [event]
  );
  return result.rows[0] || null;
}

async function completeThotExitAllocation({ eventKey, positions }, client = null) {
  if (!client) await initDatabase();
  const event = String(eventKey || '').trim();
  if (!event) throw new Error('eventKey THOT obbligatoria');
  const list = Array.isArray(positions) ? positions : [];
  const runner = client || pg;
  const result = await runner.query(
    `UPDATE thot_exit_allocations
     SET reentry_positions_created = $2,
         position_result = $3::jsonb,
         status = 'MATERIALIZED',
         materialized_at = NOW(),
         updated_at = NOW()
     WHERE thot_event_key = $1
       AND status = 'ALLOCATED'
       AND reentry_positions_created = 0
     RETURNING *`,
    [event, list.length, JSON.stringify(list)]
  );
  if (result.rows[0]) return result.rows[0];
  return await getThotExitAllocation(event, client);
}

// ========================================
// ISIDE EXIT ALLOCATIONS
// ========================================

async function createIsideExitAllocation({
  eventKey,
  beneficiaryWallet,
  cassaWallet,
  sourceAccountId = null,
  sourceAccountSigla = null,
  turno,
  totalReceivedUsdc,
  baseNetUsdc,
  receiverGiftUsdc,
  receiverPayoutUsdc,
  reentryUsdc,
  reentryUnitUsdc,
  reentryPositionsExpected,
  protocolVersion = 'ISIDE_5000_REENTRY_6000_RECEIVER_GIFT_V1'
}, client = null) {
  if (!client) await initDatabase();
  const runner = client || pg;
  const event = String(eventKey || '').trim();
  if (!event) throw new Error('eventKey ISIDE obbligatoria');
  const beneficiary = String(beneficiaryWallet || '').trim().toLowerCase();
  const treasury = String(cassaWallet || '').trim().toLowerCase();
  if (!beneficiary || !treasury) throw new Error('Wallet ISIDE obbligatori');

  await runner.query(
    `INSERT INTO iside_exit_allocations (
       iside_event_key, beneficiary_wallet, cassa_wallet, source_account_id, source_account_sigla, turno,
       total_received_usdc, base_net_usdc, receiver_gift_usdc, receiver_payout_usdc,
       reentry_usdc, reentry_unit_usdc, reentry_positions_expected,
       protocol_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (iside_event_key) DO NOTHING`,
    [
      event,
      beneficiary,
      treasury,
      sourceAccountId,
      sourceAccountSigla,
      turno,
      totalReceivedUsdc,
      baseNetUsdc,
      receiverGiftUsdc,
      receiverPayoutUsdc,
      reentryUsdc,
      reentryUnitUsdc,
      reentryPositionsExpected,
      protocolVersion
    ]
  );
  const result = await runner.query(
    'SELECT * FROM iside_exit_allocations WHERE iside_event_key = $1 LIMIT 1',
    [event]
  );
  return result.rows[0] || null;
}

async function getIsideExitAllocation(eventKey, client = null) {
  if (!client) await initDatabase();
  const event = String(eventKey || '').trim();
  if (!event) return null;
  const runner = client || pg;
  const result = await runner.query(
    'SELECT * FROM iside_exit_allocations WHERE iside_event_key = $1 LIMIT 1',
    [event]
  );
  return result.rows[0] || null;
}

async function completeIsideExitAllocation({ eventKey, positions }, client = null) {
  if (!client) await initDatabase();
  const event = String(eventKey || '').trim();
  if (!event) throw new Error('eventKey ISIDE obbligatoria');
  const list = Array.isArray(positions) ? positions : [];
  const runner = client || pg;
  const result = await runner.query(
    `UPDATE iside_exit_allocations
     SET reentry_positions_created = $2,
         position_result = $3::jsonb,
         status = 'MATERIALIZED',
         materialized_at = NOW(),
         updated_at = NOW()
     WHERE iside_event_key = $1
       AND status = 'ALLOCATED'
       AND reentry_positions_created = 0
     RETURNING *`,
    [event, list.length, JSON.stringify(list)]
  );
  if (result.rows[0]) return result.rows[0];
  return await getIsideExitAllocation(event, client);
}

// ========================================
// STATE PERSISTENCE
// ========================================

async function getState(key, defaultValue = {}) {
  await initDatabase();
  const row = await pg.queryOne('SELECT value FROM state_persistence WHERE key = $1', [key]);
  return row ? row.value : defaultValue;
}

async function setState(key, value) {
  await initDatabase();
  await pg.query(
    `INSERT INTO state_persistence (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

// ========================================
// KILL SWITCH — blocco/sblocco sistema
// ========================================

/** Blocca il sistema (nessuna operazione sarà accettata finché bloccato) */
async function bloccaSistema(motivo = 'Blocco di emergenza') {
  await initDatabase();
  await pg.query(
    `INSERT INTO state_persistence (key, value, updated_at)
     VALUES ('sistema_blocco', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({ bloccato: true, motivo, timestamp: new Date().toISOString() })]
  );
}

/** Sblocca il sistema */
async function sbloccaSistema() {
  await initDatabase();
  await pg.query(
    `INSERT INTO state_persistence (key, value, updated_at)
     VALUES ('sistema_blocco', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({ bloccato: false, timestamp: new Date().toISOString() })]
  );
}

/** Verifica se il sistema è bloccato */
async function isSistemaBlocato() {
  await initDatabase();
  const row = await pg.queryOne('SELECT value FROM state_persistence WHERE key = $1', ['sistema_blocco']);
  return row?.value?.bloccato === true;
}

/** Restituisce lo stato del blocco con motivo e timestamp */
async function getStatoBlocco() {
  await initDatabase();
  const row = await pg.queryOne('SELECT value FROM state_persistence WHERE key = $1', ['sistema_blocco']);
  if (!row) return { bloccato: false };
  return row.value;
}

// ========================================
// STORICO
// ========================================

async function registraAvanzamento({ wallet, accountId = null, accountSigla = null, tipoAccount, daLivello, aLivello, daBlocco, aBlocco, turno, doniRicevuti, doniTrattenuti, netto, evento, dettagli, eventKey = null }, client = null) {
  if (!client) {
    await initDatabase();
  }
  if (eventKey === null) {
    if (client) {
      const result = await client.query(
        `INSERT INTO storico_avanzamenti (wallet, account_id, account_sigla, tipo_account, da_livello, a_livello, da_blocco, a_blocco, turno, doni_ricevuti, doni_trattenuti, netto, evento, dettagli)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [wallet.toLowerCase(), accountId, accountSigla, tipoAccount, daLivello, aLivello, daBlocco, aBlocco, turno, doniRicevuti, doniTrattenuti, netto, evento, dettagli ? JSON.stringify(dettagli) : null]
      );
      return result.rows[0] || null;
    }
    return await pg.queryOne(
      `INSERT INTO storico_avanzamenti (wallet, account_id, account_sigla, tipo_account, da_livello, a_livello, da_blocco, a_blocco, turno, doni_ricevuti, doni_trattenuti, netto, evento, dettagli)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [wallet.toLowerCase(), accountId, accountSigla, tipoAccount, daLivello, aLivello, daBlocco, aBlocco, turno, doniRicevuti, doniTrattenuti, netto, evento, dettagli ? JSON.stringify(dettagli) : null]
    );
  }

  const insertSql = `INSERT INTO storico_avanzamenti (wallet, account_id, account_sigla, tipo_account, da_livello, a_livello, da_blocco, a_blocco, turno, doni_ricevuti, doni_trattenuti, netto, evento, dettagli, event_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING
     RETURNING *`;
  const insertParams = [wallet.toLowerCase(), accountId, accountSigla, tipoAccount, daLivello, aLivello, daBlocco, aBlocco, turno, doniRicevuti, doniTrattenuti, netto, evento, dettagli ? JSON.stringify(dettagli) : null, eventKey];
  const inserted = client
    ? (await client.query(insertSql, insertParams)).rows[0] || null
    : await pg.queryOne(insertSql, insertParams);

  if (inserted) {
    return inserted;
  }
  if (client) {
    const result = await client.query(
      'SELECT * FROM storico_avanzamenti WHERE event_key = $1 LIMIT 1',
      [eventKey]
    );
    return result.rows[0] || null;
  }
  return await pg.queryOne(
    'SELECT * FROM storico_avanzamenti WHERE event_key = $1 LIMIT 1',
    [eventKey]
  );
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  initDatabase,

  // Accounts
  createAccount, getAccount, getAccountsByWallet, getAccountById, getAccountByKey, getAccountByIdentity, updateAccountIdentity, assignTicket, assignTicketToAccountId, assignSpecificTicket, assignNextGemelloTicket, assignNextGemelloTicketToAccountId, getAccountByTicket,

  // Tavole
  getNextTavolaNumero, createTavola, getTavola, getTavolaById,
  updateTavolaStatus, updateTavolaDoni, countPosizioniInTavola,

  // Posizioni
  createPosizione, getPosizioniTavola, updatePosizioneSdoppiamento,
  getEntryReservedSlots, getEntryRolloverBySourceTable, createEntryRolloverAudit,

  // Turni
  createTurno, getTurnoCorrente, incrementSacerdotiEntrati,
  incrementTavolaCreate, completaTurno,

  // Contenitori
  addToContenitore, getNextFromContenitore, markContenitoreUsato, countInContenitore,

  // Funzioni
  createFunzione, createIdentitaFunzione, getIdentitaFunzioneByKey, getIdentitaFunzioniByWallet, updateIdentitaFunzioneStatus, getIdentitaFunzioniByTipo, createPrenotazioneFunzione, getPrenotazioneByEventKey, getPrenotazioniByFunzioneId, getPrenotazioneById, getPrenotazioneByPosizione, getPrenotazioniRiservate, updatePrenotazioneFunzione, getFunzioniByOrigine, getFunzioniPendentiPerTurno,

  // Controllo posizione attiva
  getPosizioneAttivaEntrata,

  // Donazioni
  createDonazione,

  // Allocazioni THOT
  createThotExitAllocation, getThotExitAllocation, completeThotExitAllocation,

  // Allocazioni ISIDE
  createIsideExitAllocation, getIsideExitAllocation, completeIsideExitAllocation,

  // Post-commit operations
  createPostCommitOperation, getPostCommitOperationByEventKey, markPostCommitOperationInProgress,
  markPostCommitOperationCompleted, markPostCommitOperationFailed, listRecoverablePostCommitOperations,

  // State
  getState, setState,

  // Storico
  registraAvanzamento,

  // Kill switch
  bloccaSistema, sbloccaSistema, isSistemaBlocato, getStatoBlocco
};

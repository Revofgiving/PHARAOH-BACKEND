/**
 * 🌐 PHARAOH - API Server
 *
 * Express server con tutti gli endpoint REST per il sistema PHARAOH.
 * Protetto dal Security Manager con 10 livelli di sicurezza.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const express = require('express');
const cors    = require('cors');

const pg             = require('./pg-connection-manager');
const db             = require('./db-manager');
const accountManager = require('./account-manager');
const containerManager = require('./container-manager');
const donationFlow   = require('./donation-flow-manager');
const rules          = require('./rules-engine');
const security       = require('./security-manager');
const { registerAdminRoutes } = require('./admin-routes');
const payoutManager  = require('./payout-manager');
const rogCommunity = require('./rog-community-manager');
const rogDonation = require('./rog-donation-manager');
const directDonation = require('./direct-donation-manager');
const giftFlow = require('./gift-flow-manager');
const crossAuth = require('./cross-platform-auth');
const crossEntry = require('./cross-entry-manager');
const crossOutbound = require('./cross-outbound-manager');

const app  = express();
const PORT = process.env.PORT || 4000;

// Coolify espone l'applicazione attraverso il reverse proxy Traefik.
// Un solo hop fidato permette a Express e ai rate limiter di usare l'IP
// reale del client senza accettare catene X-Forwarded-For arbitrarie.
app.set('trust proxy', 1);

// ========================================
// VALIDAZIONE AMBIENTE ALL'AVVIO
// ========================================

{
  const { ok, missing, warnings } = security.validateEnvironment();
  if (!ok) {
    console.error('\n🚨 [SECURITY] Variabili d\'ambiente obbligatorie mancanti:');
    missing.forEach(v => console.error(`   ❌ ${v}`));
    if (!['development', 'test'].includes(process.env.NODE_ENV)) {
      console.error('\n[SECURITY] Avvio bloccato in produzione senza env vars obbligatorie.');
      process.exit(1);
    }
  }
  if (warnings.length > 0) {
    console.warn('\n⚠️  [SECURITY] Avvisi di configurazione:');
    warnings.forEach(w => console.warn(`   ⚠️  ${w}`));
  }
  security.corsHardeningCheck();
}

// ========================================
// MIDDLEWARE — SICUREZZA PRIMA DI TUTTO
// ========================================

// 1. HTTP Security Headers (Helmet)
app.use(security.helmetMiddleware);

// 2. Timeout richieste configurabile (default 60 secondi; anti-Slowloris)
app.use(security.requestTimeout(Number(process.env.REQUEST_TIMEOUT_MS || 60000)));

// 3. Rate limiting generale
app.use(security.generalLimiter);

// 4. Body size limit: max 10kb per request (anti-payload-flood)
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// 5. CORS configurato
const rawOrigins = process.env.CORS_ORIGIN || '*';
const allowedOrigins = rawOrigins === '*'
  ? '*'
  : rawOrigins.split(',').map(o => o.trim());

app.use(cors({
  origin:         allowedOrigins,
  methods:        ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key', 'X-Platform-Origin', 'X-Platform-Signature'],
  credentials:    false
}));

// 6. Request logger
app.use((req, _res, next) => {
  if (req.method !== 'GET' || process.env.NODE_ENV === 'production') {
    const ts = new Date().toISOString();
    console.log(`📨 [${ts}] ${req.method} ${req.path} | IP: ${req.ip}`);
  }
  next();
});

// 7. Audit delle sole API amministrative. Non registra header, body o query
//    e conserva soltanto l'hash dell'IP.
app.use(security.adminAuditMiddleware);

// 8. KILL SWITCH — blocca tutte le operazioni se il sistema è bloccato
//    (esclusi: health, configurazione pubblica di sola lettura, /api/admin/*)
app.use(async (req, res, next) => {
  if (
    req.path === '/api/health' ||
    req.path === '/api/config/public' ||
    req.path.startsWith('/api/admin')
  ) return next();
  try {
    const blocco = await db.getStatoBlocco();
    if (blocco.bloccato) {
      return res.status(503).json({
        success: false,
        error:   `🔴 Sistema temporaneamente bloccato: ${blocco.motivo || 'manutenzione'}. Riprovare più tardi.`,
        bloccatoDal: blocco.timestamp
      });
    }
  } catch (error) {
    // Fail closed: senza poter leggere il kill switch nessuna API ordinaria
    // deve eseguire operazioni o restituire dati potenzialmente incoerenti.
    security.securityLog('KILL_SWITCH_UNAVAILABLE', error.message, req.ip);
    return res.status(503).json({
      success: false,
      error: 'Stato di sicurezza non verificabile. Riprovare più tardi.'
    });
  }
  next();
});

// ========================================
// HEALTH & STATUS
// ========================================

app.get('/api/health', async (_req, res) => {
  const dbOk = await pg.testConnection();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'db_error',
    timestamp: new Date().toISOString()
  });
});

// Configurazione pubblica necessaria al frontend per costruire una donazione.
// Non espone chiavi private, URL RPC o altri secret.
app.get('/api/config/public', (_req, res) => {
  const treasuryWallet = String(process.env.PHARAOH_TREASURY_WALLET || '').toLowerCase();
  const usdcContractAddress = String(process.env.USDC_CONTRACT_ADDRESS || '').toLowerCase();
  const registryAddress = String(process.env.PHARAOH_REGISTRY_ADDRESS || '').toLowerCase();
  const polygonChainId = Number(process.env.POLYGON_CHAIN_ID || 137);
  let rogConfig = null;
  try {
    rogConfig = rogDonation.getConfig();
  } catch (_) {
    rogConfig = null;
  }

  if (
    !security.WALLET_REGEX.test(treasuryWallet) ||
    !security.WALLET_REGEX.test(usdcContractAddress) ||
    !security.WALLET_REGEX.test(registryAddress) ||
    !rogConfig ||
    !security.WALLET_REGEX.test(rogConfig.treasuryWallet) ||
    !security.WALLET_REGEX.test(rogConfig.contractAddress) ||
    !security.WALLET_REGEX.test(rogConfig.usdcContractAddress)
  ) {
    return res.status(503).json({
      success: false,
      code: 'PUBLIC_BLOCKCHAIN_CONFIG_UNAVAILABLE',
      error: 'Configurazione blockchain pubblica PHARAOH/ROG non disponibile.'
    });
  }

  res.json({
    success: true,
    network: {
      name: 'Polygon',
      chainId: polygonChainId
    },
    usdc: {
      contractAddress: usdcContractAddress,
      decimals: 6
    },
    treasuryWallet,
    entryDonationUsdc: rules.IMPORTI.DONO_ENTRATA,
    minConfirmations: Number(process.env.POLYGON_MIN_CONFIRMATIONS || 1),
    registry: {
      contractAddress: registryAddress,
      chainId: polygonChainId,
      explorerBaseUrl: polygonChainId === 137 ? 'https://polygonscan.com' : 'https://amoy.polygonscan.com'
    },
    rog: {
      treasuryWallet: rogConfig.treasuryWallet,
      contractAddress: rogConfig.contractAddress,
      usdcContractAddress: rogConfig.usdcContractAddress,
      requiredDonationUsdc: rogConfig.amountUsdc,
      chainId: rogConfig.chainId,
      minConfirmations: rogConfig.minConfirmations
    }
  });
});

app.get('/api/stato', async (_req, res) => {
  try {
    const stato = await donationFlow.getStatoSistema();
    res.json({ success: true, ...stato });
  } catch (e) {
    res.status(500).json({ success: false, error: security.sanitizeError(e) });
  }
});

// ========================================
// INIZIALIZZAZIONE — PROTETTA DA API KEY
// ========================================

app.post('/api/sistema/init',
  security.initLimiter,
  security.requireAdminKey,
  async (_req, res) => {
    try {
      const result = await donationFlow.inizializzaSistema();
      res.json({ success: true, sistema: result });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  }
);

// ========================================
// ADMIN — DONI PENDENTI
// ========================================

app.post('/api/admin/doni-pendenti/:id/retry',
  security.requireAdminKey,
  async (req, res) => {
    try {
      const id = security.validatePositiveInt(req.params.id, 'id');
      const result = await payoutManager.retryPendingGift({ id });
      res.json({ success: true, dono: result });
    } catch (e) {
      res.status(security.httpStatusForError(e, 400)).json({ success: false, error: security.sanitizeError(e) });
    }
  }
);

app.post('/api/admin/doni-pendenti/expire',
  security.requireAdminKey,
  async (req, res) => {
    try {
      const limit = security.validatePositiveInt(req.body.limit ?? 200, 'limit');
      const result = await payoutManager.expirePendingGifts({ limit });
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(security.httpStatusForError(e, 400)).json({ success: false, error: security.sanitizeError(e) });
    }
  }
);

// ========================================
// ACCOUNT & REGISTRAZIONE
// ========================================

app.post('/api/account/registra', (_req, res) => {
  res.status(410).json({
    success: false,
    code: 'SEPARATE_REGISTRATION_DISABLED',
    error: 'Registrazione separata disabilitata: l’account nasce soltanto dopo un dono on-chain valido.'
  });
});

app.get('/api/account/:wallet', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.params.wallet, 'wallet (URL)');
    const info = await accountManager.getAccountInfo(wallet);
    if (!info) return res.status(404).json({ success: false, error: 'Account non trovato' });
    res.json({ success: true, account: security.toPublicAccount(info) });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

// ========================================
// AREA PERSONALE — endpoint lettura wallet
// ========================================

app.get('/api/account/:wallet/posizioni', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.params.wallet, 'wallet (URL)').toLowerCase();
    const rows = await pg.queryMany(
      `
      SELECT
        p.id,
        p.casella,
        p.status,
        p.tipo,
        p.created_at,
        p.account_id AS percorso_id,
        COALESCE(p.account_sigla, a.sigla, a.ticket_number::text) AS sigla_percorso,
        a.ticket_number AS numero_posizionale,
        a.tipo AS tipo_percorso,
        a.origin_kind AS origine_percorso,
        t.numero AS tavola_numero,
        t.livello,
        t.turno,
        t.status AS tavola_status
      FROM posizioni p
      JOIN tavole t ON t.id = p.tavola_id
      LEFT JOIN accounts a ON a.id = p.account_id
      WHERE LOWER(p.wallet) = $1
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 500
    `,
      [wallet]
    );
    res.json({
      success: true,
      wallet,
      // Tutte le righe appartengono allo stesso wallet/persona. percorso_id e
      // sigla_percorso distinguono soltanto i diversi percorsi posizionali.
      rows
    });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

app.get('/api/account/:wallet/cross', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.params.wallet, 'wallet (URL)').toLowerCase();
    const [crossRows, directRogRows, giftRogRows] = await Promise.all([
      pg.queryMany(
        `SELECT
           event_key,
           target_platform,
           amount_usdc,
           positions_expected,
           status,
           payment_tx_hash,
           registry_tx_hash,
           registry_tx_id,
           registry_block_number,
           registry_confirmed_at,
           registry_last_error,
           account_id AS percorso_id,
           account_sigla AS sigla_percorso,
           created_at,
           updated_at,
           completed_at,
           last_error
         FROM cross_outbound_operations
         WHERE LOWER(beneficiary_wallet) = $1
         ORDER BY created_at DESC
         LIMIT 200`,
        [wallet]
      ),
      pg.queryMany(
        `SELECT session_ref, rog_usdc_tx_hash, rog_fulfillment_status,
                rog_human_position, rog_result, created_at, updated_at
         FROM direct_donation_sessions
         WHERE LOWER(wallet) = $1
           AND rog_payment_confirmed_at IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 100`,
        [wallet]
      ),
      pg.queryMany(
        `SELECT gift_id, payment_wallet, beneficiary_wallet, rog_usdc_tx_hash,
                status, rog_result, rog_completed_at, created_at, updated_at
         FROM gift_sessions
         WHERE LOWER(beneficiary_wallet) = $1
           AND rog_usdc_tx_hash IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 100`,
        [wallet]
      )
    ]);

    const parseJson = value => {
      if (!value) return null;
      if (typeof value === 'object') return value;
      try { return JSON.parse(value); } catch (_) { return null; }
    };
    const findHuman = (result, expectedWallet) => {
      const parsed = parseJson(result);
      const candidates = [
        parsed?.completion?.positions?.posizioni,
        parsed?.positions?.posizioni,
        parsed?.rogCompletion?.positions?.posizioni,
        parsed?.gift?.completion?.positions?.posizioni
      ];
      for (const list of candidates) {
        if (!Array.isArray(list)) continue;
        const exact = list.find(item => String(item?.tipo || '').toUpperCase() === 'HUMAN' && String(item?.wallet || '').toLowerCase() === expectedWallet);
        const human = exact || list.find(item => String(item?.tipo || '').toUpperCase() === 'HUMAN');
        if (human) return human;
      }
      return null;
    };

    const directAssignments = directRogRows.map(row => {
      const human = findHuman(row.rog_result, wallet);
      const humanPosition = Number(row.rog_human_position || human?.posizione || 0) || null;
      return {
        event_key: `DIRECT_ROG:${row.session_ref}`,
        target_platform: 'ROG',
        amount_usdc: 2,
        positions_expected: 1,
        status: humanPosition ? 'COMPLETED' : 'ASSEGNAZIONE_IN_CORSO',
        payment_tx_hash: row.rog_usdc_tx_hash,
        registry_tx_hash: null,
        registry_tx_id: null,
        registry_block_number: null,
        registry_confirmed_at: null,
        registry_last_error: null,
        percorso_id: null,
        sigla_percorso: 'Ingresso diretto PHARAOH',
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: humanPosition ? row.updated_at : null,
        last_error: null,
        rog_assignment_source: 'DIRECT',
        rog_human_position: humanPosition,
        rog_molecola: human?.molecola ?? null,
        rog_livello_h: human?.generazione ?? null
      };
    });

    const giftAssignments = giftRogRows.map(row => {
      const human = findHuman(row.rog_result, wallet);
      const humanPosition = Number(human?.posizione || 0) || null;
      return {
        event_key: `GIFT_ROG:${row.gift_id}`,
        target_platform: 'ROG',
        amount_usdc: 2,
        positions_expected: 1,
        status: humanPosition ? 'COMPLETED' : 'ASSEGNAZIONE_IN_CORSO',
        payment_tx_hash: row.rog_usdc_tx_hash,
        registry_tx_hash: null,
        registry_tx_id: null,
        registry_block_number: null,
        registry_confirmed_at: null,
        registry_last_error: null,
        percorso_id: null,
        sigla_percorso: 'Carta Regalo PHARAOH',
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: humanPosition ? (row.rog_completed_at || row.updated_at) : null,
        last_error: null,
        rog_assignment_source: 'GIFT',
        rog_human_position: humanPosition,
        rog_molecola: human?.molecola ?? null,
        rog_livello_h: human?.generazione ?? null
      };
    });

    const rows = [...directAssignments, ...giftAssignments, ...crossRows]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, 300);
    res.json({ success: true, wallet, rows });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

app.get('/api/account/:wallet/doni', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.params.wallet, 'wallet (URL)').toLowerCase();
    const [ricevuti, storico, pendenti, riepilogoRicevuti] = await Promise.all([
      pg.queryMany(
        `
        SELECT d.id, d.importo, d.status, d.created_at, d.tavola_id, t.numero AS tavola_numero, d.livello, d.turno
        FROM donazioni d
        LEFT JOIN tavole t ON t.id = d.tavola_id
        WHERE d.destinatario_wallet = $1
        ORDER BY d.created_at DESC
        LIMIT 100
      `,
        [wallet]
      ),
      pg.queryMany(
        `
        SELECT d.id, d.importo, d.status, d.created_at, d.tavola_id, t.numero AS tavola_numero, d.livello, d.turno
        FROM donazioni d
        LEFT JOIN tavole t ON t.id = d.tavola_id
        WHERE d.donor_wallet = $1 OR d.destinatario_wallet = $1
        ORDER BY d.created_at DESC
        LIMIT 200
      `,
        [wallet]
      ),
      pg.queryMany(
        `
        SELECT id, event_key, importo, livello, tipo_uscita, status, created_at, expires_at, tx_hash, errore,
               registry_tx_hash, registry_tx_id, registry_block_number, registry_confirmed_at, registry_last_error
        FROM doni_pendenti
        WHERE wallet = $1
        ORDER BY created_at DESC
        LIMIT 200
      `,
        [wallet]
      ),
      pg.queryOne(
        `
        SELECT
          COUNT(*)::int AS totale,
          COALESCE(SUM(importo),0)::numeric AS importo_totale
        FROM donazioni
        WHERE destinatario_wallet = $1
      `,
        [wallet]
      )
    ]);

    res.json({
      success: true,
      riepilogo: {
        ricevuti: Number(riepilogoRicevuti?.totale || 0),
        importoRicevuto: Number(riepilogoRicevuti?.importo_totale || 0),
        pendenti: pendenti.length
      },
      ricevuti,
      pendenti,
      storico
    });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

// ========================================
// DONI PENDENTI (payout controllato)
// ========================================

app.get('/api/doni-pendenti/:wallet', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.params.wallet, 'wallet (URL)');
    const result = await payoutManager.getPendingGiftsByWallet(wallet);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

app.post('/api/doni-pendenti/:id/accetta', async (req, res) => {
  try {
    const id = security.validatePositiveInt(req.params.id, 'id');
    const wallet = security.validateWallet(req.body.wallet, 'wallet');
    const result = await payoutManager.acceptPendingGift({ id, wallet });
    res.json({ success: true, dono: result });
  } catch (e) {
    const status = security.httpStatusForError(e, 400);
    res.status(status).json({ success: false, error: security.sanitizeError(e) });
  }
});

app.get('/api/testimonianze/:wallet', async (req, res, next) => {
  // La rotta esatta /pubbliche viene registrata più avanti da admin-routes.
  if (String(req.params.wallet).toLowerCase() === 'pubbliche') return next();
  try {
    const wallet = security.validateWallet(req.params.wallet, 'wallet (URL)').toLowerCase();
    const rows = await pg.queryMany(
      `
      SELECT id, testo, immagine_url, stato, created_at
      FROM testimonianze
      WHERE wallet = $1
      ORDER BY created_at DESC
      LIMIT 100
    `,
      [wallet]
    );
    res.json({ success: true, rows });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

app.get('/api/account/ticket/:ticketNumber', async (req, res) => {
  try {
    const ticketNumber = security.validatePositiveInt(req.params.ticketNumber, 'ticketNumber');
    const account = await db.getAccountByTicket(ticketNumber);
    if (!account) return res.status(404).json({ success: false, error: 'Ticket non trovato' });
    res.json({ success: true, account: security.toPublicAccount(account) });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

// ========================================
// CONTENITORI
// ========================================

app.get('/api/contenitori', async (_req, res) => {
  try {
    const stato = await containerManager.getStatoContenitori();
    res.json({ success: true, contenitori: stato });
  } catch (e) {
    res.status(500).json({ success: false, error: security.sanitizeError(e) });
  }
});

// ========================================
// COMMUNITY ROG — source of truth esterna
// ========================================

app.get('/api/rog/community/status/:wallet', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.params.wallet, 'wallet (URL)');
    const status = await rogCommunity.getCommunityStatus(wallet);
    res.json(status);
  } catch (e) {
    res.status(security.httpStatusForError(e, 400)).json({
      success: false,
      registered: false,
      code: e.code || 'ROG_COMMUNITY_STATUS_ERROR',
      error: security.sanitizeError(e)
    });
  }
});

app.post('/api/rog/community/register', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.body.wallet);
    const result = await rogCommunity.registerCommunityWallet(wallet);
    res.json(result);
  } catch (e) {
    security.securityLog('ROG_COMMUNITY_REGISTRATION_ERROR', e.message, req.ip);
    res.status(security.httpStatusForError(e, 400)).json({
      success: false,
      registered: false,
      code: e.code || 'ROG_COMMUNITY_REGISTRATION_ERROR',
      error: security.sanitizeError(e)
    });
  }
});

// ========================================
// DIRECT — 2 USDC ROG + 100 USDC PHARAOH = 1 posizione
// ========================================

app.post('/api/donazione/diretta/session',
  security.donationLimiter,
  async (req, res) => {
    try {
      const wallet = security.validateWallet(req.body.wallet);
      const result = await directDonation.startSession(wallet);
      res.status(201).json(result);
    } catch (e) {
      security.securityLog('DIRECT_SESSION_CREATE_ERROR', e.message, req.ip);
      res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'DIRECT_SESSION_CREATE_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
    }
  }
);

app.get('/api/donazione/diretta/session/:sessionRef', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.query.wallet, 'wallet');
    const result = await directDonation.getSessionForWallet(req.params.sessionRef, wallet);
    res.json(result);
  } catch (e) {
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'DIRECT_SESSION_READ_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
  }
});

app.post('/api/donazione/diretta/rog/payment',
  security.donationLimiter,
  async (req, res) => {
    try {
      const wallet = security.validateWallet(req.body.wallet);
      const rogUsdcTxHash = security.validateTxHash(req.body.rogUsdcTxHash || req.body.txHash);
      const sessionRef = String(req.body.sessionRef || '').trim();
      const rogRegisterTxHash = req.body.rogRegisterTxHash ? security.validateTxHash(req.body.rogRegisterTxHash) : null;
      const rogDonationId = req.body.rogDonationId ? String(req.body.rogDonationId).trim() : null;
      const result = await directDonation.confirmRogPayment({ wallet, sessionRef, rogUsdcTxHash, rogRegisterTxHash, rogDonationId });
      res.json(result);
    } catch (e) {
      security.securityLog('DIRECT_ROG_PAYMENT_ERROR', e.message, req.ip);
      res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'DIRECT_ROG_PAYMENT_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
    }
  }
);

app.post('/api/donazione/diretta/rog/register',
  security.donationLimiter,
  async (req, res) => {
    try {
      const wallet = security.validateWallet(req.body.wallet);
      const rogRegisterTxHash = security.validateTxHash(req.body.rogRegisterTxHash || req.body.txHash);
      const rogDonationId = String(req.body.rogDonationId || '').trim();
      const sessionRef = String(req.body.sessionRef || '').trim();
      const result = await directDonation.submitRogRegistration({ wallet, sessionRef, rogRegisterTxHash, rogDonationId });
      res.json(result);
    } catch (e) {
      security.securityLog('DIRECT_ROG_REGISTER_ERROR', e.message, req.ip);
      res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'DIRECT_ROG_REGISTER_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
    }
  }
);

app.post('/api/donazione/diretta/rog/confirm',
  security.donationLimiter,
  async (req, res) => {
    try {
      const wallet = security.validateWallet(req.body.wallet);
      const rogUsdcTxHash = security.validateTxHash(req.body.rogUsdcTxHash);
      const rogRegisterTxHash = security.validateTxHash(req.body.rogRegisterTxHash);
      const rogDonationId = String(req.body.rogDonationId || '').trim();
      const sessionRef = String(req.body.sessionRef || '').trim();
      const result = await directDonation.confirmRogDonation({ wallet, sessionRef, rogUsdcTxHash, rogRegisterTxHash, rogDonationId });
      res.json(result);
    } catch (e) {
      security.securityLog('DIRECT_DONATION_ROG_ERROR', e.message, req.ip);
      res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'DIRECT_DONATION_ROG_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
    }
  }
);


app.post('/api/donazione/diretta/rog/external/verify',
  security.donationLimiter,
  async (req, res) => {
    try {
      const wallet = security.validateWallet(req.body.wallet);
      const rogUsdcTxHash = security.validateTxHash(req.body.rogUsdcTxHash);
      const rogRegisterTxHash = req.body.rogRegisterTxHash ? security.validateTxHash(req.body.rogRegisterTxHash) : null;
      const rogDonationId = req.body.rogDonationId == null ? null : String(req.body.rogDonationId).trim();
      const sessionRef = String(req.body.sessionRef || '').trim();
      const rogPositionHint = req.body.rogPosition == null || String(req.body.rogPosition).trim() === ''
        ? null
        : security.validateIntegerInRange(req.body.rogPosition, 1, Number.MAX_SAFE_INTEGER, 'rogPosition');
      const result = await directDonation.verifyExternalRogReturn({
        wallet,
        sessionRef,
        rogUsdcTxHash,
        rogRegisterTxHash,
        rogDonationId,
        rogPositionHint
      });
      res.json(result);
    } catch (e) {
      security.securityLog('DIRECT_ROG_EXTERNAL_VERIFY_ERROR', e.message, req.ip);
      res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'DIRECT_ROG_EXTERNAL_VERIFY_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
    }
  }
);

app.post('/api/donazione/diretta/rog/position/verify',
  security.donationLimiter,
  async (req, res) => {
    try {
      const wallet = security.validateWallet(req.body.wallet);
      const sessionRef = String(req.body.sessionRef || '').trim();
      const rogPosition = req.body.rogPosition == null || String(req.body.rogPosition).trim() === ''
        ? null
        : security.validateIntegerInRange(req.body.rogPosition, 1, Number.MAX_SAFE_INTEGER, 'rogPosition');
      const result = await directDonation.verifyRogPositionForSession({ wallet, sessionRef, rogPosition });
      res.json(result);
    } catch (e) {
      security.securityLog('DIRECT_ROG_POSITION_VERIFY_ERROR', e.message, req.ip);
      res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'DIRECT_ROG_POSITION_VERIFY_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
    }
  }
);

app.post('/api/donazione/entrata/wallet',
  security.donationLimiter,
  async (req, res) => {
    try {
      const wallet = security.validateWallet(req.body.wallet);
      const txHash = security.validateTxHash(req.body.txHash);
      const nome = security.sanitizeNome(req.body.nome);
      const sessionRef = String(req.body.sessionRef || '').trim();
      const result = await donationFlow.processaDonoEntrataWallet({ wallet, txHash, sessionRef, nome });
      res.json(result);
    } catch (e) {
      const status = e.message?.includes('già registrat') ? 409
                   : e.message?.includes('già partecipante') ? 409
                   : security.httpStatusForError(e, 400);
      security.securityLog('DONATION_ERROR', e.message, req.ip);
      res.status(status).json({ success: false, code: e.code || 'DONATION_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
    }
  }
);

// ========================================
// CARTA REGALO — pagatore distinto dal beneficiario
// ========================================

app.post('/api/gift/create', security.donationLimiter, async (req, res) => {
  try {
    const paymentWallet = security.validateWallet(req.body.paymentWallet || req.body.donor, 'paymentWallet');
    const beneficiaryWallet = req.body.beneficiaryWallet ? security.validateWallet(req.body.beneficiaryWallet, 'beneficiaryWallet') : null;
    const giftMessage = security.sanitizeString(req.body.giftMessage, 500);
    const result = await giftFlow.createGift({ giftId: req.body.giftId || null, paymentWallet, beneficiaryWallet, giftMessage });
    res.status(result.created ? 201 : 200).json(result);
  } catch (e) {
    security.securityLog('GIFT_CREATE_ERROR', e.message, req.ip);
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'GIFT_CREATE_ERROR', retryable: e.retryable === true, giftId: e.giftId || null, error: security.sanitizeError(e) });
  }
});

app.post('/api/gift/:giftId/rog/external/verify', security.donationLimiter, async (req, res) => {
  try {
    const paymentWallet = security.validateWallet(req.body.paymentWallet || req.body.donor, 'paymentWallet');
    const rogUsdcTxHash = security.validateTxHash(req.body.rogUsdcTxHash || req.body.txHash);
    const rawRegisterTxHash = req.body.rogRegisterTxHash || req.body.registerTxHash || null;
    const rogRegisterTxHash = rawRegisterTxHash ? security.validateTxHash(rawRegisterTxHash) : null;
    const rawDonationId = req.body.rogDonationId || req.body.donationId || null;
    const rogDonationId = rawDonationId == null ? null : String(rawDonationId).trim();
    res.json(await giftFlow.verifyExternalRogGift({ giftId: req.params.giftId, paymentWallet, rogUsdcTxHash, rogRegisterTxHash, rogDonationId }));
  } catch (e) {
    security.securityLog('GIFT_ROG_EXTERNAL_VERIFY_ERROR', e.message, req.ip);
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'GIFT_ROG_EXTERNAL_VERIFY_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
  }
});

app.post('/api/gift/:giftId/rog/payment', security.donationLimiter, async (req, res) => {
  try {
    const paymentWallet = security.validateWallet(req.body.paymentWallet || req.body.donor, 'paymentWallet');
    const rogUsdcTxHash = security.validateTxHash(req.body.rogUsdcTxHash || req.body.txHash);
    res.json(await giftFlow.confirmRogPayment({ giftId: req.params.giftId, paymentWallet, rogUsdcTxHash }));
  } catch (e) {
    security.securityLog('GIFT_ROG_PAYMENT_ERROR', e.message, req.ip);
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'GIFT_ROG_PAYMENT_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
  }
});

app.post('/api/gift/:giftId/rog/register', security.donationLimiter, async (req, res) => {
  try {
    const paymentWallet = security.validateWallet(req.body.paymentWallet || req.body.donor, 'paymentWallet');
    const rogRegisterTxHash = security.validateTxHash(req.body.rogRegisterTxHash || req.body.registerTxHash);
    const rogDonationId = String(req.body.rogDonationId || req.body.donationId || '').trim();
    res.json(await giftFlow.confirmRogRegistration({ giftId: req.params.giftId, paymentWallet, rogRegisterTxHash, rogDonationId }));
  } catch (e) {
    security.securityLog('GIFT_ROG_REGISTER_ERROR', e.message, req.ip);
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'GIFT_ROG_REGISTER_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
  }
});

app.post('/api/gift/:giftId/pharaoh/payment', security.donationLimiter, async (req, res) => {
  try {
    const paymentWallet = security.validateWallet(req.body.paymentWallet || req.body.donor, 'paymentWallet');
    const pharaohTxHash = security.validateTxHash(req.body.pharaohTxHash || req.body.txHash);
    const beneficiaryName = security.sanitizeNome(req.body.beneficiaryName || req.body.nome);
    res.json(await giftFlow.processPharaohPayment({ giftId: req.params.giftId, paymentWallet, pharaohTxHash, beneficiaryName }));
  } catch (e) {
    security.securityLog('GIFT_PHARAOH_PAYMENT_ERROR', e.message, req.ip);
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'GIFT_PHARAOH_PAYMENT_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
  }
});

app.get('/api/gift/:giftId', async (req, res) => {
  try { res.json(await giftFlow.getGift(req.params.giftId)); }
  catch (e) { res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'GIFT_READ_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) }); }
});

app.get('/api/community/access/:wallet', async (req, res) => {
  try { res.json(await giftFlow.getCommunityAccess(security.validateWallet(req.params.wallet, 'wallet'))); }
  catch (e) { res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'COMMUNITY_ACCESS_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) }); }
});

app.post('/api/gift/:giftId/community-access', async (req, res) => {
  try {
    const beneficiaryWallet = security.validateWallet(req.body.beneficiaryWallet || req.body.wallet, 'beneficiaryWallet');
    res.json(await giftFlow.registerGiftCommunityAccess({ giftId: req.params.giftId, beneficiaryWallet }));
  } catch (e) {
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'GIFT_COMMUNITY_ACCESS_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
  }
});

// ========================================
// URANUS -> PHARAOH — unico ingresso cross abilitato in questa release
// ========================================

app.post('/api/cross/donation/entrata', security.donationLimiter, async (req, res) => {
  try {
    crossAuth.verifyRequest(req, 'URANUS');
    const result = await crossEntry.processUranusDonation(req.body);
    res.json(result);
  } catch (e) {
    security.securityLog('URANUS_CROSS_ENTRY_ERROR', e.message, req.ip);
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'URANUS_CROSS_ENTRY_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
  }
});

// Recovery manuale del fulfillment ROG DIRECT. Non modifica il gate economico:
// serve soltanto a forzare un ciclo del worker asincrono.
app.post('/api/admin/direct/rog/process', security.requireAdminKey, async (req, res) => {
  try {
    const limit = req.body?.limit == null ? 5 : security.validateIntegerInRange(req.body.limit, 1, 50, 'limit');
    res.json(await directDonation.processRogFulfillmentPending(limit));
  } catch (e) {
    res.status(security.httpStatusForError(e, 500)).json({ success: false, code: e.code || 'DIRECT_ROG_FULFILLMENT_ERROR', error: security.sanitizeError(e) });
  }
});

// ========================================
// CROSS OUTBOUND RHA — amministrazione / recovery
// ========================================

app.get('/api/admin/cross/outbound', security.requireAdminKey, async (req, res) => {
  try { res.json({ success: true, operations: await crossOutbound.listOperations(req.query.limit) }); }
  catch (e) { res.status(security.httpStatusForError(e, 500)).json({ success: false, code: e.code || 'CROSS_OUTBOUND_LIST_ERROR', error: security.sanitizeError(e) }); }
});

app.post('/api/admin/cross/outbound/process', security.requireAdminKey, async (req, res) => {
  try { res.json(await crossOutbound.processPending(req.body?.limit || 10)); }
  catch (e) { res.status(security.httpStatusForError(e, 500)).json({ success: false, code: e.code || 'CROSS_OUTBOUND_PROCESS_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) }); }
});

app.post('/api/admin/cross/outbound/:eventKey/process', security.requireAdminKey, async (req, res) => {
  try { res.json(await crossOutbound.processOperation(req.params.eventKey)); }
  catch (e) { res.status(security.httpStatusForError(e, 500)).json({ success: false, code: e.code || 'CROSS_OUTBOUND_PROCESS_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) }); }
});

app.post('/api/admin/cross/outbound/:eventKey/reconcile-tx', security.requireAdminKey, async (req, res) => {
  try {
    const paymentTxHash = security.validateTxHash(req.body.paymentTxHash || req.body.payment_tx_hash);
    const reconciled = await crossOutbound.attachReconciledTx({ eventKey: req.params.eventKey, paymentTxHash });
    const processed = req.body.process === false ? null : await crossOutbound.processOperation(req.params.eventKey);
    res.json({ success: true, reconciled, processed });
  } catch (e) {
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'CROSS_OUTBOUND_RECONCILE_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
  }
});

app.post('/api/admin/cross/outbound/:eventKey/reconcile-rog-register', security.requireAdminKey, async (req, res) => {
  try {
    const registerTxHash = security.validateTxHash(req.body.registerTxHash || req.body.register_tx_hash || req.body.rogRegisterTxHash);
    const reconciled = await crossOutbound.attachReconciledRogRegisterTx({ eventKey: req.params.eventKey, registerTxHash });
    const processed = req.body.process === false ? null : await crossOutbound.processOperation(req.params.eventKey);
    res.json({ success: true, reconciled, processed });
  } catch (e) {
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'CROSS_OUTBOUND_ROG_REGISTER_RECONCILE_ERROR', retryable: e.retryable === true, error: security.sanitizeError(e) });
  }
});

// Recovery delle devoluzioni URANUS storiche: richiede sempre mapping esplicito
// tx -> beneficiario e la stessa verifica on-chain del receiver ordinario.
app.post('/api/admin/cross/uranus/reconcile', security.requireAdminKey, async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (!events.length || events.length > 100) return res.status(400).json({ success: false, error: 'events deve contenere da 1 a 100 eventi URANUS' });
    const results = [];
    for (const event of events) {
      try { results.push(await crossEntry.processUranusDonation(event)); }
      catch (error) { results.push({ success: false, eventKey: event?.event_key || event?.sourceEventKey || null, code: error.code || 'ERROR', retryable: error.retryable === true, error: security.sanitizeError(error) }); }
    }
    res.json({ success: true, processed: results.length, results });
  } catch (e) {
    res.status(security.httpStatusForError(e, 400)).json({ success: false, code: e.code || 'URANUS_RECONCILIATION_ERROR', error: security.sanitizeError(e) });
  }
});

// Recovery generico delle operazioni post-COMMIT Entrata gia persistite.
// Utile anche quando una URANUS_TO_PHARAOH ha gia assegnato le posizioni ma
// il processo si e interrotto prima della cascata di uscita tavola.
app.post('/api/admin/post-commit/recover', security.requireAdminKey, async (req, res) => {
  try {
    const limit = req.body?.limit == null
      ? 100
      : security.validateIntegerInRange(req.body.limit, 1, 500, 'limit');
    res.json({ success: true, recovery: await donationFlow.recuperaOperazioniPostCommit(limit) });
  } catch (e) {
    res.status(security.httpStatusForError(e, 500)).json({
      success: false,
      code: e.code || 'POST_COMMIT_RECOVERY_ERROR',
      retryable: e.retryable === true,
      error: security.sanitizeError(e)
    });
  }
});

// Processa prossimo dono al livello di entrata (100) — solo uso interno/admin
app.post('/api/donazione/entrata', security.requireAdminKey, async (_req, res) => {
  try { res.json(await donationFlow.processaDonoEntrata()); }
  catch (e) { res.status(500).json({ success: false, error: security.sanitizeError(e) }); }
});

// Processa prossimo dono nel Sistema Pharaoh (500) — solo uso interno/admin
app.post('/api/donazione/pharaoh', security.requireAdminKey, async (_req, res) => {
  try { res.json(await donationFlow.processaDonoPharaoh()); }
  catch (e) { res.status(500).json({ success: false, error: security.sanitizeError(e) }); }
});

// ========================================
// TAVOLE & POSIZIONI
// ========================================

app.get('/api/tavola/:numero', async (req, res) => {
  try {
    const numero = security.validatePositiveInt(req.params.numero, 'numero tavola');
    const sezione = String(req.query.sezione || 'PHARAOH').toUpperCase();
    if (!['ENTRATA', 'PHARAOH'].includes(sezione)) {
      return res.status(400).json({ success: false, error: 'Sezione tavola non valida' });
    }
    const tavola = await db.getTavola(numero, sezione);
    if (!tavola) return res.status(404).json({ success: false, error: 'Tavola non trovata' });

    const posizioni = await db.getPosizioniTavola(tavola.id);
    res.json({ success: true, tavola, posizioni });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

app.get('/api/tavole', async (req, res) => {
  try {
    const { livello, turno, status } = req.query;
    let sql = 'SELECT * FROM tavole WHERE 1=1';
    const params = [];

    if (livello !== undefined) { params.push(security.validateIntegerInRange(livello, 0, 5, 'livello')); sql += ` AND livello = $${params.length}`; }
    if (turno !== undefined) { params.push(security.validateIntegerInRange(turno, 1, Number.MAX_SAFE_INTEGER, 'turno')); sql += ` AND turno = $${params.length}`; }
    if (status) {
      const VALID_TAVOLA_STATUS = ['APERTA', 'COMPLETATA', 'CHIUSA'];
      if (!VALID_TAVOLA_STATUS.includes(status)) return res.status(400).json({ success: false, error: 'Valore status non valido' });
      params.push(status); sql += ` AND status = $${params.length}`;
    }

    sql += ' ORDER BY numero ASC LIMIT 100';

    const tavole = await pg.queryMany(sql, params);
    res.json({ success: true, tavole, count: tavole.length });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

// ========================================
// TURNI
// ========================================

app.get('/api/turni', async (req, res) => {
  try {
    const { sezione, livello, status } = req.query;
    let sql = 'SELECT * FROM turni WHERE 1=1';
    const params = [];

    if (sezione) {
      const VALID_SEZIONI = ['ENTRATA', 'PHARAOH'];
      const normalizedSezione = String(sezione).toUpperCase();
      if (!VALID_SEZIONI.includes(normalizedSezione)) return res.status(400).json({ success: false, error: 'Valore sezione non valido' });
      params.push(normalizedSezione); sql += ` AND sezione = $${params.length}`;
    }
    if (livello !== undefined) { params.push(security.validateIntegerInRange(livello, 0, 5, 'livello')); sql += ` AND livello = $${params.length}`; }
    if (status) {
      const VALID_TURNO_STATUS = ['IN_CORSO', 'COMPLETATO'];
      if (!VALID_TURNO_STATUS.includes(status)) return res.status(400).json({ success: false, error: 'Valore status non valido' });
      params.push(status); sql += ` AND status = $${params.length}`;
    }

    sql += ' ORDER BY numero_turno DESC LIMIT 50';

    const turni = await pg.queryMany(sql, params);
    res.json({ success: true, turni, count: turni.length });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

// ========================================
// FUNZIONI
// ========================================

app.get('/api/funzioni/:wallet', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.params.wallet, 'wallet (URL)');
    const funzioni = await db.getFunzioniByOrigine(wallet);
    res.json({ success: true, funzioni, count: funzioni.length });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

// ========================================
// STORICO
// ========================================

app.get('/api/storico/:wallet', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.params.wallet, 'wallet (URL)');
    const storico = await pg.queryMany(
      'SELECT * FROM storico_avanzamenti WHERE wallet = $1 ORDER BY created_at DESC LIMIT 50',
      [wallet]
    );
    res.json({ success: true, storico, count: storico.length });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

// ========================================
// ROUTE ADMIN/CONTENUTI (pannello completo)
// ========================================
registerAdminRoutes({ app, pg, security });

// ========================================
// PANNELLO ADMIN — Kill Switch + Stato sistema
// ========================================

const alerts = require('./alert-manager');

/**
 * 🔴 BLOCCA il sistema (kill switch di emergenza).
 * Tutte le API smettono di rispondere tranne /api/health e /api/admin/*
 */
app.post('/api/admin/blocca',
  security.requireAdminKey,
  async (req, res) => {
    try {
      const motivo = security.sanitizeString(req.body.motivo, 200) || 'Blocco di emergenza';
      await db.bloccaSistema(motivo);
      alerts.alertSistemaBlocco(motivo);
      security.securityLog('KILL_SWITCH', `Sistema BLOCCATO. Motivo: ${motivo}`, req.ip);
      res.json({ success: true, message: '🔴 Sistema BLOCCATO', motivo });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  }
);

/**
 * 🟢 SBLOCCA il sistema.
 */
app.post('/api/admin/sblocca',
  security.requireAdminKey,
  async (_req, res) => {
    try {
      await db.sbloccaSistema();
      alerts.alertSistemaRiaperto();
      security.securityLog('KILL_SWITCH', 'Sistema SBLOCCATO');
      res.json({ success: true, message: '🟢 Sistema RIAPERTO' });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  }
);

/**
 * Stato completo del sistema (DB, blocco, KYC stats).
 */
app.get('/api/admin/stato',
  security.requireAdminKey,
  async (_req, res) => {
    try {
      const dbOk      = await pg.testConnection();
      const blocco    = await db.getStatoBlocco();
      const statoSys  = await donationFlow.getStatoSistema();
      const telegram  = !!process.env.TELEGRAM_BOT_TOKEN;
      const whatsapp  = !!(process.env.TWILIO_SID && process.env.JONNY_WHATSAPP);
      res.json({
        success: true,
        db: { ok: dbOk },
        blocco,
        alert: { telegram, whatsapp },
        ...statoSys
      });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  }
);

// ========================================
// ZK-KYC — Polygon ID
// (attivato all'uscita da Rha L3 per ricezione 6.000 USDC)
// ========================================

const kycManager = require('./zk-kyc-manager');

/**
 * Genera la richiesta KYC (formato Polygon ID).
 * Il frontend converte kycRequest in QR Code da mostrare all'utente.
 * L'utente scansiona con Polygon ID Wallet e genera la ZK Proof.
 */
app.get('/api/kyc/richiesta', async (req, res) => {
  try {
    const wallet       = security.validateWallet(req.query.wallet, 'wallet');
    const callbackBase = process.env.BACKEND_URL ||
      `${req.protocol}://${req.get('host')}`;

    const result = await kycManager.generateKycRequest(wallet, callbackBase);
    res.json({
      success:     true,
      sessionId:   result.sessionId,
      kycRequest:  result.kycRequest,
      qrData:      result.qrData,          // JSON da convertire in QR Code
      expiresInMs: result.expiresInMs,
      istruzioni: [
        '1. Scarica Polygon ID Wallet (iOS/Android) — gratuita',
        '2. Ottieni una KYCAgeCredential da un issuer a tua scelta (es. Synaps, Fractal ID) — a tue spese',
        '3. Scansiona questo QR Code con il tuo Polygon ID Wallet',
        '   La proof viene generata e inviata automaticamente. Nessun dato personale trasmesso.'
      ]
    });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

/**
 * Callback ricevuto dal Polygon ID Wallet dopo la generazione della ZK Proof.
 * Il wallet invia il token JWZ a questo endpoint.
 */
app.post('/api/kyc/callback', async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId mancante' });

    // Il wallet invia il proof come body (JWZ string o JSON)
    const proofToken = typeof req.body === 'string' ? req.body : null;
    const proofJson  = typeof req.body === 'object' ? req.body : null;

    const result = await kycManager.handleKycCallback(sessionId, proofToken, proofJson);
    security.securityLog('KYC_VERIFIED', `Wallet ${result.wallet.substring(0,12)}... verificato`, req.ip);
    res.json({ success: true, message: 'KYC verificato con successo. Il payout è sbloccato.' });
  } catch (e) {
    security.securityLog('KYC_CALLBACK_ERROR', e.message, req.ip);
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

/**
 * Controlla lo stato KYC di un wallet.
 */
app.get('/api/kyc/stato/:wallet', async (req, res) => {
  try {
    const wallet = security.validateWallet(req.params.wallet, 'wallet');
    const stato  = await kycManager.getKycStatus(wallet);
    res.json({ success: true, kyc: stato });
  } catch (e) {
    res.status(400).json({ success: false, error: security.sanitizeError(e) });
  }
});

// ========================================
// REGOLE (info)
// ========================================

app.get('/api/regole', (_req, res) => {
  res.json({
    success: true,
    importi: rules.IMPORTI,
    livelli: require('./table-manager').LIVELLI
  });
});

// Simulatore uscita livello
app.get('/api/regole/simula-uscita', (req, res) => {
  try {
    const { livello, tipoAccount, doniRicevuti } = req.query;
    const result = rules.calcolaUscitaLivello(
      security.validateIntegerInRange(livello, 0, 5, 'livello'),
      tipoAccount || 'PRIMARIO',
      Number(doniRicevuti)
    );
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ========================================
// CATCH-ALL 404
// ========================================

app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint non trovato' });
});

// ========================================
// ERROR HANDLER GLOBALE — nessun leak
// ========================================

app.use((err, req, res, _next) => {
  security.securityLog('UNHANDLED_ERROR', err.message || 'Errore sconosciuto', req.ip);
  // Mai esporre stack trace o dettagli interni
  res.status(500).json({ success: false, error: 'Errore interno del server' });
});

// ========================================
// WORKER CROSS OUTBOUND RHA
// ========================================

function startCrossOutboundWorker() {
  if (process.env.CROSS_OUTBOUND_WORKER_ENABLED !== '1') {
    console.log('ℹ️  Worker cross outbound RHA disabilitato (CROSS_OUTBOUND_WORKER_ENABLED!=1)');
    return null;
  }
  const intervalMs = Math.max(10000, Number(process.env.CROSS_OUTBOUND_WORKER_INTERVAL_MS || 60000));
  const batch = Math.min(100, Math.max(1, Number(process.env.CROSS_OUTBOUND_WORKER_BATCH || 10)));
  const timer = setInterval(async () => {
    try {
      const block = await db.getStatoBlocco();
      if (block?.bloccato) return;
      const result = await crossOutbound.processPending(batch);
      const failed = result.results?.filter(x => x.success === false) || [];
      if (failed.length) security.securityLog('CROSS_OUTBOUND_WORKER_PARTIAL', failed.map(x => x.code || 'ERROR').join(','));
    } catch (error) {
      security.securityLog('CROSS_OUTBOUND_WORKER_ERROR', error.message || String(error));
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`✅ Worker cross outbound RHA attivo ogni ${intervalMs} ms, batch ${batch}`);
  return timer;
}

function startRogFulfillmentWorker() {
  if (process.env.ROG_FULFILLMENT_WORKER_ENABLED === '0') {
    console.log('ℹ️  Worker fulfillment ROG DIRECT disabilitato (ROG_FULFILLMENT_WORKER_ENABLED=0)');
    return null;
  }
  const intervalMs = Math.max(10000, Number(process.env.ROG_FULFILLMENT_WORKER_INTERVAL_MS || 15000));
  const batch = Math.min(25, Math.max(1, Number(process.env.ROG_FULFILLMENT_WORKER_BATCH || 5)));
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const block = await db.getStatoBlocco();
      if (block?.bloccato) return;
      const result = await directDonation.processRogFulfillmentPending(batch);
      const failed = result.results?.filter(x => x.success === false && x.deferred !== true) || [];
      if (failed.length) security.securityLog('DIRECT_ROG_FULFILLMENT_WORKER_PARTIAL', failed.map(x => x.code || 'ERROR').join(','));
    } catch (error) {
      security.securityLog('DIRECT_ROG_FULFILLMENT_WORKER_ERROR', error.message || String(error));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  setImmediate(run);
  console.log(`✅ Worker fulfillment ROG DIRECT attivo ogni ${intervalMs} ms, batch ${batch}`);
  return timer;
}

function startPayoutRegistryWorker() {
  if (process.env.PHARAOH_REGISTRY_WORKER_ENABLED !== '1') {
    console.log('ℹ️  Worker recovery PharaohRegistry payout disabilitato (PHARAOH_REGISTRY_WORKER_ENABLED!=1)');
    return null;
  }
  const intervalMs = Math.max(15000, Number(process.env.PHARAOH_REGISTRY_WORKER_INTERVAL_MS || 60000));
  const batch = Math.min(25, Math.max(1, Number(process.env.PHARAOH_REGISTRY_WORKER_BATCH || 5)));
  const timer = setInterval(async () => {
    try {
      const block = await db.getStatoBlocco();
      if (block?.bloccato) return;
      const result = await payoutManager.processPendingRegistry(batch);
      const pending = result.results?.filter(x => x.registryPending === true) || [];
      if (pending.length) security.securityLog('PAYOUT_REGISTRY_WORKER_PARTIAL', pending.map(x => String(x.id)).join(','));
    } catch (error) {
      security.securityLog('PAYOUT_REGISTRY_WORKER_ERROR', error.message || String(error));
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`✅ Worker recovery PharaohRegistry payout attivo ogni ${intervalMs} ms, batch ${batch}`);
  return timer;
}

// ========================================
// START
// ========================================

async function start() {
  console.log('\n🏛️ ========================================');
  console.log('   PHARAOH BACKEND SERVER');
  console.log('========================================\n');

  // Test connessione DB
  const dbOk = await pg.testConnection();
  if (!dbOk) {
    console.error('❌ Impossibile connettersi al database. Verificare DATABASE_URL in .env');
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_NON_RAGGIUNGIBILE_IN_PRODUZIONE');
    }
    console.log('ℹ️  Avvio consentito soltanto perché l’ambiente non è production.\n');
  }

  // Inizializza schema
  try {
    await db.initDatabase();
  } catch (e) {
    console.error('⚠️  Errore inizializzazione schema:', e.message);
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SCHEMA_DATABASE_NON_INIZIALIZZABILE_IN_PRODUZIONE');
    }
  }

  startCrossOutboundWorker();
  startRogFulfillmentWorker();
  startPayoutRegistryWorker();

  app.listen(PORT, () => {
    console.log(`\n🌐 Server PHARAOH in ascolto su http://localhost:${PORT}`);
    console.log(`\n📋 Endpoint principali:`);
    console.log(`   GET  /api/health              → Health check`);
    console.log(`   GET  /api/stato               → Stato sistema`);
    console.log(`   POST /api/sistema/init         → Inizializza sistema`);
    console.log(`   POST /api/account/registra     → Disabilitato (account solo dopo dono valido)`);
    console.log(`   GET  /api/account/:wallet      → Info account`);
    console.log(`   GET  /api/contenitori          → Stato contenitori`);
    console.log(`   POST /api/donazione/diretta/session       → Avvia DIRECT`);
    console.log(`   POST /api/donazione/diretta/rog/payment   → Gate economico: 2 USDC ricevuti in Cassa ROG`);
    console.log(`   POST /api/donazione/diretta/rog/register  → Registra prova registerDonation ROG (asincrono)`);
    console.log(`   POST /api/donazione/diretta/rog/confirm   → Compatibilita legacy payment+register`);
    console.log(`   POST /api/donazione/diretta/rog/external/verify → Verifica ritorno ROG payment-only; fulfillment asincrono`);
    console.log(`   POST /api/donazione/entrata/wallet        → Conferma 100 USDC PHARAOH DIRECT`);
    console.log(`   POST /api/gift/create                      → Crea Carta Regalo`);
    console.log(`   POST /api/gift/:giftId/rog/external/verify → Verifica Carta Regalo ROG esterna`);
    console.log(`   POST /api/cross/donation/entrata           → URANUS -> PHARAOH firmato HMAC`);
    console.log(`   POST /api/donazione/entrata                → Dono interno livello entrata (admin)`);
    console.log(`   POST /api/donazione/pharaoh    → Dono Sistema Pharaoh (500)`);
    console.log(`   GET  /api/tavola/:numero       → Dettaglio tavola`);
    console.log(`   GET  /api/tavole               → Lista tavole`);
    console.log(`   GET  /api/turni                → Lista turni`);
    console.log(`   GET  /api/funzioni/:wallet     → Funzioni di un account`);
    console.log(`   GET  /api/storico/:wallet      → Storico avanzamenti`);
    console.log(`   GET  /api/regole               → Costanti e regole`);
    console.log(`   GET  /api/regole/simula-uscita → Simulatore uscita livello`);
    console.log('');
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error('❌ Avvio PHARAOH fallito:', security.sanitizeError(error));
    process.exitCode = 1;
  });
}

module.exports = app;

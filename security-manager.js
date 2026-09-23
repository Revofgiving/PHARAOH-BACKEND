/**
 * 🔒 PHARAOH — Security Manager
 *
 * Forziere di sicurezza del sistema PHARAOH.
 * Implementa tutte le protezioni disponibili per un sistema
 * che gestisce transazioni finanziarie reali su blockchain.
 *
 * LIVELLI DI PROTEZIONE:
 *  1. HTTP Security Headers (Helmet)
 *  2. Rate Limiting (anti-DoS, anti-brute-force)
 *  3. Body Size Limit (anti-payload-flood)
 *  4. Input Validation (wallet, txHash, tipi)
 *  5. Admin API Key (endpoint privilegiati)
 *  6. Request Timeout (anti-slowloris)
 *  7. CORS hardening in produzione
 *  8. Environment Variables validation
 *  9. Error sanitization (nessun leak interno)
 * 10. Security Event Logging
 */

const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');

// ============================================================
// 1. HELMET — HTTP Security Headers
// ============================================================

const helmetMiddleware = helmet({
  // Impedisce il MIME-type sniffing
  contentTypeOptions: true,
  // Impedisce il clickjacking (X-Frame-Options: DENY)
  frameguard: { action: 'deny' },
  // XSS Protection header legacy
  xssFilter: true,
  // HSTS: forza HTTPS per 1 anno (solo in produzione)
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
  // Nessun referrer verso siti esterni
  referrerPolicy: { policy: 'no-referrer' },
  // Nasconde tecnologia usata
  hidePoweredBy: true,
  // Content Security Policy — blocca risorse non autorizzate
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'none'"],
      scriptSrc:   ["'none'"],
      styleSrc:    ["'none'"],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    }
  }
});

// ============================================================
// 2. RATE LIMITING
// ============================================================

// Limite generale: 100 richieste ogni 15 minuti per IP
const generalLimiter = rateLimit({
  windowMs:          15 * 60 * 1000,  // 15 minuti
  max:               100,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { success: false, error: 'Troppe richieste. Riprova tra qualche minuto.' },
  handler: (req, res, _next, options) => {
    securityLog('RATE_LIMIT', `IP ${req.ip} superato limite generale (${options.max} req/15min)`);
    res.status(429).json(options.message);
  }
});

// Limite stretto per le donazioni: 10 richieste ogni 5 minuti per IP
const donationLimiter = rateLimit({
  windowMs:          5 * 60 * 1000,  // 5 minuti
  max:               10,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { success: false, error: 'Limite donazioni raggiunto. Riprova tra 5 minuti.' },
  handler: (req, res, _next, options) => {
    securityLog('RATE_LIMIT_DONATION', `IP ${req.ip} superato limite donazioni`);
    res.status(429).json(options.message);
  }
});

// Limite molto stretto per init sistema: 3 richieste ogni 10 minuti
const initLimiter = rateLimit({
  windowMs:          10 * 60 * 1000, // 10 minuti
  max:               3,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { success: false, error: 'Limite inizializzazione raggiunto.' },
  handler: (req, res, _next, options) => {
    securityLog('RATE_LIMIT_INIT', `IP ${req.ip} tentativo ripetuto init sistema`);
    res.status(429).json(options.message);
  }
});

// ============================================================
// 3. REQUEST TIMEOUT — anti-Slowloris
// ============================================================

const requestTimeout = (timeoutMs = 30000) => (req, res, next) => {
  res.setTimeout(timeoutMs, () => {
    securityLog('TIMEOUT', `Richiesta ${req.method} ${req.path} timeout dopo ${timeoutMs}ms`);
    if (!res.headersSent) {
      res.status(408).json({ success: false, error: 'Request Timeout' });
    }
  });
  next();
};

// ============================================================
// 4. INPUT VALIDATION
// ============================================================

const WALLET_REGEX  = /^0x[a-fA-F0-9]{40}$/;
const TXHASH_REGEX  = /^0x[a-fA-F0-9]{64}$/;
const MAX_NOME_LEN  = 100;
const MAX_STRING_LEN = 200;
const NATIVE_POLYGON_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

/**
 * Valida un indirizzo wallet Ethereum.
 * @throws {Error} se il wallet non è valido
 */
function validateWallet(wallet, fieldName = 'wallet') {
  if (!wallet || typeof wallet !== 'string') {
    throw new Error(`${fieldName} obbligatorio`);
  }
  if (!WALLET_REGEX.test(wallet.trim())) {
    throw new Error(`${fieldName} non è un indirizzo Ethereum valido (0x + 40 hex chars)`);
  }
  return wallet.trim().toLowerCase();
}

/**
 * Valida un hash di transazione.
 * @throws {Error} se il txHash non è valido
 */
function validateTxHash(txHash) {
  if (!txHash || typeof txHash !== 'string') {
    throw new Error('txHash obbligatorio');
  }
  // In sviluppo, permette DEV_SKIP
  if (process.env.NODE_ENV !== 'production' && txHash === 'DEV_SKIP') {
    return txHash;
  }
  if (!TXHASH_REGEX.test(txHash.trim())) {
    throw new Error('txHash non è un hash di transazione valido (0x + 64 hex chars)');
  }
  return txHash.trim().toLowerCase();
}

/**
 * Sanitizza una stringa: rimuove caratteri pericolosi, tronca la lunghezza.
 */
function sanitizeString(value, maxLen = MAX_STRING_LEN) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  return value
    .slice(0, maxLen)
    .replace(/[<>'"`;]/g, '')  // rimuove caratteri XSS/injection
    .trim();
}

/**
 * Sanitizza un nome utente.
 */
function sanitizeNome(nome) {
  if (!nome) return null;
  return sanitizeString(nome, MAX_NOME_LEN);
}

/**
 * Valida che un parametro numerico sia un intero positivo.
 */
function validatePositiveInt(value, fieldName = 'parametro') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${fieldName} deve essere un intero non negativo`);
  }
  return n;
}

function validateIntegerInRange(value, min, max, fieldName = 'parametro') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${fieldName} deve essere un intero compreso tra ${min} e ${max}`);
  }
  return n;
}

function safeSecretEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ============================================================
// 5. ADMIN API KEY — protezione endpoint privilegiati
// ============================================================

/**
 * Middleware che richiede la chiave API di amministrazione.
 * La chiave deve essere passata nell'header: X-Admin-Key: <valore>
 * oppure come query param: ?admin_key=<valore> (solo in sviluppo)
 */
function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    securityLog('ADMIN_NO_KEY_CONFIGURED', 'Tentativo accesso admin senza ADMIN_API_KEY configurata', req.ip);
    return res.status(503).json({ success: false, error: 'Servizio amministrativo non configurato' });
  }

  const providedKey = req.headers['x-admin-key'] ||
    (process.env.NODE_ENV !== 'production' ? req.query.admin_key : null);

  if (!safeSecretEqual(providedKey, adminKey)) {
    securityLog('ADMIN_UNAUTHORIZED', 'Tentativo accesso admin con chiave errata', req.ip);
    return res.status(401).json({ success: false, error: 'Non autorizzato' });
  }

  req.adminAuthenticated = true;
  next();
}

// ============================================================
// 6. ENVIRONMENT VARIABLES VALIDATION
// ============================================================

const REQUIRED_PROD_VARS = [
  'NODE_ENV',
  'REQUEST_TIMEOUT_MS',
  'DATABASE_URL',
  'PHARAOH_FUND_A_WALLET',
  'PHARAOH_TREASURY_WALLET',
  'PHARAOH_PAYOUT_PRIVATE_KEY',
  'POLYGON_RPC_URL',
  'POLYGON_CHAIN_ID',
  'POLYGON_MIN_CONFIRMATIONS',
  'USDC_CONTRACT_ADDRESS',
  'ROG_API_BASE_URL',
  'ROG_API_TIMEOUT_MS',
  'ROG_COMPLETION_API_TIMEOUT_MS',
  'ROG_TREASURY_WALLET',
  'ROG_CONTRACT_ADDRESS',
  'ROG_USDC_CONTRACT_ADDRESS',
  'ROG_REQUIRED_DONATION_USDC',
  'PHARAOH_REGISTRY_ADDRESS',
  'PHARAOH_REGISTRY_PRIVATE_KEY',
  'PHARAOH_REGISTRY_WORKER_ENABLED',
  'URANUS_TREASURY_WALLET',
  'ROG_CROSS_PLATFORM_SECRET',
  'URANUS_CROSS_PLATFORM_SECRET',
  'ROG_CROSS_INGRESS_URL',
  'URANUS_CROSS_INGRESS_URL',
  'CROSS_OUTBOUND_WORKER_ENABLED',
  'CORS_ORIGIN',
  'ADMIN_API_KEY'
];

const REQUIRED_DEV_VARS = ['NODE_ENV', 'DATABASE_URL'];

function validateHttpUrl(value, { httpsInProduction = false } = {}) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (httpsInProduction && process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Verifica la configurazione di runtime. In production il controllo e fail-closed:
 * DIRECT, Gift, URANUS inbound e i due movimenti RHA devono avere tutte le env.
 */
function validateEnvironment() {
  const runtimeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  const isProd = runtimeEnv === 'production';
  const required = isProd ? REQUIRED_PROD_VARS : REQUIRED_DEV_VARS;
  const missing = required.filter(v => !process.env[v]);
  const warnings = [];
  const allowedEnvironments = new Set(['development', 'test', 'production']);

  if (!allowedEnvironments.has(runtimeEnv)) missing.push('NODE_ENV_DEVE_ESSERE_DEVELOPMENT_TEST_O_PRODUCTION');
  const issue = (condition, code, warning) => {
    if (!condition) return;
    if (isProd) missing.push(code); else warnings.push(warning || code);
  };

  if (!isProd) {
    const devWarn = REQUIRED_PROD_VARS.filter(v => !process.env[v] && !missing.includes(v));
    if (devWarn.length) warnings.push(`Variabili mancanti (richieste in produzione): ${devWarn.join(', ')}`);
  }

  if (isProd && process.env.CORS_ORIGIN === '*') missing.push('CORS_ORIGIN_NON_PUO_ESSERE_WILDCARD_IN_PRODUZIONE');
  if (isProd && process.env.PAYOUT_DEV_MODE === '1') missing.push('PAYOUT_DEV_MODE_NON_PUO_ESSERE_ATTIVO_IN_PRODUZIONE');

  if (isProd && process.env.ADMIN_API_KEY && (Buffer.byteLength(process.env.ADMIN_API_KEY, 'utf8') < 32 || /genera|change|example|password|your[_-]?key/i.test(process.env.ADMIN_API_KEY))) {
    missing.push('ADMIN_API_KEY_DEVE_ESSERE_CASUALE_E_DI_ALMENO_32_BYTE');
  }

  const walletVars = [
    'PHARAOH_FUND_A_WALLET', 'PHARAOH_TREASURY_WALLET',
    'USDC_CONTRACT_ADDRESS', 'ROG_TREASURY_WALLET', 'ROG_CONTRACT_ADDRESS',
    'ROG_USDC_CONTRACT_ADDRESS', 'PHARAOH_REGISTRY_ADDRESS', 'URANUS_TREASURY_WALLET'
  ];
  for (const name of walletVars) issue(process.env[name] && !WALLET_REGEX.test(process.env[name]), `${name}_NON_VALIDO`, `${name} non e un indirizzo Ethereum valido`);

  issue(process.env.PHARAOH_PAYOUT_PRIVATE_KEY && !/^0x[a-fA-F0-9]{64}$/.test(process.env.PHARAOH_PAYOUT_PRIVATE_KEY), 'PHARAOH_PAYOUT_PRIVATE_KEY_NON_VALIDA');
  issue(process.env.PHARAOH_REGISTRY_PRIVATE_KEY && !/^0x[a-fA-F0-9]{64}$/.test(process.env.PHARAOH_REGISTRY_PRIVATE_KEY), 'PHARAOH_REGISTRY_PRIVATE_KEY_NON_VALIDA');

  const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 60000);
  issue(!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 10000 || requestTimeoutMs > 120000, 'REQUEST_TIMEOUT_MS_NON_VALIDO');
  const rogApiTimeoutMs = Number(process.env.ROG_API_TIMEOUT_MS || 8000);
  issue(!Number.isInteger(rogApiTimeoutMs) || rogApiTimeoutMs < 1000 || rogApiTimeoutMs > 30000, 'ROG_API_TIMEOUT_MS_NON_VALIDO');
  const rogCompletionTimeoutMs = Number(process.env.ROG_COMPLETION_API_TIMEOUT_MS || 25000);
  issue(!Number.isInteger(rogCompletionTimeoutMs) || rogCompletionTimeoutMs < 1000 || rogCompletionTimeoutMs > 30000, 'ROG_COMPLETION_API_TIMEOUT_MS_NON_VALIDO');
  const confirmations = Number(process.env.POLYGON_MIN_CONFIRMATIONS || 1);
  issue(!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 1000, 'POLYGON_MIN_CONFIRMATIONS_NON_VALIDO');
  const chainId = Number(process.env.POLYGON_CHAIN_ID || 137);
  issue(!Number.isInteger(chainId) || chainId !== 137, 'POLYGON_CHAIN_ID_DEVE_ESSERE_137');
  const rogAmount = Number(process.env.ROG_REQUIRED_DONATION_USDC || 0);
  issue(process.env.ROG_REQUIRED_DONATION_USDC && (!Number.isInteger(rogAmount) || rogAmount !== 2), 'ROG_REQUIRED_DONATION_USDC_DEVE_ESSERE_2');
  issue(process.env.USDC_CONTRACT_ADDRESS && process.env.USDC_CONTRACT_ADDRESS.toLowerCase() !== NATIVE_POLYGON_USDC, 'USDC_CONTRACT_ADDRESS_DEVE_ESSERE_CIRCLE_NATIVO_POLYGON');
  issue(process.env.ROG_USDC_CONTRACT_ADDRESS && process.env.ROG_USDC_CONTRACT_ADDRESS.toLowerCase() !== NATIVE_POLYGON_USDC, 'ROG_USDC_CONTRACT_ADDRESS_DEVE_ESSERE_CIRCLE_NATIVO_POLYGON');

  if (process.env.ROG_API_BASE_URL) issue(!validateHttpUrl(process.env.ROG_API_BASE_URL, { httpsInProduction: true }), 'ROG_API_BASE_URL_NON_VALIDO');
  for (const name of ['ROG_CROSS_INGRESS_URL', 'URANUS_CROSS_INGRESS_URL']) {
    if (process.env[name]) issue(!validateHttpUrl(process.env[name], { httpsInProduction: true }), `${name}_NON_VALIDO`);
  }

  if (process.env.CROSS_PLATFORM_SECRET) {
    issue(isProd && Buffer.byteLength(process.env.CROSS_PLATFORM_SECRET, 'utf8') < 32, 'CROSS_PLATFORM_SECRET_DEVE_ESSERE_DI_ALMENO_32_BYTE');
    issue(isProd && /change|example|password|your|genera/i.test(process.env.CROSS_PLATFORM_SECRET), 'CROSS_PLATFORM_SECRET_PLACEHOLDER_NON_AMMESSO');
  }
  for (const name of ['ROG_CROSS_PLATFORM_SECRET', 'URANUS_CROSS_PLATFORM_SECRET']) {
    if (process.env[name]) issue(isProd && Buffer.byteLength(process.env[name], 'utf8') < 32, `${name}_DEVE_ESSERE_DI_ALMENO_32_BYTE`);
  }

  const systemWallets = ['PHARAOH_FUND_A_WALLET', 'PHARAOH_TREASURY_WALLET']
    .map(name => process.env[name]).filter(Boolean).map(x => x.toLowerCase());
  if (systemWallets.length === 2 && new Set(systemWallets).size !== 2) missing.push('FONDO_A_E_CASSA_PHARAOH_DEVONO_ESSERE_DISTINTI');

  const treasuries = ['PHARAOH_TREASURY_WALLET', 'ROG_TREASURY_WALLET', 'URANUS_TREASURY_WALLET']
    .map(name => process.env[name]).filter(Boolean).map(x => x.toLowerCase());
  if (treasuries.length === 3 && new Set(treasuries).size !== 3) missing.push('CASSE_PHARAOH_ROG_URANUS_DEVONO_ESSERE_DISTINTE');

  const registryWorkerEnabled = String(process.env.PHARAOH_REGISTRY_WORKER_ENABLED || '0');
  issue(!['0','1'].includes(registryWorkerEnabled), 'PHARAOH_REGISTRY_WORKER_ENABLED_DEVE_ESSERE_0_O_1');
  issue(isProd && registryWorkerEnabled !== '1', 'PHARAOH_REGISTRY_WORKER_DEVE_ESSERE_ATTIVO_IN_PRODUZIONE');

  const workerEnabled = String(process.env.CROSS_OUTBOUND_WORKER_ENABLED || '0');
  issue(!['0','1'].includes(workerEnabled), 'CROSS_OUTBOUND_WORKER_ENABLED_DEVE_ESSERE_0_O_1');
  const workerInterval = Number(process.env.CROSS_OUTBOUND_WORKER_INTERVAL_MS || 60000);
  issue(!Number.isInteger(workerInterval) || workerInterval < 10000 || workerInterval > 3600000, 'CROSS_OUTBOUND_WORKER_INTERVAL_MS_NON_VALIDO');

  return { ok: missing.length === 0, missing: [...new Set(missing)], warnings: [...new Set(warnings)] };
}

// ============================================================
// 7. ERROR SANITIZATION — nessun leak interno
// ============================================================

/**
 * Sanitizza un errore per la risposta API.
 * In produzione non espone stack trace né path interni.
 */
function sanitizeError(err, isProd = process.env.NODE_ENV === 'production') {
  const message = err?.message || 'Errore interno';

  if (isProd) {
    // In produzione: espone solo messaggi "user-friendly" predefiniti
    // Non espone path, stack, dettagli DB o codice sorgente
    const safeMessages = [
      'wallet', 'txHash', 'obbligatorio', 'non trovato', 'gia registrat', 'già registrat',
      'gia partecipante', 'già partecipante', 'limite', 'Non autorizzato', 'timeout',
      'valido', 'Importo', 'Transazione', 'Mittente', 'Community ROG', 'iscrizione Community ROG',
      'donazione ROG', 'sessione', 'registrazione PharaohRegistry', 'conferma on-chain',
      'Carta Regalo', 'beneficiario', 'pagatore', 'giftId', 'ROG', 'URANUS', 'cross',
      'origine', 'firma HMAC', 'Cassa', 'riconciliazione', 'evento'
    ];
    const isSafe = safeMessages.some(s => message.toLowerCase().includes(s.toLowerCase()));
    return isSafe ? message : 'Si è verificato un errore. Riprovare più tardi.';
  }

  return message;
}

function httpStatusForError(error, fallback = 400) {
  const code = String(error?.code || '');
  const explicitStatus = Number(error?.httpStatus);
  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) return explicitStatus;
  if (error?.kycRequired || code === 'KYC_REQUIRED') return 403;
  if ([
    'ROG_COMMUNITY_REQUIRED', 'ROG_DONATION_REQUIRED', 'ROG_DONATION_PROOF_REQUIRED',
    'DIRECT_SESSION_WALLET_MISMATCH', 'GIFT_PAYER_MISMATCH', 'GIFT_BENEFICIARY_MISMATCH',
    'CROSS_ORIGIN_FORBIDDEN', 'CROSS_SOURCE_FORBIDDEN', 'CROSS_SOURCE_TREASURY_MISMATCH',
    'CROSS_DESTINATION_TREASURY_MISMATCH'
  ].includes(code)) return 403;
  if (code === 'CROSS_SIGNATURE_INVALID') return 401;
  if ([
    'BLOCKCHAIN_TX_REPLAY', 'ROG_COMMUNITY_REGISTRATION_UNVERIFIED',
    'DIRECT_SESSION_STATE_INVALID', 'DIRECT_SESSION_PROOF_CONFLICT',
    'GIFT_ID_CONFLICT', 'GIFT_PROOF_CONFLICT', 'GIFT_EVENT_REPLAY', 'GIFT_CANCELLED',
    'GIFT_ROG_PAYMENT_REQUIRED', 'GIFT_ROG_REGISTRATION_REQUIRED', 'GIFT_ROG_COMPLETION_REQUIRED',
    'GIFT_PHARAOH_PAYMENT_REQUIRED', 'GIFT_PROOF_INCOMPLETE', 'GIFT_BLOCK_ORDER_INVALID',
    'GIFT_ROG_READBACK_MISMATCH', 'GIFT_ROG_PAYER_MISMATCH', 'GIFT_ROG_BENEFICIARY_MISMATCH',
    'GIFT_ROG_POSITION_OWNER_MISMATCH', 'GIFT_ROG_POSITION_TYPE_MISMATCH', 'GIFT_ROG_RGX_OWNER_MISMATCH',
    'GIFT_ROG_RGX_NOT_VERIFIED', 'CROSS_EVENT_CONFLICT', 'CROSS_TX_REPLAY', 'CROSS_EVENT_REPLAY',
    'CROSS_CANCELLED', 'CROSS_OUTBOUND_RECONCILIATION_REQUIRED', 'CROSS_OUTBOUND_RECONCILE_CONFLICT',
    'RHA_CROSS_EVENT_CONFLICT', 'RHA_CROSS_OPERATION_CONFLICT'
  ].includes(code)) return 409;
  if (['DIRECT_SESSION_NOT_FOUND', 'GIFT_NOT_FOUND', 'CROSS_OUTBOUND_NOT_FOUND'].includes(code)) return 404;
  if ([
    'BLOCKCHAIN_CONFIRMATIONS_PENDING', 'BLOCKCHAIN_TX_PENDING_OR_NOT_FOUND', 'ROG_DONATION_PENDING',
    'ROG_DONATION_COMPLETION_PENDING', 'PHARAOH_REGISTRY_PENDING', 'GIFT_ROG_COMPLETION_PENDING',
    'CROSS_OUTBOUND_TX_PENDING'
  ].includes(code)) return 425;
  if ([
    'BLOCKCHAIN_RPC_ERROR', 'BLOCKCHAIN_WRONG_NETWORK', 'BLOCKCHAIN_PROOF_REQUIRED', 'PAYOUT_NOT_CONFIGURED',
    'PAYOUT_WALLET_MISMATCH', 'ROG_API_UNAVAILABLE', 'ROG_CONFIG_UNAVAILABLE', 'ROG_DONATION_CONFIG_UNAVAILABLE',
    'GIFT_COMMUNITY_REGISTRATION_UNVERIFIED', 'PHARAOH_REGISTRY_CONFIG_UNAVAILABLE',
    'PHARAOH_REGISTRY_BACKEND_ROLE_MISSING', 'PHARAOH_REGISTRY_WRONG_NETWORK', 'PHARAOH_REGISTRY_RECOVERY_FAILED',
    'CROSS_SECRET_UNAVAILABLE', 'CROSS_SECRET_WEAK', 'CROSS_OUTBOUND_RECEIVER_UNAVAILABLE',
    'CROSS_OUTBOUND_RPC_UNAVAILABLE', 'CROSS_OUTBOUND_NOTIFY_FAILED'
  ].includes(code)) return 503;
  return fallback;
}

const SENSITIVE_KEY_REGEX = /(^|_)(password|passwd|secret|private_key|private|api_key|apikey|admin_key|token|authorization)($|_)/i;

function isSensitiveKey(key) {
  return SENSITIVE_KEY_REGEX.test(String(key || ''));
}

function redactSecrets(value, depth = 0) {
  if (depth > 8) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    clean[key] = isSensitiveKey(key) ? '[REDACTED]' : redactSecrets(item, depth + 1);
  }
  return clean;
}

function assertNoSecretSetting(key, value) {
  if (isSensitiveKey(key)) {
    throw new Error('Le impostazioni amministrative non possono contenere segreti');
  }
  const visit = (item, depth = 0) => {
    if (depth > 8 || item === null || item === undefined) return;
    if (Array.isArray(item)) return item.forEach(child => visit(child, depth + 1));
    if (typeof item !== 'object') return;
    for (const [childKey, childValue] of Object.entries(item)) {
      if (isSensitiveKey(childKey)) {
        throw new Error('Le impostazioni amministrative non possono contenere segreti');
      }
      visit(childValue, depth + 1);
    }
  };
  visit(value);
}

function toPublicAccount(account) {
  if (!account) return account;
  const {
    wallet,
    nome,
    ticket_number,
    tipo,
    sigla,
    status,
    created_at,
    perpetui_rilasciati,
    gemelli_rilasciati,
    totale_percorsi,
    percorsi_primari,
    percorsi,
    percorso
  } = account;
  return {
    wallet,
    nome,
    ticket_number,
    tipo,
    sigla,
    status,
    created_at,
    ...(totale_percorsi !== undefined ? { totale_percorsi } : {}),
    ...(percorsi_primari !== undefined ? { percorsi_primari } : {}),
    ...(perpetui_rilasciati !== undefined ? { perpetui_rilasciati } : {}),
    ...(gemelli_rilasciati !== undefined ? { gemelli_rilasciati } : {}),
    ...(Array.isArray(percorsi) ? { percorsi } : {}),
    ...(percorso !== undefined ? { percorso } : {})
  };
}

function sanitizeLogDetail(detail) {
  let safe = String(detail || '').replace(/https?:\/\/[^\s]+/gi, '[URL_REDACTED]');
  const secretEnvNames = [
    'ADMIN_API_KEY',
    'PHARAOH_PAYOUT_PRIVATE_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TWILIO_TOKEN',
    'DATABASE_URL'
  ];
  for (const name of secretEnvNames) {
    const secret = process.env[name];
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe.slice(0, 1000);
}

// ============================================================
// 8. SECURITY EVENT LOGGING
// ============================================================

/**
 * Log di eventi di sicurezza con timestamp e IP.
 * Per eventi CRITICAL e rate limit invia anche alert Telegram.
 */
function securityLog(event, detail, ip = null) {
  const ts = new Date().toISOString();
  const safeDetail = sanitizeLogDetail(detail);
  console.log(`🔐 [SECURITY] ${ts} | ${event}${ip ? ` | IP: ${ip}` : ''} | ${safeDetail}`);

  // Invia alert Telegram per eventi critici (silenzioso se non configurato)
  try {
    const alerts = require('./alert-manager');
    if (event === 'ADMIN_UNAUTHORIZED') {
      alerts.alertAdminUnauthorized(ip || 'sconosciuto');
    } else if (event.includes('RATE_LIMIT')) {
      alerts.alertRateLimit(ip || 'sconosciuto', event);
    } else if (event === 'UNHANDLED_ERROR' || event === 'KILL_SWITCH') {
      alerts.sendAlert('CRITICAL', event, safeDetail);
    }
  } catch (_) { /* alert opzionale, non blocca */ }
}

async function writeApiAudit({ requestId, method, path, statusCode, authenticated, ip, durationMs }) {
  const ipHash = ip
    ? crypto.createHash('sha256').update(String(ip)).digest('hex')
    : null;
  const pg = require('./pg-connection-manager');
  await pg.query(
    `INSERT INTO api_audit_log
       (request_id, method, path, status_code, admin_authenticated, ip_hash, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [requestId, method, path, statusCode, authenticated, ipHash, durationMs]
  );
}

function adminAuditMiddleware(req, res, next) {
  const privilegedPaths = new Set([
    '/api/sistema/init',
    '/api/donazione/entrata',
    '/api/donazione/pharaoh'
  ]);
  if (!req.path.startsWith('/api/admin') && !privilegedPaths.has(req.path)) return next();
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.once('finish', () => {
    writeApiAudit({
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      authenticated: req.adminAuthenticated === true,
      ip: req.ip,
      durationMs: Date.now() - startedAt
    }).catch(error => {
      console.error('⚠️ [AUDIT] Persistenza audit API fallita:', sanitizeLogDetail(error.message));
    });
  });
  next();
}

// ============================================================
// 9. CORS HARDENING MIDDLEWARE
// ============================================================

/**
 * Middleware che avverte se CORS è wildcard in produzione.
 */
function corsHardeningCheck() {
  if (process.env.NODE_ENV === 'production' && process.env.CORS_ORIGIN === '*') {
    console.error('🚨 [SECURITY] ATTENZIONE: CORS_ORIGIN=* in PRODUZIONE è pericoloso!');
    console.error('   Impostare CORS_ORIGIN con le origini specifiche del frontend.');
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Middleware
  helmetMiddleware,
  generalLimiter,
  donationLimiter,
  initLimiter,
  requestTimeout,
  requireAdminKey,

  // Validators
  validateWallet,
  validateTxHash,
  sanitizeString,
  sanitizeNome,
  validatePositiveInt,
  validateIntegerInRange,
  safeSecretEqual,
  redactSecrets,
  assertNoSecretSetting,
  toPublicAccount,

  // Utils
  validateEnvironment,
  sanitizeError,
  httpStatusForError,
  securityLog,
  sanitizeLogDetail,
  adminAuditMiddleware,
  writeApiAudit,
  corsHardeningCheck,

  // Regexes (esportate per uso esterno)
  WALLET_REGEX,
  TXHASH_REGEX,
  NATIVE_POLYGON_USDC
};

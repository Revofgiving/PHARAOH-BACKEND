/**
 * 💸 PHARAOH - Payout Manager
 *
 * Gestisce il flusso dei doni pendenti (creazione, accettazione, invio, scadenza).
 */

const { ethers } = require('ethers');
const pg = require('./pg-connection-manager');
const pharaohRegistry = require('./pharaoh-registry-manager');

const USDC_DECIMALS = 6;
const ERC20_ABI = [
  'function transfer(address to, uint256 value) public returns (bool)'
];
const PENDING_GIFT_DAYS = 180;
const GLOBAL_PAYOUT_SIGNER_LOCK = 'PHARAOH:PAYOUT:SIGNER';
const WALLET_REGEX = /^0x[a-fA-F0-9]{40}$/;

function normalizeWallet(wallet, fieldName = 'wallet') {
  if (typeof wallet !== 'string' || !WALLET_REGEX.test(wallet.trim())) {
    throw new Error(`${fieldName} non configurato o non valido`);
  }
  return wallet.trim().toLowerCase();
}

function isExpired(expiresAt, now = Date.now()) {
  const timestamp = new Date(expiresAt).getTime();
  return !Number.isFinite(timestamp) || timestamp <= Number(now);
}

function buildEventKey({ livello, turno, wallet }) {
  const w = wallet.toLowerCase();
  return `PHARAOH:L${livello}:${turno}:${w}:USCITA_L${livello}`;
}

async function addAudit(donoPendenteId, evento, dettagli = {}, client = null) {
  const query = client ? client.query.bind(client) : pg.query.bind(pg);
  await query(
    `INSERT INTO audit_doni_pendenti (dono_pendente_id, evento, dettagli)
     VALUES ($1, $2, $3::jsonb)`,
    [donoPendenteId, evento, JSON.stringify(dettagli || {})]
  );
}

function getProvider() {
  const rpcUrl = process.env.POLYGON_RPC_URL;
  if (!rpcUrl) throw new Error('POLYGON_RPC_URL non configurata');
  return new ethers.JsonRpcProvider(rpcUrl);
}

function getPayoutWallet() {
  const privateKey = process.env.PHARAOH_PAYOUT_PRIVATE_KEY;
  if (!privateKey) {
    const err = new Error('PAYOUT_NOT_CONFIGURED: PHARAOH_PAYOUT_PRIVATE_KEY mancante');
    err.code = 'PAYOUT_NOT_CONFIGURED';
    throw err;
  }
  const provider = getProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  const expected = normalizeWallet(
    process.env.PHARAOH_TREASURY_WALLET,
    'PHARAOH_TREASURY_WALLET'
  );
  if (wallet.address.toLowerCase() !== expected) {
    const err = new Error('PAYOUT_WALLET_MISMATCH: chiave privata non corrisponde alla Cassa PHARAOH');
    err.code = 'PAYOUT_WALLET_MISMATCH';
    throw err;
  }
  return wallet;
}

function shouldBypassPayout() {
  return process.env.NODE_ENV !== 'production' && process.env.PAYOUT_DEV_MODE === '1';
}

async function sendUsdc({ dono }) {
  if (!dono?.id) throw new Error('PAYOUT_ACCEPTED_RECORD_REQUIRED');
  return require('./payout-economic-adapter').prepareAndRun(dono);
}

async function createPendingGift({
  wallet,
  accountId = null,
  accountSigla = null,
  importo,
  livello,
  tipoUscita,
  tipoAccount,
  turno,
  dettagli = {},
  eventKey: explicitEventKey = null
}, client = null) {
  const amount = Number(importo);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const w = normalizeWallet(wallet);
  const eventKey = explicitEventKey || buildEventKey({ livello, turno, wallet: w });
  const queryOne = client
    ? async (sql, params) => (await client.query(sql, params)).rows[0] || null
    : pg.queryOne;
  if (!client) throw new Error('PAYOUT_CREATION_TRANSACTION_REQUIRED');
  await require('./economic-ledger').configuredLedger(client).ready();
  const existing = await queryOne('SELECT * FROM doni_pendenti WHERE event_key=$1 FOR UPDATE',[eventKey]);
  if (existing) {
    if (existing.wallet !== w || Number(existing.importo) !== amount || Number(existing.livello) !== Number(livello)
      || String(existing.account_id) !== String(accountId) || String(existing.account_sigla || '') !== String(accountSigla || '')
      || String(existing.tipo_uscita) !== String(tipoUscita) || String(existing.tipo_account || '') !== String(tipoAccount || ''))
      throw new Error('PAYOUT_EXISTING_EVENT_CONFLICT');
    const details = typeof existing.dettagli === 'string' ? JSON.parse(existing.dettagli) : existing.dettagli;
    if (details?.economicReserveBucket !== dettagli?.economicReserveBucket) throw new Error('PAYOUT_EXISTING_RESERVE_CONFLICT');
    return existing;
  }
  await require('./payout-economic-adapter').validateNewGift({wallet:w,accountId,importo,livello,eventKey,dettagli},client);
  const row = await queryOne(
    `WITH ins AS (
       INSERT INTO doni_pendenti
         (event_key, wallet, account_id, account_sigla, importo, livello, tipo_uscita, tipo_account, expires_at, dettagli)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($10 * INTERVAL '1 day'), $9::jsonb)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING *, true AS inserted
     )
     SELECT * FROM ins
     UNION ALL
     SELECT *, false AS inserted FROM doni_pendenti
     WHERE event_key = $1 AND NOT EXISTS (SELECT 1 FROM ins)
     LIMIT 1`,
    [
      eventKey,
      w,
      accountId,
      accountSigla || null,
      amount,
      livello,
      tipoUscita,
      tipoAccount || null,
      JSON.stringify(dettagli || {}),
      PENDING_GIFT_DAYS
    ]
  );

  if (row && (row.wallet !== w || Number(row.importo) !== amount || Number(row.livello) !== Number(livello))) throw new Error('PAYOUT_EXISTING_EVENT_CONFLICT');
  if (row && accountId != null && Number(row.account_id) !== Number(accountId)) {
    throw new Error(`Payout ${eventKey} gia associato a un account differente`);
  }
  if (row && accountSigla && String(row.account_sigla || '') !== String(accountSigla)) {
    throw new Error(`Payout ${eventKey} gia associato a una sigla differente`);
  }

  if (row?.inserted) {
    await addAudit(row.id, 'CREATED', { eventKey, livello, turno, accountId, accountSigla }, client);
  }

  return row;
}

async function ensureKycIfRequired(dono) {
  if (process.env.NODE_ENV !== 'production') return;
  if (Number(dono.livello) !== 3) return;
  if (String(dono.tipo_account || '').toUpperCase() === 'FONDO') return;

  const kycManager = require('./zk-kyc-manager');
  const ok = await kycManager.isWalletKycVerified(dono.wallet);
  if (!ok) {
    const err = new Error('KYC_REQUIRED: verifica identità non completata');
    err.kycRequired = true;
    throw err;
  }
}

async function finalizeAttempt(donoId, outcome, dettagli = {}) {
  const client = await pg.getClient();
  try {
    await client.query('BEGIN');
    const current = (await client.query(
      'SELECT * FROM doni_pendenti WHERE id = $1 FOR UPDATE',
      [donoId]
    )).rows[0];
    if (!current) throw new Error('Dono pendente non trovato durante la finalizzazione');
    if (current.status === 'SENT') {
      await client.query('COMMIT');
      return current;
    }
    if (current.status !== 'PROCESSING') {
      throw new Error(`Stato payout non finalizzabile: ${current.status}`);
    }

    let updated;
    if (outcome === 'SENT') {
      updated = (await client.query(
        `UPDATE doni_pendenti
         SET status = 'SENT', tx_hash = $1, sent_at = NOW(), errore = NULL
         WHERE id = $2 AND status = 'PROCESSING' AND tx_hash IS NULL
         RETURNING *`,
        [dettagli.txHash, donoId]
      )).rows[0];
    } else if (outcome === 'FAILED') {
      updated = (await client.query(
        `UPDATE doni_pendenti
         SET status = 'FAILED', errore = $1
         WHERE id = $2 AND status = 'PROCESSING' AND tx_hash IS NULL
         RETURNING *`,
        [dettagli.errore, donoId]
      )).rows[0];
    } else {
      throw new Error(`Esito payout non valido: ${outcome}`);
    }
    if (!updated) throw new Error('Transizione payout concorrente non completata');
    await addAudit(donoId, outcome, dettagli, client);
    await client.query('COMMIT');
    return updated;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function ensurePayoutRegistry(payout, dependencies = {}) {
  if (!payout || String(payout.status) !== 'SENT') return payout;
  if (!payout.tx_hash || !/^0x[a-fA-F0-9]{64}$/.test(String(payout.tx_hash))) {
    // PAYOUT_DEV_MODE usa un hash sintetico e non deve scrivere sul Registry.
    return { ...payout, registrySkipped: true };
  }
  if (payout.registry_confirmed_at && payout.registry_tx_id != null) return payout;

  try {
    const registry = await pharaohRegistry.registerPayoutOutgoing({
      payout,
      onSubmitted: async (registryTxHash) => {
        await pg.query(
          `UPDATE doni_pendenti
              SET registry_tx_hash=$2, registry_last_error=NULL
            WHERE id=$1`,
          [payout.id, registryTxHash]
        );
      }
    }, dependencies);
    return await pg.queryOne(
      `UPDATE doni_pendenti
          SET registry_tx_hash=$2,
              registry_tx_id=$3,
              registry_block_number=$4,
              registry_confirmed_at=COALESCE(registry_confirmed_at,NOW()),
              registry_last_error=NULL
        WHERE id=$1
        RETURNING *`,
      [payout.id, registry.txHash, registry.txId, registry.blockNumber]
    );
  } catch (error) {
    const message = String(error?.message || error || 'PharaohRegistry payout error').slice(0, 1000);
    await pg.query(
      `UPDATE doni_pendenti SET registry_last_error=$2 WHERE id=$1`,
      [payout.id, message]
    ).catch(() => null);
    return { ...payout, registryPending: true, registryError: message };
  }
}

async function acceptPendingGift({ id, wallet }) {
  const normalizedWallet = normalizeWallet(wallet);
  const client = await pg.getClient();
  let dono;
  try {
    await client.query('BEGIN');
    await require('./economic-ledger').configuredLedger(client).ready();
    const row = await client.query(
      `SELECT * FROM doni_pendenti WHERE id = $1 FOR UPDATE`,
      [id]
    );
    dono = row.rows[0];
    if (!dono) throw new Error('Dono pendente non trovato');
    if (dono.wallet !== normalizedWallet) throw new Error('Wallet non autorizzato');
    if (dono.status !== 'PENDING') throw new Error('Dono non accettabile');
    if (dono.tx_hash) throw new Error('Dono già inviato');
    if (isExpired(dono.expires_at)) throw new Error('Dono scaduto');

    await ensureKycIfRequired(dono);

    await client.query(
      `UPDATE doni_pendenti
       SET status = 'PROCESSING',
           accepted_at = COALESCE(accepted_at, NOW()),
           processing_started_at = NOW(),
           last_attempt_at = NOW(),
           attempts = attempts + 1,
           errore = NULL
       WHERE id = $1 AND status = 'PENDING' AND tx_hash IS NULL`,
      [id]
    );
    await client.query(
      `INSERT INTO audit_doni_pendenti (dono_pendente_id, evento, dettagli)
       VALUES ($1, $2, $3::jsonb)`,
      [id, 'PROCESSING', JSON.stringify({ reason: 'ACCETTA' })]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    throw e;
  }
  client.release();

  let result;
  try {
    result = await sendUsdc({ dono });
  } catch (err) {
    await finalizeAttempt(dono.id, 'FAILED', { errore: err.message });
    throw err;
  }
  // Se la finalizzazione DB fallisce dopo l'invio on-chain, il record resta
  // PROCESSING: non viene marcato FAILED e quindi non può essere ritentato
  // automaticamente causando un secondo trasferimento.
  if (result.pending) return {...dono,status:'PROCESSING',tx_hash:result.txHash,pending:true,simulated:false};
  const updated = await finalizeAttempt(dono.id, 'SENT', {
    txHash: result.txHash,
    simulated: result.simulated
  });
  const registered = await ensurePayoutRegistry(updated);
  return { ...registered, simulated: result.simulated };
}

async function retryPendingGift({ id }) {
  const client = await pg.getClient();
  let dono;
  try {
    await client.query('BEGIN');
    await require('./economic-ledger').configuredLedger(client).ready();
    const row = await client.query(
      `SELECT * FROM doni_pendenti WHERE id = $1 FOR UPDATE`,
      [id]
    );
    dono = row.rows[0];
    if (!dono) throw new Error('Dono pendente non trovato');
    if (dono.status !== 'FAILED') throw new Error('Retry consentito solo per FAILED');
    if (dono.tx_hash) throw new Error('Dono già inviato');
    if (isExpired(dono.expires_at)) throw new Error('Dono scaduto: retry non consentito');

    await ensureKycIfRequired(dono);

    await client.query(
      `UPDATE doni_pendenti
       SET status = 'PROCESSING',
           processing_started_at = NOW(),
           last_attempt_at = NOW(),
           attempts = attempts + 1,
           errore = NULL
       WHERE id = $1 AND status = 'FAILED' AND tx_hash IS NULL`,
      [id]
    );
    await client.query(
      `INSERT INTO audit_doni_pendenti (dono_pendente_id, evento, dettagli)
       VALUES ($1, $2, $3::jsonb)`,
      [id, 'PROCESSING', JSON.stringify({ reason: 'RETRY' })]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    throw e;
  }
  client.release();

  let result;
  try {
    result = await sendUsdc({ dono });
  } catch (err) {
    await finalizeAttempt(dono.id, 'FAILED', { errore: err.message });
    throw err;
  }
  if (result.pending) return {...dono,status:'PROCESSING',tx_hash:result.txHash,pending:true,simulated:false};
  const updated = await finalizeAttempt(dono.id, 'SENT', {
    txHash: result.txHash,
    simulated: result.simulated
  });
  const registered = await ensurePayoutRegistry(updated);
  return { ...registered, simulated: result.simulated };
}

async function processPendingRegistry(limit = 10, dependencies = {}) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const rows = await pg.queryMany(
    `SELECT * FROM doni_pendenti
      WHERE status='SENT'
        AND tx_hash IS NOT NULL
        AND registry_confirmed_at IS NULL
      ORDER BY sent_at ASC NULLS LAST, id ASC
      LIMIT $1`,
    [safeLimit]
  );
  const results = [];
  for (const row of rows) {
    const updated = await ensurePayoutRegistry(row, dependencies);
    results.push({
      id: row.id,
      success: Boolean(updated?.registry_confirmed_at) || updated?.registrySkipped === true,
      registryPending: updated?.registryPending === true,
      registryTxHash: updated?.registry_tx_hash || null,
      registryTxId: updated?.registry_tx_id == null ? null : Number(updated.registry_tx_id),
      error: updated?.registryError || null
    });
  }
  return { success: true, processed: results.length, results };
}

async function expirePendingGifts(options) {
  return require('./payout-economic-adapter').expireUnsent(options);
}

async function getPendingGiftsByWallet(wallet) {
  const w = normalizeWallet(wallet);
  const rows = await pg.queryMany(
    `SELECT id, event_key, wallet, importo, livello, tipo_uscita, tipo_account,
            status, created_at, expires_at, accepted_at, sent_at, expired_at, tx_hash, errore, dettagli,
            registry_tx_hash, registry_tx_id, registry_block_number, registry_confirmed_at, registry_last_error
     FROM doni_pendenti
     WHERE wallet = $1
     ORDER BY created_at DESC`,
    [w]
  );

  const groups = {
    PENDING: [],
    PROCESSING: [],
    SENT: [],
    EXPIRED: [],
    FAILED: [],
    ACCEPTED: [],
    CANCELLED: []
  };

  rows.forEach((r) => {
    if (!groups[r.status]) groups[r.status] = [];
    groups[r.status].push(r);
  });

  return { wallet: w, rows, groups };
}


module.exports = {
  GLOBAL_PAYOUT_SIGNER_LOCK,
  buildEventKey,
  createPendingGift,
  acceptPendingGift,
  retryPendingGift,
  expirePendingGifts,
  processPendingRegistry,
  getPendingGiftsByWallet,
  ensurePayoutRegistry,
  isExpired,
  normalizeWallet,
  PENDING_GIFT_DAYS
};

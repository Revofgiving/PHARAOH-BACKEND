'use strict';

const crypto = require('crypto');
const pg = require('./pg-connection-manager');

const WALLET_RE = /^0x[a-f0-9]{40}$/;
const HASH_RE = /^0x[a-f0-9]{64}$/;
const SESSION_RE = /^0x[a-f0-9]{64}$/;

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeWallet(value) {
  const wallet = String(value || '').trim().toLowerCase();
  if (!WALLET_RE.test(wallet)) throw makeError('Wallet non valido', 'DIRECT_SESSION_WALLET_INVALID');
  return wallet;
}

function normalizeHash(value, label = 'txHash') {
  const hash = String(value || '').trim().toLowerCase();
  if (!HASH_RE.test(hash)) throw makeError(`${label} non valido`, 'DIRECT_SESSION_HASH_INVALID');
  return hash;
}

function normalizeSessionRef(value) {
  const ref = String(value || '').trim().toLowerCase();
  if (!SESSION_RE.test(ref)) throw makeError('sessionRef non valido', 'DIRECT_SESSION_REF_INVALID');
  return ref;
}

function asJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function publicSession(row) {
  if (!row) return null;
  return {
    sessionRef: row.session_ref,
    wallet: row.wallet,
    status: row.status,
    rogAmountUsdc: Number(row.rog_amount_usdc || 0),
    rogUsdcTxHash: row.rog_usdc_tx_hash || null,
    rogRegisterTxHash: row.rog_register_tx_hash || null,
    rogDonationId: row.rog_donation_id || null,
    rogPaymentConfirmedAt: row.rog_payment_confirmed_at || null,
    rogFulfillmentStatus: row.rog_fulfillment_status || null,
    rogHumanPosition: row.rog_human_position == null ? null : Number(row.rog_human_position),
    rogConfirmedAt: row.rog_confirmed_at || null,
    pharaohAmountUsdc: row.pharaoh_amount_usdc == null ? null : Number(row.pharaoh_amount_usdc),
    pharaohTxHash: row.pharaoh_tx_hash || null,
    registryTxHash: row.registry_tx_hash || null,
    registryTxId: row.registry_session_id == null ? null : Number(row.registry_session_id),
    positionResult: row.position_result || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null
  };
}

async function createSession(wallet, rogAmountUsdc = 2, client = null) {
  const w = normalizeWallet(wallet);
  const amount = Number(rogAmountUsdc);
  if (amount !== 2) {
    throw makeError('DIRECT richiede esattamente 2 USDC ROG per sessione', 'DIRECT_SESSION_ROG_AMOUNT_INVALID');
  }
  const ref = `0x${crypto.randomBytes(32).toString('hex')}`;
  const runner = client || pg;
  const result = await runner.query(
    `INSERT INTO direct_donation_sessions (session_ref, wallet, rog_amount_usdc)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [ref, w, amount]
  );
  return result.rows[0];
}

async function getSession(sessionRef, client = null, { forUpdate = false } = {}) {
  const ref = normalizeSessionRef(sessionRef);
  const runner = client || pg;
  const result = await runner.query(
    `SELECT * FROM direct_donation_sessions WHERE session_ref = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [ref]
  );
  return result.rows[0] || null;
}

async function requireSession(sessionRef, wallet, client = null, opts = {}) {
  const row = await getSession(sessionRef, client, opts);
  if (!row) throw makeError('Sessione di donazione non trovata', 'DIRECT_SESSION_NOT_FOUND');
  const w = normalizeWallet(wallet);
  if (String(row.wallet).toLowerCase() !== w) {
    throw makeError('La sessione non appartiene al wallet collegato', 'DIRECT_SESSION_WALLET_MISMATCH');
  }
  return row;
}

async function updateSession(sessionRef, fields, client = null) {
  const ref = normalizeSessionRef(sessionRef);
  const allowed = new Set([
    'status', 'rog_usdc_tx_hash', 'rog_register_tx_hash', 'rog_donation_id', 'rog_proof', 'rog_result',
    'rog_payment_confirmed_at', 'rog_registration_candidate_tx_hash', 'rog_registration_candidate_donation_id',
    'rog_registration_candidate_at', 'rog_fulfillment_status', 'rog_human_position',
    'rog_fulfillment_retry_count', 'rog_fulfillment_last_error', 'rog_fulfillment_next_retry_at',
    'rog_fulfillment_updated_at', 'rog_confirmed_at',
    'pharaoh_amount_usdc', 'pharaoh_tx_hash', 'pharaoh_proof', 'pharaoh_verified_at',
    'registry_tx_hash', 'registry_session_id', 'registry_block_number', 'registry_confirmed_at',
    'position_result', 'last_error', 'completed_at'
  ]);
  const entries = Object.entries(fields || {}).filter(([key]) => allowed.has(key));
  if (!entries.length) return getSession(ref, client);
  const sets = entries.map(([key], i) => `${key} = $${i + 2}`);
  const values = entries.map(([, value]) => value);
  const runner = client || pg;
  let result;
  try {
    result = await runner.query(
      `UPDATE direct_donation_sessions
          SET ${sets.join(', ')}, updated_at = NOW()
        WHERE session_ref = $1
        RETURNING *`,
      [ref, ...values]
    );
  } catch (error) {
    if (String(error?.code || '') === '23505') {
      throw makeError(
        'Una prova blockchain della sessione risulta gia associata a un altro ingresso',
        'DIRECT_SESSION_PROOF_CONFLICT'
      );
    }
    throw error;
  }
  if (!result.rows[0]) throw makeError('Sessione di donazione non trovata', 'DIRECT_SESSION_NOT_FOUND');
  return result.rows[0];
}

async function recordRogPaymentConfirmed({ sessionRef, wallet, amountUsdc, usdcTxHash, proof }, client = null) {
  const row = await requireSession(sessionRef, wallet, client);
  const amount = Number(amountUsdc);
  if (amount !== 2) throw makeError('Il gate ROG DIRECT richiede esattamente 2 USDC', 'DIRECT_SESSION_ROG_AMOUNT_INVALID');
  const canonicalHash = normalizeHash(usdcTxHash, 'rogUsdcTxHash');
  if (row.rog_usdc_tx_hash && String(row.rog_usdc_tx_hash).toLowerCase() !== canonicalHash) {
    throw makeError('La sessione e gia associata a una tx ROG differente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }

  const existingProof = asJsonObject(row.rog_proof);
  const earlyStatuses = new Set(['COMMUNITY_CONFIRMED', 'ROG_CONFIRMING', 'ROG_PAYMENT_CONFIRMED']);
  const nextStatus = earlyStatuses.has(String(row.status)) ? 'ROG_PAYMENT_CONFIRMED' : row.status;
  const nextFulfillment = row.rog_confirmed_at || row.rog_result
    ? 'COMPLETED'
    : (row.rog_register_tx_hash && row.rog_donation_id ? 'REGISTERED' : 'WAITING_REGISTRATION');

  return updateSession(sessionRef, {
    status: nextStatus,
    rog_usdc_tx_hash: canonicalHash,
    rog_proof: { ...existingProof, usdc: proof || existingProof.usdc || null },
    rog_payment_confirmed_at: row.rog_payment_confirmed_at || new Date().toISOString(),
    rog_fulfillment_status: nextFulfillment,
    rog_fulfillment_next_retry_at: nextFulfillment === 'REGISTERED' ? new Date().toISOString() : null,
    rog_fulfillment_updated_at: new Date().toISOString(),
    last_error: null
  }, client);
}

async function recordRogRegistrationCandidate({ sessionRef, wallet, registerTxHash, donationId }, client = null) {
  const row = await requireSession(sessionRef, wallet, client);
  if (!row.rog_usdc_tx_hash || !row.rog_payment_confirmed_at) {
    throw makeError('Prima deve essere confermato on-chain il pagamento di 2 USDC alla Cassa ROG', 'ROG_PAYMENT_REQUIRED');
  }
  const canonicalHash = normalizeHash(registerTxHash, 'rogRegisterTxHash');
  const id = String(donationId || '').trim();
  if (!/^\d+$/.test(id) || BigInt(id) <= 0n) throw makeError('rogDonationId non valido', 'ROG_DONATION_ID_INVALID');
  if (row.rog_registration_candidate_tx_hash && String(row.rog_registration_candidate_tx_hash).toLowerCase() !== canonicalHash) {
    throw makeError('La sessione e gia associata a una registerDonation candidate differente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }
  if (row.rog_registration_candidate_donation_id && String(row.rog_registration_candidate_donation_id) !== id) {
    throw makeError('La sessione e gia associata a un donationId candidate differente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }
  return updateSession(sessionRef, {
    rog_registration_candidate_tx_hash: canonicalHash,
    rog_registration_candidate_donation_id: id,
    rog_registration_candidate_at: row.rog_registration_candidate_at || new Date().toISOString(),
    rog_fulfillment_status: row.rog_fulfillment_status === 'COMPLETED' ? 'COMPLETED' : 'WAITING_REGISTRATION',
    rog_fulfillment_next_retry_at: row.rog_fulfillment_status === 'COMPLETED' ? null : new Date().toISOString(),
    rog_fulfillment_updated_at: new Date().toISOString()
  }, client);
}

async function recordRogRegistration({ sessionRef, wallet, registerTxHash, donationId, proof }, client = null) {
  const row = await requireSession(sessionRef, wallet, client);
  if (!row.rog_usdc_tx_hash || !row.rog_payment_confirmed_at) {
    throw makeError('Prima deve essere confermato on-chain il pagamento di 2 USDC alla Cassa ROG', 'ROG_PAYMENT_REQUIRED');
  }
  const canonicalHash = normalizeHash(registerTxHash, 'rogRegisterTxHash');
  const id = String(donationId || '').trim();
  if (!/^\d+$/.test(id) || BigInt(id) <= 0n) throw makeError('rogDonationId non valido', 'ROG_DONATION_ID_INVALID');
  if (row.rog_register_tx_hash && String(row.rog_register_tx_hash).toLowerCase() !== canonicalHash) {
    throw makeError('La sessione e gia associata a una registerDonation differente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }
  if (row.rog_donation_id && String(row.rog_donation_id) !== id) {
    throw makeError('La sessione e gia associata a un donationId differente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }

  const existingProof = asJsonObject(row.rog_proof);
  return updateSession(sessionRef, {
    rog_register_tx_hash: canonicalHash,
    rog_donation_id: id,
    rog_registration_candidate_tx_hash: canonicalHash,
    rog_registration_candidate_donation_id: id,
    rog_proof: { ...existingProof, registration: proof || existingProof.registration || null },
    rog_fulfillment_status: row.rog_fulfillment_status === 'COMPLETED' ? 'COMPLETED' : 'REGISTERED',
    rog_fulfillment_last_error: null,
    rog_fulfillment_next_retry_at: row.rog_fulfillment_status === 'COMPLETED' ? null : new Date().toISOString(),
    rog_fulfillment_updated_at: new Date().toISOString(),
    last_error: null
  }, client);
}

function extractHumanPosition(rogResult, expectedWallet = null) {
  const completion = rogResult?.completion || rogResult || {};
  const positions = Array.isArray(completion?.positions?.posizioni)
    ? completion.positions.posizioni
    : Array.isArray(completion?.posizioni)
      ? completion.posizioni
      : [];
  const wallet = expectedWallet ? normalizeWallet(expectedWallet) : null;
  const human = positions.find((position) => {
    if (String(position?.tipo || '').toUpperCase() !== 'HUMAN') return false;
    if (!wallet) return true;
    try { return normalizeWallet(position?.wallet) === wallet; } catch (_) { return false; }
  });
  const value = Number(human?.posizione);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function markRogFulfillmentProcessing(sessionRef, client = null) {
  const row = await getSession(sessionRef, client);
  if (!row) throw makeError('Sessione di donazione non trovata', 'DIRECT_SESSION_NOT_FOUND');
  if (row.rog_fulfillment_status === 'COMPLETED') return row;
  return updateSession(sessionRef, {
    rog_fulfillment_status: 'PROCESSING',
    rog_fulfillment_updated_at: new Date().toISOString(),
    rog_fulfillment_last_error: null
  }, client);
}

async function recordRogFulfillmentCompleted({ sessionRef, wallet, rogResult }, client = null) {
  const row = await requireSession(sessionRef, wallet, client);
  const humanPosition = extractHumanPosition(rogResult, wallet);
  if (!Number.isSafeInteger(humanPosition) || humanPosition <= 0) {
    throw makeError(
      'ROG ha dichiarato COMPLETED ma non ha restituito una posizione HUMAN valida per il wallet della sessione',
      'DIRECT_ROG_HUMAN_POSITION_REQUIRED'
    );
  }
  return updateSession(sessionRef, {
    rog_result: rogResult || null,
    rog_human_position: humanPosition,
    rog_confirmed_at: row.rog_confirmed_at || new Date().toISOString(),
    rog_fulfillment_status: 'COMPLETED',
    rog_fulfillment_last_error: null,
    rog_fulfillment_next_retry_at: null,
    rog_fulfillment_updated_at: new Date().toISOString(),
    last_error: null
  }, client);
}

async function recordRogFulfillmentError(sessionRef, error, client = null) {
  const row = await getSession(sessionRef, client);
  if (!row) return null;
  const retries = Number(row.rog_fulfillment_retry_count || 0) + 1;
  const delayMs = Math.min(15 * 60 * 1000, 15000 * (2 ** Math.min(retries - 1, 6)));
  const nextRetry = new Date(Date.now() + delayMs).toISOString();
  const message = String(error?.message || error || 'Errore ROG').slice(0, 1000);
  return updateSession(sessionRef, {
    rog_fulfillment_status: 'RETRY',
    rog_fulfillment_retry_count: retries,
    rog_fulfillment_last_error: message,
    rog_fulfillment_next_retry_at: nextRetry,
    rog_fulfillment_updated_at: new Date().toISOString()
  }, client).catch(() => null);
}

async function listRogFulfillmentPending(limit = 5, client = null) {
  const runner = client || pg;
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 5));
  const result = await runner.query(
    `SELECT *
       FROM direct_donation_sessions
      WHERE rog_payment_confirmed_at IS NOT NULL
        AND (
          (rog_fulfillment_status = 'WAITING_REGISTRATION'
           AND rog_registration_candidate_tx_hash IS NOT NULL
           AND rog_registration_candidate_donation_id IS NOT NULL)
          OR rog_fulfillment_status IN ('REGISTERED','RETRY')
          OR (rog_fulfillment_status = 'PROCESSING'
              AND COALESCE(rog_fulfillment_updated_at, updated_at) < NOW() - INTERVAL '2 minutes')
        )
        AND (rog_fulfillment_next_retry_at IS NULL OR rog_fulfillment_next_retry_at <= NOW())
      ORDER BY COALESCE(rog_fulfillment_next_retry_at, created_at) ASC
      LIMIT $1`,
    [safeLimit]
  );
  return result.rows || [];
}

// Compatibilita con il vecchio flusso: usata da sessioni storiche gia completate.
async function recordRogConfirmed({ sessionRef, wallet, amountUsdc, usdcTxHash, registerTxHash, donationId, proof, rogResult }, client = null) {
  await recordRogPaymentConfirmed({ sessionRef, wallet, amountUsdc, usdcTxHash, proof: proof?.usdc || proof }, client);
  await recordRogRegistration({ sessionRef, wallet, registerTxHash, donationId, proof: proof?.registration || null }, client);
  return recordRogFulfillmentCompleted({ sessionRef, wallet, rogResult }, client);
}

async function recordPharaohVerified({ sessionRef, wallet, amountUsdc, txHash, proof }, client = null) {
  const row = await requireSession(sessionRef, wallet, client);
  if (!['ROG_PAYMENT_CONFIRMED', 'ROG_CONFIRMED', 'PHARAOH_VERIFIED', 'REGISTRY_SUBMITTED', 'REGISTRY_CONFIRMED'].includes(row.status)) {
    throw makeError('Il pagamento ROG da 2 USDC della sessione non e confermato', 'ROG_PAYMENT_REQUIRED');
  }
  if (!row.rog_usdc_tx_hash || !row.rog_payment_confirmed_at) {
    throw makeError('Prova on-chain del pagamento ROG mancante', 'ROG_PAYMENT_PROOF_REQUIRED');
  }
  return updateSession(sessionRef, {
    status: ['ROG_PAYMENT_CONFIRMED', 'ROG_CONFIRMED'].includes(row.status) ? 'PHARAOH_VERIFIED' : row.status,
    pharaoh_amount_usdc: Number(amountUsdc),
    pharaoh_tx_hash: normalizeHash(txHash, 'pharaohTxHash'),
    pharaoh_proof: proof || null,
    pharaoh_verified_at: row.pharaoh_verified_at || new Date().toISOString(),
    last_error: null
  }, client);
}

async function recordRegistrySubmitted({ sessionRef, txHash }, client = null) {
  return updateSession(sessionRef, {
    status: 'REGISTRY_SUBMITTED',
    registry_tx_hash: normalizeHash(txHash, 'registryTxHash'),
    last_error: null
  }, client);
}

async function recordRegistryConfirmed({ sessionRef, txHash, txId, blockNumber }, client = null) {
  return updateSession(sessionRef, {
    status: 'REGISTRY_CONFIRMED',
    registry_tx_hash: normalizeHash(txHash, 'registryTxHash'),
    registry_session_id: Number(txId),
    registry_block_number: Number(blockNumber),
    registry_confirmed_at: new Date().toISOString(),
    last_error: null
  }, client);
}

async function markPositionAssigned({ sessionRef, result }, client = null) {
  return updateSession(sessionRef, {
    status: 'POSITION_ASSIGNED',
    position_result: result,
    completed_at: new Date().toISOString(),
    last_error: null
  }, client);
}

async function recordError(sessionRef, error, client = null) {
  const message = String(error?.message || error || 'Errore').slice(0, 1000);
  return updateSession(sessionRef, { last_error: message }, client).catch(() => null);
}

module.exports = {
  normalizeWallet,
  normalizeHash,
  normalizeSessionRef,
  publicSession,
  createSession,
  getSession,
  requireSession,
  updateSession,
  recordRogPaymentConfirmed,
  recordRogRegistrationCandidate,
  recordRogRegistration,
  markRogFulfillmentProcessing,
  recordRogFulfillmentCompleted,
  recordRogFulfillmentError,
  listRogFulfillmentPending,
  extractHumanPosition,
  recordRogConfirmed,
  recordPharaohVerified,
  recordRegistrySubmitted,
  recordRegistryConfirmed,
  markPositionAssigned,
  recordError
};

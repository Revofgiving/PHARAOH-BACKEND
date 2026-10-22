'use strict';

const crypto = require('crypto');
const pg = require('./pg-connection-manager');

const WALLET_RE = /^0x[a-f0-9]{40}$/;
const HASH_RE = /^0x[a-f0-9]{64}$/;
const SESSION_RE = /^0x[a-f0-9]{64}$/;
const DIRECT_ROG_PROTOCOL = 'ROG_DIRECT_CYCLE_1TO1_V2';
const ROG_ELIGIBILITY_WINDOW_MS = 60 * 60 * 1000;
const ROG_FRESHNESS_SKEW_MS = 5 * 1000;
const MAX_PHARAOH_CANDIDATES_PER_SESSION = 8;

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

function hasActivePharaohBroadcastIntent(row) {
  return !!(row?.pharaoh_broadcast_intent_at && !row?.pharaoh_broadcast_cancelled_at);
}

function hasPharaohReconciliationEvidence(row) {
  return !!(
    row?.pharaoh_tx_hash ||
    row?.pharaoh_candidate_tx_hash ||
    hasActivePharaohBroadcastIntent(row)
  );
}

function pharaohReconciliationState(row) {
  if (!row) return 'NONE';
  if (row.status === 'POSITION_ASSIGNED' || row.completed_at) return 'COMPLETED';
  if (row.pharaoh_tx_hash) return 'VERIFIED';
  if (row.pharaoh_candidate_tx_hash) return 'CANDIDATE_RECORDED';
  if (hasActivePharaohBroadcastIntent(row)) return 'INTENT_RECORDED';
  if (row.pharaoh_broadcast_intent_at && row.pharaoh_broadcast_cancelled_at) return 'INTENT_CANCELLED';
  return 'NONE';
}

function proofBlockTimeMs(proof) {
  const value = Number(proof?.blockTimestamp);
  return Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

function assertStrictCycleProofFreshness(row, proof, label) {
  if (row?.rog_eligibility_source !== DIRECT_ROG_PROTOCOL) return null;
  const startedMs = new Date(row.created_at || 0).getTime();
  const proofMs = proofBlockTimeMs(proof);
  if (!Number.isFinite(startedMs) || proofMs == null) {
    throw makeError(`Timestamp blockchain ${label} non verificabile`, 'DIRECT_ROG_FRESHNESS_UNVERIFIABLE');
  }
  if (proofMs + ROG_FRESHNESS_SKEW_MS < startedMs) {
    throw makeError(
      `La prova ${label} ROG precede l'apertura del ciclo PHARAOH e non puo essere riutilizzata`,
      'DIRECT_ROG_PROOF_NOT_FRESH'
    );
  }
  return proofMs;
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
    completedAt: row.completed_at || null,
    rogEligibilitySource: row.rog_eligibility_source || null,
    rogEligibilityCompletedAt: row.rog_eligibility_completed_at || null,
    rogEligibilityExpiresAt: row.rog_eligibility_expires_at || null,
    rogClaimedAt: row.rog_claimed_at || null,
    rogClaimExpiresAt: row.rog_claim_expires_at || null,
    pharaohBroadcastIntentAt: row.pharaoh_broadcast_intent_at || null,
    pharaohBroadcastClaimExpiresAt: row.pharaoh_broadcast_claim_expires_at || null,
    pharaohBroadcastEligibilityExpiresAt: row.pharaoh_broadcast_eligibility_expires_at || null,
    pharaohBroadcastCancelledAt: row.pharaoh_broadcast_cancelled_at || null,
    pharaohBroadcastCancelReason: row.pharaoh_broadcast_cancel_reason || null,
    pharaohCandidateTxHash: row.pharaoh_candidate_tx_hash || null,
    pharaohCandidateRecordedAt: row.pharaoh_candidate_recorded_at || null,
    pharaohCandidateSource: row.pharaoh_candidate_source || null,
    pharaohReconciliationState: pharaohReconciliationState(row),
    pharaohReconciliationLastError: row.pharaoh_reconciliation_last_error || null,
    pharaohReconciliationUpdatedAt: row.pharaoh_reconciliation_updated_at || null
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
    `INSERT INTO direct_donation_sessions (session_ref, wallet, status, rog_amount_usdc)
     VALUES ($1, $2, 'SESSION_OPEN', $3)
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
    'position_result', 'last_error', 'completed_at',
    'rog_eligibility_source', 'rog_eligibility_completed_at', 'rog_eligibility_expires_at',
    'rog_claimed_at', 'rog_claim_expires_at',
    'pharaoh_broadcast_intent_at', 'pharaoh_broadcast_claim_expires_at',
    'pharaoh_broadcast_eligibility_expires_at', 'pharaoh_broadcast_cancelled_at',
    'pharaoh_broadcast_cancel_reason', 'pharaoh_candidate_tx_hash',
    'pharaoh_candidate_recorded_at', 'pharaoh_candidate_source',
    'pharaoh_reconciliation_last_error', 'pharaoh_reconciliation_updated_at'
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

  assertStrictCycleProofFreshness(row, proof, 'pagamento 2 USDC');

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

  const registrationMs = assertStrictCycleProofFreshness(row, proof, 'registerDonation');
  const existingProof = asJsonObject(row.rog_proof);
  if (row.rog_eligibility_source === DIRECT_ROG_PROTOCOL) {
    const paymentMs = proofBlockTimeMs(existingProof.usdc);
    if (paymentMs == null) {
      throw makeError('Prova blockchain del pagamento ROG mancante', 'DIRECT_ROG_PROOF_REQUIRED');
    }
    if (registrationMs + ROG_FRESHNESS_SKEW_MS < paymentMs) {
      throw makeError('registerDonation ROG precede il pagamento ROG del ciclo corrente', 'DIRECT_ROG_PROOF_ORDER_INVALID');
    }
  }
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

function extractHumanPositionRecord(rogResult, expectedWallet = null) {
  const completion = rogResult?.completion || rogResult || {};
  const positions = Array.isArray(completion?.positions?.posizioni)
    ? completion.positions.posizioni
    : Array.isArray(completion?.posizioni)
      ? completion.posizioni
      : [];
  const wallet = expectedWallet ? normalizeWallet(expectedWallet) : null;
  return positions.find((position) => {
    if (String(position?.tipo || '').toUpperCase() !== 'HUMAN') return false;
    if (!wallet) return true;
    try { return normalizeWallet(position?.wallet) === wallet; } catch (_) { return false; }
  }) || null;
}

function extractHumanPosition(rogResult, expectedWallet = null) {
  const human = extractHumanPositionRecord(rogResult, expectedWallet);
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
  const humanRecord = extractHumanPositionRecord(rogResult, wallet);
  const humanPosition = Number(humanRecord?.posizione);
  if (!Number.isSafeInteger(humanPosition) || humanPosition <= 0) {
    throw makeError(
      'ROG ha dichiarato COMPLETED ma non ha restituito una posizione HUMAN valida per il wallet della sessione',
      'DIRECT_ROG_HUMAN_POSITION_REQUIRED'
    );
  }

  const fields = {
    rog_result: rogResult || null,
    rog_human_position: humanPosition,
    rog_confirmed_at: row.rog_confirmed_at || new Date().toISOString(),
    rog_fulfillment_status: 'COMPLETED',
    rog_fulfillment_last_error: null,
    rog_fulfillment_next_retry_at: null,
    rog_fulfillment_updated_at: new Date().toISOString(),
    last_error: null
  };

  if (row.rog_eligibility_source === DIRECT_ROG_PROTOCOL) {
    const cycleStartedMs = new Date(row.created_at || 0).getTime();
    const humanCreatedMs = new Date(humanRecord?.created_at || humanRecord?.timestamp || '').getTime();
    if (!Number.isFinite(cycleStartedMs) || !Number.isFinite(humanCreatedMs)) {
      throw makeError(
        'La nuova HUMAN ROG deve avere created_at verificabile per il ciclo DIRECT 1:1',
        'DIRECT_ROG_HUMAN_FRESHNESS_UNVERIFIABLE'
      );
    }
    if (humanCreatedMs + ROG_FRESHNESS_SKEW_MS < cycleStartedMs) {
      throw makeError(
        'La HUMAN ROG restituita precede il ciclo PHARAOH corrente e non puo essere riutilizzata',
        'DIRECT_ROG_HUMAN_NOT_FRESH'
      );
    }
    fields.rog_eligibility_completed_at = new Date(humanCreatedMs).toISOString();
    fields.rog_eligibility_expires_at = new Date(humanCreatedMs + ROG_ELIGIBILITY_WINDOW_MS).toISOString();
  }

  return updateSession(sessionRef, fields, client);
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

async function getPharaohCandidate(sessionRef, txHash, client = null) {
  const ref = normalizeSessionRef(sessionRef);
  const canonicalHash = normalizeHash(txHash, 'pharaohCandidateTxHash');
  const runner = client || pg;
  const result = await runner.query(
    `SELECT * FROM direct_pharaoh_tx_candidates
      WHERE session_ref=$1 AND LOWER(tx_hash)=LOWER($2)
      LIMIT 1`,
    [ref, canonicalHash]
  );
  return result.rows[0] || null;
}

async function countPharaohCandidates(sessionRef, client = null) {
  const ref = normalizeSessionRef(sessionRef);
  const runner = client || pg;
  const result = await runner.query(
    'SELECT COUNT(*)::int AS count FROM direct_pharaoh_tx_candidates WHERE session_ref=$1',
    [ref]
  );
  return Number(result.rows[0]?.count || 0);
}

async function insertPharaohCandidate({ sessionRef, txHash, source, replacesTxHash = null }, client = null) {
  const ref = normalizeSessionRef(sessionRef);
  const canonicalHash = normalizeHash(txHash, 'pharaohCandidateTxHash');
  const canonicalReplaces = replacesTxHash ? normalizeHash(replacesTxHash, 'replacesTxHash') : null;
  const runner = client || pg;
  try {
    const result = await runner.query(
      `INSERT INTO direct_pharaoh_tx_candidates
        (session_ref, tx_hash, source, replaces_tx_hash)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [ref, canonicalHash, String(source || 'BROWSER').slice(0, 64), canonicalReplaces]
    );
    return result.rows[0];
  } catch (error) {
    if (String(error?.code || '') === '23505') {
      throw makeError('Hash candidato PHARAOH gia associato a un altra sessione', 'DIRECT_SESSION_PROOF_CONFLICT');
    }
    throw error;
  }
}

async function markPharaohCandidateVerified(sessionRef, txHash, client = null) {
  const ref = normalizeSessionRef(sessionRef);
  const canonicalHash = normalizeHash(txHash, 'pharaohCandidateTxHash');
  const runner = client || pg;
  await runner.query(
    `UPDATE direct_pharaoh_tx_candidates
        SET verified_at=COALESCE(verified_at,NOW()), last_error=NULL
      WHERE session_ref=$1 AND LOWER(tx_hash)=LOWER($2)`,
    [ref, canonicalHash]
  );
}

async function recordPharaohVerified({ sessionRef, wallet, amountUsdc, txHash, proof }, client = null) {
  const row = await requireSession(sessionRef, wallet, client);
  if (!['ROG_PAYMENT_CONFIRMED', 'ROG_CONFIRMED', 'PHARAOH_VERIFIED', 'REGISTRY_SUBMITTED', 'REGISTRY_CONFIRMED'].includes(row.status)) {
    throw makeError('Il ciclo ROG della sessione non e confermato', 'ROG_PAYMENT_REQUIRED');
  }
  if (!row.rog_usdc_tx_hash || !row.rog_payment_confirmed_at) {
    throw makeError('Prova on-chain del pagamento ROG mancante', 'ROG_PAYMENT_PROOF_REQUIRED');
  }

  if (row.rog_eligibility_source === DIRECT_ROG_PROTOCOL) {
    const human = Number(row.rog_human_position);
    const rogProof = asJsonObject(row.rog_proof);
    if (row.rog_fulfillment_status !== 'COMPLETED' || !Number.isSafeInteger(human) || human <= 0 || !row.rog_confirmed_at) {
      throw makeError('La nuova HUMAN ROG dedicata al ciclo non e completata', 'DIRECT_ROG_POSITION_REQUIRED');
    }
    if (!row.rog_register_tx_hash || !row.rog_donation_id || !rogProof.usdc || !rogProof.registration) {
      throw makeError('Prove complete del nuovo ciclo ROG mancanti', 'DIRECT_ROG_PROOF_REQUIRED');
    }
  }

  const canonicalHash = normalizeHash(txHash, 'pharaohTxHash');
  if (row.pharaoh_tx_hash && String(row.pharaoh_tx_hash).toLowerCase() !== canonicalHash) {
    throw makeError('La sessione DIRECT e gia associata a una tx PHARAOH differente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }
  let candidate = await getPharaohCandidate(sessionRef, canonicalHash, client);
  if (!candidate) {
    if (row.pharaoh_candidate_tx_hash && String(row.pharaoh_candidate_tx_hash).toLowerCase() !== canonicalHash) {
      throw makeError('La transazione verificata non appartiene allo storico candidati della sessione', 'DIRECT_SESSION_PROOF_CONFLICT');
    }
    candidate = await insertPharaohCandidate({
      sessionRef, txHash: canonicalHash, source: row.pharaoh_candidate_source || 'FINALIZE_COMPAT'
    }, client);
  }
  await markPharaohCandidateVerified(sessionRef, canonicalHash, client);

  const verifiedAt = row.pharaoh_verified_at || new Date().toISOString();
  return updateSession(sessionRef, {
    status: ['ROG_PAYMENT_CONFIRMED', 'ROG_CONFIRMED'].includes(row.status) ? 'PHARAOH_VERIFIED' : row.status,
    pharaoh_amount_usdc: Number(amountUsdc),
    pharaoh_tx_hash: canonicalHash,
    pharaoh_proof: proof || null,
    pharaoh_verified_at: verifiedAt,
    pharaoh_broadcast_intent_at: row.pharaoh_broadcast_intent_at || verifiedAt,
    pharaoh_broadcast_claim_expires_at: row.pharaoh_broadcast_claim_expires_at || row.rog_claim_expires_at || null,
    pharaoh_broadcast_eligibility_expires_at: row.pharaoh_broadcast_eligibility_expires_at || row.rog_eligibility_expires_at || null,
    pharaoh_candidate_tx_hash: canonicalHash,
    pharaoh_candidate_recorded_at: candidate.recorded_at || row.pharaoh_candidate_recorded_at || verifiedAt,
    pharaoh_candidate_source: candidate.source || row.pharaoh_candidate_source || 'FINALIZE_COMPAT',
    pharaoh_broadcast_cancelled_at: null,
    pharaoh_broadcast_cancel_reason: null,
    pharaoh_reconciliation_last_error: null,
    pharaoh_reconciliation_updated_at: verifiedAt,
    last_error: null
  }, client);
}

async function recordPharaohBroadcastIntent({ sessionRef, wallet, claimExpiresAt, eligibilityExpiresAt }, client = null) {
  const row = await requireSession(sessionRef, wallet, client);
  if (row.status === 'POSITION_ASSIGNED' || row.completed_at) return row;
  const now = new Date().toISOString();
  const restartAfterCancellation = !!row.pharaoh_broadcast_cancelled_at;
  return updateSession(sessionRef, {
    pharaoh_broadcast_intent_at: restartAfterCancellation ? now : (row.pharaoh_broadcast_intent_at || now),
    pharaoh_broadcast_claim_expires_at: restartAfterCancellation
      ? (claimExpiresAt || row.rog_claim_expires_at || null)
      : (row.pharaoh_broadcast_claim_expires_at || claimExpiresAt || row.rog_claim_expires_at || null),
    pharaoh_broadcast_eligibility_expires_at: restartAfterCancellation
      ? (eligibilityExpiresAt || row.rog_eligibility_expires_at || null)
      : (row.pharaoh_broadcast_eligibility_expires_at || eligibilityExpiresAt || row.rog_eligibility_expires_at || null),
    pharaoh_broadcast_cancelled_at: null,
    pharaoh_broadcast_cancel_reason: null,
    pharaoh_reconciliation_last_error: null,
    pharaoh_reconciliation_updated_at: now,
    last_error: null
  }, client);
}

async function cancelPharaohBroadcastIntent({ sessionRef, wallet, reason = 'EXPLICIT_USER_REJECTION' }, client = null) {
  const row = await requireSession(sessionRef, wallet, client);
  if (row.pharaoh_tx_hash || row.pharaoh_candidate_tx_hash) {
    throw makeError('Una transazione PHARAOH e gia presente e deve essere riconciliata', 'PHARAOH_RECOVERY_REQUIRED');
  }
  if (!hasActivePharaohBroadcastIntent(row)) return row;
  const now = new Date().toISOString();
  return updateSession(sessionRef, {
    pharaoh_broadcast_cancelled_at: now,
    pharaoh_broadcast_cancel_reason: String(reason || 'EXPLICIT_USER_REJECTION').slice(0, 128),
    pharaoh_reconciliation_last_error: null,
    pharaoh_reconciliation_updated_at: now,
    rog_claimed_at: null,
    rog_claim_expires_at: null,
    last_error: null
  }, client);
}

async function recordPharaohCandidate({ sessionRef, wallet, txHash, source = 'BROWSER', replacesTxHash = null }, client = null) {
  const row = await requireSession(sessionRef, wallet, client);
  const canonicalHash = normalizeHash(txHash, 'pharaohCandidateTxHash');
  if (!hasActivePharaohBroadcastIntent(row)) {
    throw makeError('Intento di broadcast PHARAOH non registrato o annullato sul server', 'DIRECT_BROADCAST_INTENT_REQUIRED');
  }
  if (row.pharaoh_tx_hash && String(row.pharaoh_tx_hash).toLowerCase() !== canonicalHash) {
    throw makeError('La sessione DIRECT e gia associata a una tx PHARAOH differente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }

  const existing = await getPharaohCandidate(sessionRef, canonicalHash, client);
  if (existing) return row;

  const current = row.pharaoh_candidate_tx_hash ? String(row.pharaoh_candidate_tx_hash).toLowerCase() : null;
  let canonicalReplaces = null;
  if (current && current !== canonicalHash) {
    if (!replacesTxHash) {
      throw makeError('La sessione DIRECT contiene gia un hash candidato differente', 'DIRECT_SESSION_PROOF_CONFLICT');
    }
    canonicalReplaces = normalizeHash(replacesTxHash, 'replacesTxHash');
    if (canonicalReplaces !== current || !String(source || '').toUpperCase().includes('REPLACEMENT')) {
      throw makeError('La sessione DIRECT contiene gia un hash candidato differente', 'DIRECT_SESSION_PROOF_CONFLICT');
    }
    const count = await countPharaohCandidates(sessionRef, client);
    if (count >= MAX_PHARAOH_CANDIDATES_PER_SESSION) {
      throw makeError('Numero massimo di sostituzioni wallet raggiunto per la sessione', 'DIRECT_CANDIDATE_LIMIT_REACHED');
    }
  } else if (replacesTxHash) {
    throw makeError('Hash sostituito non coerente con il candidato corrente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }

  const candidate = await insertPharaohCandidate({
    sessionRef,
    txHash: canonicalHash,
    source,
    replacesTxHash: canonicalReplaces
  }, client);
  const now = new Date().toISOString();
  return updateSession(sessionRef, {
    pharaoh_candidate_tx_hash: canonicalHash,
    pharaoh_candidate_recorded_at: candidate.recorded_at || now,
    pharaoh_candidate_source: candidate.source || String(source || 'BROWSER').slice(0, 64),
    pharaoh_reconciliation_last_error: null,
    pharaoh_reconciliation_updated_at: now,
    last_error: null
  }, client);
}

async function recordPharaohReconciliationError(sessionRef, error, client = null) {
  const message = String(error?.message || error || 'Errore riconciliazione PHARAOH').slice(0, 1000);
  return updateSession(sessionRef, {
    pharaoh_reconciliation_last_error: message,
    pharaoh_reconciliation_updated_at: new Date().toISOString()
  }, client).catch(() => null);
}

async function listPharaohReconciliationPending(limit = 10, client = null) {
  const runner = client || pg;
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10));
  const result = await runner.query(
    `SELECT *
       FROM direct_donation_sessions
      WHERE pharaoh_candidate_tx_hash IS NOT NULL
        AND pharaoh_tx_hash IS NULL
        AND completed_at IS NULL
        AND status <> 'CANCELLED'
      ORDER BY COALESCE(pharaoh_candidate_recorded_at, updated_at, created_at) ASC
      LIMIT $1`,
    [safeLimit]
  );
  return result.rows || [];
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
  DIRECT_ROG_PROTOCOL,
  ROG_ELIGIBILITY_WINDOW_MS,
  ROG_FRESHNESS_SKEW_MS,
  MAX_PHARAOH_CANDIDATES_PER_SESSION,
  normalizeWallet,
  normalizeHash,
  normalizeSessionRef,
  asJsonObject,
  hasActivePharaohBroadcastIntent,
  hasPharaohReconciliationEvidence,
  pharaohReconciliationState,
  proofBlockTimeMs,
  assertStrictCycleProofFreshness,
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
  extractHumanPositionRecord,
  recordRogConfirmed,
  getPharaohCandidate,
  countPharaohCandidates,
  insertPharaohCandidate,
  markPharaohCandidateVerified,
  recordPharaohBroadcastIntent,
  cancelPharaohBroadcastIntent,
  recordPharaohCandidate,
  recordPharaohVerified,
  recordPharaohReconciliationError,
  listPharaohReconciliationPending,
  recordRegistrySubmitted,
  recordRegistryConfirmed,
  markPositionAssigned,
  recordError
};

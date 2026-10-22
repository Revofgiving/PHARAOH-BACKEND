'use strict';

const pg = require('./pg-connection-manager');
const community = require('./rog-community-manager');
const eligibility = require('./direct-rog-eligibility-manager');
const rogDonation = require('./rog-donation-manager');
const sessions = require('./direct-donation-session-manager');

function makeError(message, code, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function proofBlockTimeMs(proof) {
  const value = Number(proof?.blockTimestamp);
  return Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

function assertFreshCycleProof(row, proof, label) {
  if (row?.rog_eligibility_source !== sessions.DIRECT_ROG_PROTOCOL) {
    throw makeError(
      'Questa sessione non appartiene al protocollo DIRECT 1:1 corrente: aprire un nuovo ciclo prima di donare in ROG',
      'DIRECT_FRESH_ROG_CYCLE_REQUIRED'
    );
  }
  const startedMs = new Date(row.created_at || 0).getTime();
  const proofMs = proofBlockTimeMs(proof);
  if (!Number.isFinite(startedMs) || proofMs == null) {
    throw makeError(`Timestamp blockchain ${label} non verificabile`, 'DIRECT_ROG_FRESHNESS_UNVERIFIABLE');
  }
  if (proofMs + sessions.ROG_FRESHNESS_SKEW_MS < startedMs) {
    throw makeError(
      `La prova ${label} ROG precede l'apertura del ciclo PHARAOH e non puo essere riutilizzata`,
      'DIRECT_ROG_PROOF_NOT_FRESH'
    );
  }
  return proofMs;
}

async function withAdvisoryLock(key, operation, dependencies = {}) {
  const db = dependencies.pg || pg;
  const client = await db.getClient();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    return await operation(client);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); } catch (_) { /* release finale */ }
    client.release();
  }
}

async function withSessionLock(sessionRef, operation, dependencies = {}) {
  return withAdvisoryLock(`PHARAOH:DIRECT:${String(sessionRef).toLowerCase()}`, operation, dependencies);
}

async function withRogFulfillmentLock(sessionRef, operation, dependencies = {}) {
  // Lock separato per il fulfillment ROG. PHARAOH resta bloccato finche il fulfillment non e COMPLETED.
  return withAdvisoryLock(`PHARAOH:DIRECT:ROG_FULFILL:${String(sessionRef).toLowerCase()}`, operation, dependencies);
}

async function startSession(wallet, dependencies = {}) {
  const sessionManager = dependencies.sessions || sessions;
  const rog = dependencies.rogDonation || rogDonation;
  const w = sessionManager.normalizeWallet(wallet);
  // La sessione PHARAOH nasce PRIMA del controllo Community.
  // Nessun diritto economico deriva dalla sola apertura della sessione:
  // Community, ROG e PHARAOH restano verificati fail-closed ai rispettivi gate.
  const cfg = rog.getConfig();
  if (Number(cfg.amountUsdc) !== 2) {
    throw makeError('DIRECT richiede esattamente 2 USDC ROG per ogni nuova posizione PHARAOH', 'DIRECT_SESSION_ROG_AMOUNT_INVALID');
  }

  return withAdvisoryLock(`PHARAOH:DIRECT:WALLET:${w}`, async (client) => {
    await client.query('BEGIN');
    try {
      const existingResult = await client.query(
        `SELECT *
           FROM direct_donation_sessions
          WHERE LOWER(wallet)=LOWER($1)
            AND rog_eligibility_source=$2
            AND status NOT IN ('POSITION_ASSIGNED','CANCELLED')
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [w, sessionManager.DIRECT_ROG_PROTOCOL]
      );
      let existing = existingResult.rows[0] || null;

      if (existing && !sessionManager.hasPharaohReconciliationEvidence(existing) && existing.rog_eligibility_expires_at) {
        const expiresMs = new Date(existing.rog_eligibility_expires_at).getTime();
        if (Number.isFinite(expiresMs) && Date.now() >= expiresMs) {
          await client.query(
            `UPDATE direct_donation_sessions
                SET status='CANCELLED', rog_claimed_at=NULL, rog_claim_expires_at=NULL,
                    last_error='ROG_PROOF_EXPIRED_NEW_CYCLE_REQUIRED', updated_at=NOW()
              WHERE session_ref=$1`,
            [existing.session_ref]
          );
          existing = null;
        }
      }

      if (existing) {
        await client.query('COMMIT');
        return {
          success: true,
          idempotent: true,
          recovery: sessionManager.hasPharaohReconciliationEvidence(existing),
          session: sessionManager.publicSession(existing)
        };
      }

      const row = await sessionManager.createSession(w, cfg.amountUsdc, client);
      const marked = await sessionManager.updateSession(row.session_ref, {
        rog_eligibility_source: sessionManager.DIRECT_ROG_PROTOCOL,
        last_error: null
      }, client);
      await client.query('COMMIT');
      return { success: true, idempotent: false, session: sessionManager.publicSession(marked) };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }, dependencies);
}

async function getSessionForWallet(sessionRef, wallet, dependencies = {}) {
  const sessionManager = dependencies.sessions || sessions;
  const row = await sessionManager.requireSession(sessionRef, wallet);
  return { success: true, session: sessionManager.publicSession(row) };
}

async function markPharaohBroadcastIntent({ wallet, sessionRef }, dependencies = {}) {
  const eligibilityManager = dependencies.eligibility || eligibility;
  return eligibilityManager.markBroadcastIntent(wallet, sessionRef, dependencies);
}

async function attachPharaohCandidate({ wallet, sessionRef, txHash, source = 'BROWSER', replacesTxHash = null }, dependencies = {}) {
  const eligibilityManager = dependencies.eligibility || eligibility;
  return eligibilityManager.attachCandidate(wallet, sessionRef, txHash, source, replacesTxHash, dependencies);
}

async function _confirmRogPaymentLocked({ wallet, sessionRef, rogUsdcTxHash }, client, dependencies = {}) {
  const communityManager = dependencies.community || community;
  const sessionManager = dependencies.sessions || sessions;
  const rog = dependencies.rogDonation || rogDonation;
  const row = await sessionManager.requireSession(sessionRef, wallet, client);
  const w = String(row.wallet).toLowerCase();

  if (row.rog_payment_confirmed_at && row.rog_usdc_tx_hash) {
    const incoming = sessionManager.normalizeHash(rogUsdcTxHash, 'rogUsdcTxHash');
    if (String(row.rog_usdc_tx_hash).toLowerCase() !== incoming) {
      throw makeError('La sessione ROG e gia associata a una tx USDC differente', 'DIRECT_SESSION_PROOF_CONFLICT');
    }
    return { success: true, idempotent: true, canProceedToPharaoh: row.rog_fulfillment_status === 'COMPLETED' && Number(row.rog_human_position) > 0, session: sessionManager.publicSession(row) };
  }

  if (!['SESSION_OPEN', 'COMMUNITY_CONFIRMED', 'ROG_CONFIRMING', 'ROG_PAYMENT_CONFIRMED'].includes(row.status)) {
    // Sessioni gia avanzate sono idempotenti se contengono una prova pagamento.
    if (['ROG_CONFIRMED', 'PHARAOH_VERIFIED', 'REGISTRY_SUBMITTED', 'REGISTRY_CONFIRMED', 'POSITION_ASSIGNED'].includes(row.status) && row.rog_usdc_tx_hash) {
      return { success: true, idempotent: true, canProceedToPharaoh: row.rog_fulfillment_status === 'COMPLETED' && Number(row.rog_human_position) > 0, session: sessionManager.publicSession(row) };
    }
    throw makeError(`Stato sessione non valido per pagamento ROG: ${row.status}`, 'DIRECT_SESSION_STATE_INVALID');
  }

  // Il requisito Community viene verificato QUI prima di accettare la prova economica ROG.
  // Una SESSION_OPEN non puo quindi saltare la Community: viene promossa solo dopo verifica reale.
  await communityManager.assertCommunityMember(w);
  let currentRow = row;
  if (row.status === 'SESSION_OPEN') {
    currentRow = await sessionManager.updateSession(row.session_ref, {
      status: 'COMMUNITY_CONFIRMED',
      last_error: null
    }, client);
  }
  const expectedAmount = Number(currentRow.rog_amount_usdc);
  const canonicalUsdcHash = sessionManager.normalizeHash(rogUsdcTxHash, 'rogUsdcTxHash');
  if (currentRow.rog_usdc_tx_hash && String(currentRow.rog_usdc_tx_hash).toLowerCase() !== canonicalUsdcHash) {
    throw makeError('La sessione ROG e gia associata a una tx USDC differente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }

  // UNICO GATE ECONOMICO: receipt status=1 + Transfer esatto 2 USDC dal donor alla Cassa ROG.
  const usdcProof = await rog.verifyRogUsdcTransfer({
    txHash: canonicalUsdcHash,
    wallet: w,
    amountUsdc: expectedAmount
  });
  assertFreshCycleProof(currentRow, usdcProof, 'pagamento 2 USDC');

  const updated = await sessionManager.recordRogPaymentConfirmed({
    sessionRef,
    wallet: w,
    amountUsdc: expectedAmount,
    usdcTxHash: canonicalUsdcHash,
    proof: usdcProof
  }, client);

  return {
    success: true,
    paymentConfirmed: true,
    canProceedToPharaoh: false,
    rogFulfillmentPending: updated.rog_fulfillment_status !== 'COMPLETED',
    session: sessionManager.publicSession(updated)
  };
}

async function confirmRogPayment({ wallet, sessionRef, rogUsdcTxHash, rogRegisterTxHash = null, rogDonationId = null }, dependencies = {}) {
  const result = await withSessionLock(sessionRef, async (client) => {
    const payment = await _confirmRogPaymentLocked({ wallet, sessionRef, rogUsdcTxHash }, client, dependencies);
    if (rogRegisterTxHash && rogDonationId) {
      await (dependencies.sessions || sessions).recordRogRegistrationCandidate({
        sessionRef, wallet, registerTxHash: rogRegisterTxHash, donationId: rogDonationId
      }, client);
    }
    return payment;
  }, dependencies);

  // Non blocca il donatore: la verifica registerDonation e il fulfillment ROG
  // proseguono sul worker separato dopo che il gate economico dei 2 USDC e' superato.
  if (rogRegisterTxHash && rogDonationId) {
    setImmediate(() => { processRogFulfillment(sessionRef, dependencies).catch(() => null); });
  }
  return result;
}

async function _recordRogRegistrationLocked({ wallet, sessionRef, rogRegisterTxHash, rogDonationId }, client, dependencies = {}) {
  const sessionManager = dependencies.sessions || sessions;
  const rog = dependencies.rogDonation || rogDonation;
  const row = await sessionManager.requireSession(sessionRef, wallet, client);
  const w = String(row.wallet).toLowerCase();

  if (!row.rog_payment_confirmed_at || !row.rog_usdc_tx_hash) {
    throw makeError('Prima deve essere confermato il Transfer di 2 USDC alla Cassa ROG', 'ROG_PAYMENT_REQUIRED');
  }

  const canonicalRegisterHash = sessionManager.normalizeHash(rogRegisterTxHash, 'rogRegisterTxHash');
  const canonicalDonationId = String(rogDonationId || '').trim();
  if (!/^\d+$/.test(canonicalDonationId) || BigInt(canonicalDonationId) <= 0n) {
    throw makeError('rogDonationId numerico obbligatorio', 'ROG_DONATION_ID_INVALID');
  }
  if (
    (row.rog_register_tx_hash && String(row.rog_register_tx_hash).toLowerCase() !== canonicalRegisterHash) ||
    (row.rog_donation_id && String(row.rog_donation_id) !== canonicalDonationId)
  ) {
    throw makeError('La sessione ROG e gia associata a una registrazione blockchain differente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }

  if (row.rog_register_tx_hash && row.rog_donation_id && row.rog_fulfillment_status === 'COMPLETED') {
    return { success: true, idempotent: true, queued: false, session: sessionManager.publicSession(row) };
  }

  const expectedAmount = Number(row.rog_amount_usdc);
  const registrationProof = await rog.verifyRogRegistration({
    registerTxHash: canonicalRegisterHash,
    wallet: w,
    amountUsdc: expectedAmount,
    donationId: canonicalDonationId
  });
  const registrationMs = assertFreshCycleProof(row, registrationProof, 'registerDonation');
  const existingProof = sessionManager.asJsonObject(row.rog_proof);
  const paymentMs = proofBlockTimeMs(existingProof.usdc);
  if (paymentMs != null && registrationMs + sessionManager.ROG_FRESHNESS_SKEW_MS < paymentMs) {
    throw makeError('registerDonation ROG precede il pagamento ROG del ciclo corrente', 'DIRECT_ROG_PROOF_ORDER_INVALID');
  }

  const updated = await sessionManager.recordRogRegistration({
    sessionRef,
    wallet: w,
    registerTxHash: canonicalRegisterHash,
    donationId: canonicalDonationId,
    proof: registrationProof
  }, client);

  return { success: true, queued: true, session: sessionManager.publicSession(updated) };
}

async function submitRogRegistration({ wallet, sessionRef, rogRegisterTxHash, rogDonationId }, dependencies = {}) {
  const result = await withSessionLock(sessionRef, async (client) => {
    await (dependencies.sessions || sessions).recordRogRegistrationCandidate({
      sessionRef, wallet, registerTxHash: rogRegisterTxHash, donationId: rogDonationId
    }, client);
    return _recordRogRegistrationLocked({ wallet, sessionRef, rogRegisterTxHash, rogDonationId }, client, dependencies);
  }, dependencies);

  // Best effort immediato. Il worker periodico garantisce il recovery anche se il processo si riavvia.
  if (result.queued) {
    setImmediate(() => {
      processRogFulfillment(sessionRef, dependencies).catch(() => null);
    });
  }
  return result;
}

/**
 * Endpoint legacy compatibile con il frontend precedente.
 * Verifica pagamento + registerDonation ma NON attende piu' /verify ROG.
 * Il gate PHARAOH resta il solo Transfer USDC gia confermato.
 */
async function confirmRogDonation({ wallet, sessionRef, rogUsdcTxHash, rogRegisterTxHash, rogDonationId }, dependencies = {}) {
  await withSessionLock(sessionRef, async (client) => {
    await _confirmRogPaymentLocked({ wallet, sessionRef, rogUsdcTxHash }, client, dependencies);
    await _recordRogRegistrationLocked({ wallet, sessionRef, rogRegisterTxHash, rogDonationId }, client, dependencies);
  }, dependencies);

  // La richiesta resta sincrona dal punto di vista del gate: PHARAOH si apre
  // soltanto dopo che ROG restituisce COMPLETED con una HUMAN reale.
  const fulfillment = await processRogFulfillment(sessionRef, dependencies);
  const sessionManager = dependencies.sessions || sessions;
  const row = await sessionManager.requireSession(sessionRef, wallet);
  const completed = fulfillment?.success === true && row.rog_fulfillment_status === 'COMPLETED' && Number(row.rog_human_position) > 0;
  if (!completed) {
    throw makeError('La nuova posizione ROG non e ancora stata creata. PHARAOH resta bloccato.', 'DIRECT_ROG_POSITION_PENDING', true);
  }
  return {
    success: true,
    canProceedToPharaoh: true,
    paymentConfirmed: true,
    rogFulfillmentQueued: false,
    rogHumanPosition: Number(row.rog_human_position),
    session: sessionManager.publicSession(row)
  };
}


/**
 * Ritorno esplicito da ROG -> PHARAOH.
 * Il browser porta i riferimenti del nuovo ciclo ROG. Il gate dei 100 USDC
 * resta chiuso finche il backend non verifica pagamento 2 USDC, registerDonation
 * e nuova HUMAN ROG COMPLETED associata alla stessa sessione PHARAOH.
 */
async function verifyExternalRogReturn({ wallet, sessionRef, rogUsdcTxHash, rogRegisterTxHash = null, rogDonationId = null, rogPositionHint = null }, dependencies = {}) {
  if (!rogRegisterTxHash || !rogDonationId) {
    throw makeError('Il ritorno ROG deve includere registerDonation e donationId della nuova operazione', 'DIRECT_ROG_RETURN_INCOMPLETE');
  }

  await withSessionLock(sessionRef, async (client) => {
    await _confirmRogPaymentLocked({ wallet, sessionRef, rogUsdcTxHash }, client, dependencies);
    await _recordRogRegistrationLocked({ wallet, sessionRef, rogRegisterTxHash, rogDonationId }, client, dependencies);
  }, dependencies);

  const fulfillment = await processRogFulfillment(sessionRef, dependencies);
  const sessionManager = dependencies.sessions || sessions;
  const row = await sessionManager.requireSession(sessionRef, wallet);
  const humanPosition = Number(row.rog_human_position);

  if (fulfillment?.success !== true || row.rog_fulfillment_status !== 'COMPLETED' || !Number.isSafeInteger(humanPosition) || humanPosition <= 0) {
    throw makeError('ROG non ha ancora completato la nuova posizione HUMAN. PHARAOH resta bloccato.', 'DIRECT_ROG_POSITION_PENDING', true);
  }

  if (rogPositionHint != null && String(rogPositionHint).trim() !== '') {
    const hinted = Number(rogPositionHint);
    if (!Number.isSafeInteger(hinted) || hinted <= 0) {
      throw makeError('Posizione ROG indicata dal browser non valida', 'DIRECT_ROG_POSITION_HINT_INVALID');
    }
    if (hinted !== humanPosition) {
      throw makeError('La posizione ROG restituita non coincide con la nuova HUMAN verificata dal backend', 'DIRECT_ROG_POSITION_MISMATCH');
    }
  }

  return {
    success: true,
    verified: true,
    paymentConfirmed: true,
    canProceedToPharaoh: true,
    rogFulfillmentPending: false,
    rogHumanPosition: humanPosition,
    session: sessionManager.publicSession(row)
  };
}

async function verifyRogPositionForSession({ wallet, sessionRef, rogPosition }, dependencies = {}) {
  const sessionManager = dependencies.sessions || sessions;
  const rogApi = dependencies.rogApi || community;
  const row = await sessionManager.requireSession(sessionRef, wallet);
  const w = sessionManager.normalizeWallet(wallet);
  if (row.rog_eligibility_source !== sessionManager.DIRECT_ROG_PROTOCOL && !row.pharaoh_tx_hash) {
    throw makeError('Serve un nuovo ciclo ROG dedicato a questa posizione PHARAOH', 'DIRECT_FRESH_ROG_CYCLE_REQUIRED');
  }
  const requested = Number(rogPosition || row.rog_human_position || 0);
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw makeError('Nuova posizione ROG non ancora disponibile', 'ROG_POSITION_NOT_FOUND', true);
  }
  if (row.rog_fulfillment_status !== 'COMPLETED' || Number(row.rog_human_position) !== requested) {
    throw makeError('La posizione ROG non risulta completata per questa nuova sessione PHARAOH', 'ROG_POSITION_NOT_FOUND', true);
  }
  if (!row.rog_usdc_tx_hash || !row.rog_register_tx_hash || !row.rog_donation_id) {
    throw makeError('Prove ROG incomplete per la nuova posizione', 'DIRECT_ROG_RETURN_INCOMPLETE');
  }

  const live = await rogApi._rogRequest(`/api/user-positions/${encodeURIComponent(w)}`);
  if (live?.degraded === true) {
    throw makeError('ROG temporaneamente non disponibile per la verifica posizione', 'ROG_POSITION_VERIFY_RETRY', true);
  }
  const found = Array.isArray(live?.posizioni)
    ? live.posizioni.find((p) =>
      Number(p?.posizione) === requested &&
      String(p?.wallet || '').toLowerCase() === w &&
      String(p?.tipo || 'HUMAN').toUpperCase() === 'HUMAN'
    )
    : null;
  if (!found) throw makeError('La nuova posizione ROG non risulta intestata al wallet della sessione', 'ROG_POSITION_NOT_FOUND', true);

  return {
    success: true,
    verified: true,
    canProceedToPharaoh: true,
    rogHumanPosition: requested,
    position: found,
    session: sessionManager.publicSession(row)
  };
}


async function processRogFulfillment(sessionRef, dependencies = {}) {
  const sessionManager = dependencies.sessions || sessions;
  const rog = dependencies.rogDonation || rogDonation;

  return withRogFulfillmentLock(sessionRef, async () => {
    let row = await sessionManager.getSession(sessionRef);
    if (!row) throw makeError('Sessione di donazione non trovata', 'DIRECT_SESSION_NOT_FOUND');
    const existingHumanPosition = Number(row.rog_human_position);
    if (row.rog_fulfillment_status === 'COMPLETED' && Number.isSafeInteger(existingHumanPosition) && existingHumanPosition > 0) {
      return { success: true, idempotent: true, session: sessionManager.publicSession(row) };
    }
    if (!row.rog_payment_confirmed_at || !row.rog_usdc_tx_hash) {
      return { success: false, deferred: true, reason: 'ROG_PAYMENT_NOT_CONFIRMED' };
    }
    if (!row.rog_register_tx_hash || !row.rog_donation_id) {
      if (!row.rog_registration_candidate_tx_hash || !row.rog_registration_candidate_donation_id) {
        return { success: false, deferred: true, reason: 'ROG_REGISTRATION_NOT_AVAILABLE' };
      }
      try {
        const registrationProof = await rog.verifyRogRegistration({
          registerTxHash: row.rog_registration_candidate_tx_hash,
          wallet: row.wallet,
          amountUsdc: Number(row.rog_amount_usdc),
          donationId: row.rog_registration_candidate_donation_id
        });
        row = await sessionManager.recordRogRegistration({
          sessionRef,
          wallet: row.wallet,
          registerTxHash: row.rog_registration_candidate_tx_hash,
          donationId: row.rog_registration_candidate_donation_id,
          proof: registrationProof
        });
      } catch (error) {
        await sessionManager.recordRogFulfillmentError(sessionRef, error);
        throw error;
      }
    }

    row = await sessionManager.markRogFulfillmentProcessing(sessionRef);
    try {
      const rogResult = await rog.finalizeRogDonation({
        wallet: row.wallet,
        amountUsdc: Number(row.rog_amount_usdc),
        usdcTxHash: row.rog_usdc_tx_hash,
        registerTxHash: row.rog_register_tx_hash,
        donationId: row.rog_donation_id
      });
      const completed = await sessionManager.recordRogFulfillmentCompleted({
        sessionRef,
        wallet: row.wallet,
        rogResult
      });
      return { success: true, session: sessionManager.publicSession(completed) };
    } catch (error) {
      await sessionManager.recordRogFulfillmentError(sessionRef, error);
      return {
        success: false,
        retryable: true,
        code: error.code || 'ROG_FULFILLMENT_RETRY',
        error: String(error.message || error)
      };
    }
  }, dependencies);
}

async function processRogFulfillmentPending(limit = 5, dependencies = {}) {
  const sessionManager = dependencies.sessions || sessions;
  const rows = await sessionManager.listRogFulfillmentPending(limit);
  const results = [];
  for (const row of rows) {
    try {
      results.push({ sessionRef: row.session_ref, ...(await processRogFulfillment(row.session_ref, dependencies)) });
    } catch (error) {
      results.push({ sessionRef: row.session_ref, success: false, code: error.code || 'ERROR', error: String(error.message || error) });
    }
  }
  return { success: true, processed: results.length, results };
}

async function assertReadyForPharaoh({ wallet, sessionRef }, dependencies = {}) {
  const eligibilityManager = dependencies.eligibility || eligibility;
  const communityManager = dependencies.community || community;
  const sessionManager = dependencies.sessions || sessions;
  const w = sessionManager.normalizeWallet(wallet);

  const claimed = await eligibilityManager.assertClaimReady(w, sessionRef, dependencies);
  if (claimed?.alreadyCompleted) return claimed;

  await communityManager.assertCommunityMember(w);
  const row = claimed?.session || await sessionManager.requireSession(sessionRef, w);
  if (row.status === 'POSITION_ASSIGNED') return { alreadyCompleted: true, session: row };

  if (row.rog_eligibility_source !== sessionManager.DIRECT_ROG_PROTOCOL && !row.pharaoh_tx_hash) {
    throw makeError(
      'Una HUMAN ROG storica non abilita una nuova posizione PHARAOH: serve una nuova donazione ROG per questo ciclo',
      'DIRECT_FRESH_ROG_CYCLE_REQUIRED'
    );
  }
  if (row.rog_fulfillment_status !== 'COMPLETED') {
    throw makeError('Prima dei 100 USDC PHARAOH deve essere completata la nuova HUMAN ROG del ciclo.', 'DIRECT_ROG_POSITION_REQUIRED', true);
  }
  const humanPosition = Number(row.rog_human_position);
  if (!Number.isSafeInteger(humanPosition) || humanPosition <= 0) {
    throw makeError('Posizione HUMAN ROG mancante per questa sessione PHARAOH', 'DIRECT_ROG_HUMAN_POSITION_REQUIRED', true);
  }
  if (!row.rog_usdc_tx_hash || !row.rog_payment_confirmed_at || !row.rog_register_tx_hash || !row.rog_donation_id || !row.rog_confirmed_at) {
    throw makeError('Prove complete ROG mancanti per questa nuova posizione', 'DIRECT_ROG_PROOF_REQUIRED', true);
  }
  const proof = sessionManager.asJsonObject(row.rog_proof);
  if (!proof.usdc || !proof.registration) {
    throw makeError('Prove on-chain ROG incomplete', 'DIRECT_ROG_PROOF_REQUIRED', true);
  }

  return {
    alreadyCompleted: false,
    recovery: claimed?.recovery === true,
    rogFulfillmentPending: false,
    rogHumanPosition: humanPosition,
    session: row
  };
}


module.exports = {
  startSession,
  getSessionForWallet,
  markPharaohBroadcastIntent,
  attachPharaohCandidate,
  confirmRogPayment,
  submitRogRegistration,
  confirmRogDonation,
  verifyExternalRogReturn,
  verifyRogPositionForSession,
  processRogFulfillment,
  processRogFulfillmentPending,
  assertReadyForPharaoh,
  _withSessionLock: withSessionLock,
  _withRogFulfillmentLock: withRogFulfillmentLock
};

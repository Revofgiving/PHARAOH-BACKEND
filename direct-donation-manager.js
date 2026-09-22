'use strict';

const pg = require('./pg-connection-manager');
const community = require('./rog-community-manager');
const rogDonation = require('./rog-donation-manager');
const sessions = require('./direct-donation-session-manager');

function makeError(message, code, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
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
  const communityManager = dependencies.community || community;
  const sessionManager = dependencies.sessions || sessions;
  const rog = dependencies.rogDonation || rogDonation;
  const w = sessionManager.normalizeWallet(wallet);
  await communityManager.assertCommunityMember(w);
  const cfg = rog.getConfig();
  const row = await sessionManager.createSession(w, cfg.amountUsdc);
  return { success: true, session: sessionManager.publicSession(row) };
}

async function getSessionForWallet(sessionRef, wallet, dependencies = {}) {
  const sessionManager = dependencies.sessions || sessions;
  const row = await sessionManager.requireSession(sessionRef, wallet);
  return { success: true, session: sessionManager.publicSession(row) };
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

  if (!['COMMUNITY_CONFIRMED', 'ROG_CONFIRMING', 'ROG_PAYMENT_CONFIRMED'].includes(row.status)) {
    // Sessioni gia avanzate sono idempotenti se contengono una prova pagamento.
    if (['ROG_CONFIRMED', 'PHARAOH_VERIFIED', 'REGISTRY_SUBMITTED', 'REGISTRY_CONFIRMED', 'POSITION_ASSIGNED'].includes(row.status) && row.rog_usdc_tx_hash) {
      return { success: true, idempotent: true, canProceedToPharaoh: row.rog_fulfillment_status === 'COMPLETED' && Number(row.rog_human_position) > 0, session: sessionManager.publicSession(row) };
    }
    throw makeError(`Stato sessione non valido per pagamento ROG: ${row.status}`, 'DIRECT_SESSION_STATE_INVALID');
  }

  await communityManager.assertCommunityMember(w);
  const expectedAmount = Number(row.rog_amount_usdc);
  const canonicalUsdcHash = sessionManager.normalizeHash(rogUsdcTxHash, 'rogUsdcTxHash');
  if (row.rog_usdc_tx_hash && String(row.rog_usdc_tx_hash).toLowerCase() !== canonicalUsdcHash) {
    throw makeError('La sessione ROG e gia associata a una tx USDC differente', 'DIRECT_SESSION_PROOF_CONFLICT');
  }

  // UNICO GATE ECONOMICO: receipt status=1 + Transfer esatto 2 USDC dal donor alla Cassa ROG.
  const usdcProof = await rog.verifyRogUsdcTransfer({
    txHash: canonicalUsdcHash,
    wallet: w,
    amountUsdc: expectedAmount
  });

  // Anti-replay temporale: una nuova sessione PHARAOH non puo usare una
  // vecchia tx ROG mai associata in precedenza. Tolleranza 120s per clock skew.
  const sessionCreatedAt = new Date(row.created_at).getTime();
  const paymentBlockMs = Number(usdcProof.blockTimestamp || 0) * 1000;
  if (Number.isFinite(sessionCreatedAt) && paymentBlockMs > 0 && paymentBlockMs < sessionCreatedAt - 120000) {
    throw makeError('La transazione ROG precede la nuova sessione PHARAOH e non puo essere riutilizzata', 'DIRECT_ROG_TX_PREDATES_SESSION');
  }

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

  const sessionCreatedAt = new Date(row.created_at).getTime();
  const registerBlockMs = Number(registrationProof.blockTimestamp || 0) * 1000;
  if (Number.isFinite(sessionCreatedAt) && registerBlockMs > 0 && registerBlockMs < sessionCreatedAt - 120000) {
    throw makeError('La registerDonation ROG precede la nuova sessione PHARAOH e non puo essere riutilizzata', 'DIRECT_ROG_REGISTER_PREDATES_SESSION');
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
 * Il browser porta solo il riferimento al pagamento. Il gate dei 100 USDC
 * si apre dopo la verifica on-chain del Transfer esatto di 2 USDC a ROG.
 * DonationRegistered, HUMAN/PILETTA, molecola e livello H proseguono in background.
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
    ? live.posizioni.find((p) => Number(p?.posizione) === requested && String(p?.wallet || '').toLowerCase() === w)
    : null;
  if (!found) throw makeError('La nuova posizione ROG non risulta intestata al wallet della sessione', 'ROG_POSITION_NOT_FOUND', true);

  const createdAtMs = found.created_at ? new Date(found.created_at).getTime() : NaN;
  const sessionCreatedAtMs = new Date(row.created_at).getTime();
  if (Number.isFinite(createdAtMs) && Number.isFinite(sessionCreatedAtMs) && createdAtMs < sessionCreatedAtMs - 120000) {
    throw makeError('La posizione ROG e precedente alla nuova sessione PHARAOH e non e valida per questa operazione', 'DIRECT_ROG_POSITION_PREDATES_SESSION');
  }

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
  const communityManager = dependencies.community || community;
  const sessionManager = dependencies.sessions || sessions;
  const w = sessionManager.normalizeWallet(wallet);
  await communityManager.assertCommunityMember(w);
  const row = await sessionManager.requireSession(sessionRef, w);
  if (row.status === 'POSITION_ASSIGNED') return { alreadyCompleted: true, session: row };

  if (row.rog_fulfillment_status !== 'COMPLETED') {
    throw makeError('Prima dei 100 USDC PHARAOH deve essere completata la nuova posizione ROG.', 'DIRECT_ROG_POSITION_REQUIRED', true);
  }
  const humanPosition = Number(row.rog_human_position);
  if (!Number.isSafeInteger(humanPosition) || humanPosition <= 0) {
    throw makeError('Posizione HUMAN ROG mancante per questa sessione PHARAOH', 'DIRECT_ROG_HUMAN_POSITION_REQUIRED', true);
  }
  if (!row.rog_usdc_tx_hash || !row.rog_payment_confirmed_at || !row.rog_register_tx_hash || !row.rog_donation_id || !row.rog_confirmed_at) {
    throw makeError('Prove complete ROG mancanti per questa nuova posizione', 'DIRECT_ROG_PROOF_REQUIRED', true);
  }
  const proof = row.rog_proof && typeof row.rog_proof === 'object'
    ? row.rog_proof
    : (() => { try { return JSON.parse(row.rog_proof || '{}'); } catch (_) { return {}; } })();
  if (!proof.usdc || !proof.registration) {
    throw makeError('Prove on-chain ROG incomplete', 'DIRECT_ROG_PROOF_REQUIRED', true);
  }

  return {
    alreadyCompleted: false,
    rogFulfillmentPending: false,
    rogHumanPosition: humanPosition,
    session: row
  };
}


module.exports = {
  startSession,
  getSessionForWallet,
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

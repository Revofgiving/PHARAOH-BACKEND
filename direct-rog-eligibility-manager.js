'use strict';

const pg = require('./pg-connection-manager');
const community = require('./rog-community-manager');
const sessions = require('./direct-donation-session-manager');

const WINDOW_MS = sessions.ROG_ELIGIBILITY_WINDOW_MS;
const CLAIM_MS = 10 * 60 * 1000;
const PROTOCOL = sessions.DIRECT_ROG_PROTOCOL;

function makeError(message, code, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function asMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function hasCompletedFreshRog(row) {
  const human = Number(row?.rog_human_position);
  return row?.rog_eligibility_source === PROTOCOL &&
    row?.rog_fulfillment_status === 'COMPLETED' &&
    Number.isSafeInteger(human) && human > 0 &&
    !!row?.rog_confirmed_at;
}

function hasPharaohRecoveryEvidence(row, sessionManager = sessions) {
  return sessionManager.hasPharaohReconciliationEvidence
    ? sessionManager.hasPharaohReconciliationEvidence(row)
    : !!(row?.pharaoh_tx_hash || row?.pharaoh_candidate_tx_hash || row?.pharaoh_broadcast_intent_at);
}

function stateFromRow(row, now = Date.now()) {
  if (!row) return null;
  const human = Number(row.rog_human_position);
  const completed = asMs(row.rog_eligibility_completed_at || row.rog_confirmed_at);
  const expires = asMs(row.rog_eligibility_expires_at) || (completed == null ? null : completed + WINDOW_MS);
  const claimExpires = asMs(row.rog_claim_expires_at);

  let status = 'ROG_REQUIRED';
  if (row.status === 'POSITION_ASSIGNED' || row.completed_at) status = 'USED';
  else if (hasPharaohRecoveryEvidence(row)) status = 'RECOVERY';
  else if (hasCompletedFreshRog(row)) {
    if (row.rog_claimed_at && claimExpires != null && claimExpires > now) status = 'CLAIMED';
    else if (expires != null && expires > now) status = 'ELIGIBLE';
    else status = 'EXPIRED';
  } else if (
    row.rog_usdc_tx_hash || row.rog_register_tx_hash || row.rog_donation_id ||
    ['WAITING_REGISTRATION', 'REGISTERED', 'PROCESSING', 'RETRY'].includes(String(row.rog_fulfillment_status || ''))
  ) status = 'PROCESSING';

  return {
    status,
    sessionRef: row.session_ref,
    rogHumanPosition: Number.isSafeInteger(human) && human > 0 ? human : null,
    completedAt: completed == null ? null : new Date(completed).toISOString(),
    expiresAt: expires == null ? null : new Date(expires).toISOString(),
    secondsRemaining: expires == null ? 0 : Math.max(0, Math.floor((expires - now) / 1000)),
    claimed: status === 'CLAIMED'
  };
}

async function getEligibility(wallet, dependencies = {}) {
  const communityManager = dependencies.community || community;
  const db = dependencies.pg || pg;
  const sessionManager = dependencies.sessions || sessions;
  const w = sessionManager.normalizeWallet(wallet);
  const communityStatus = await communityManager.getCommunityStatus(w);
  if (!communityStatus.registered) {
    return {
      success: true,
      wallet: w,
      community: 'NOT_REGISTERED',
      rog: 'NOT_STARTED',
      pharaoh: 'LOCKED',
      reason: 'COMMUNITY_REQUIRED'
    };
  }

  // REGOLA 1:1 (9 ottobre 2026): non scoprire/associare HUMAN ROG dal solo wallet.
  // Sono valide soltanto le sessioni aperte PRIMA della nuova donazione ROG e marcate
  // con il protocollo DIRECT 1:1. Una HUMAN storica/recentissima non crea una sessione.
  const result = await db.query(
    `SELECT *
       FROM direct_donation_sessions
      WHERE LOWER(wallet)=LOWER($1)
        AND rog_eligibility_source=$2
        AND status <> 'CANCELLED'
      ORDER BY created_at DESC
      LIMIT 25`,
    [w, PROTOCOL]
  );
  const rows = result.rows || [];
  const now = Date.now();
  const active = rows.find((row) => row.status !== 'POSITION_ASSIGNED' && !row.completed_at) || null;
  if (!active) {
    return {
      success: true,
      wallet: w,
      community: 'REGISTERED',
      rog: 'NOT_STARTED',
      pharaoh: 'LOCKED',
      reason: 'DIRECT_CYCLE_REQUIRED'
    };
  }

  const state = stateFromRow(active, now);
  const ready = state.status === 'ELIGIBLE';
  let reason = null;
  if (state.status === 'ROG_REQUIRED') reason = 'ROG_DONATION_REQUIRED';
  else if (state.status === 'PROCESSING') reason = 'ROG_HUMAN_PROCESSING';
  else if (state.status === 'CLAIMED') reason = 'PAYMENT_IN_PROGRESS';
  else if (state.status === 'EXPIRED') reason = 'ROG_PROOF_EXPIRED';
  else if (state.status === 'RECOVERY') reason = 'PHARAOH_RECOVERY_REQUIRED';

  return {
    success: true,
    wallet: w,
    community: 'REGISTERED',
    rog: state.status,
    pharaoh: ready ? 'READY' : 'LOCKED',
    reason,
    ...state
  };
}

async function authorize(wallet, sessionRef, dependencies = {}) {
  const communityManager = dependencies.community || community;
  const db = dependencies.pg || pg;
  const sessionManager = dependencies.sessions || sessions;
  const w = sessionManager.normalizeWallet(wallet);
  const ref = sessionManager.normalizeSessionRef(sessionRef);
  await communityManager.assertCommunityMember(w);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PHARAOH:DIRECT:AUTHORIZE:${w}`]);
    const result = await client.query('SELECT * FROM direct_donation_sessions WHERE session_ref=$1 FOR UPDATE', [ref]);
    const row = result.rows[0];
    if (!row || String(row.wallet).toLowerCase() !== w) throw makeError('Sessione DIRECT non disponibile per il wallet', 'DIRECT_SESSION_NOT_FOUND');
    if (row.rog_eligibility_source !== PROTOCOL) throw makeError('Serve un nuovo ciclo ROG dedicato a questa posizione PHARAOH', 'DIRECT_FRESH_ROG_CYCLE_REQUIRED');
    if (row.status === 'POSITION_ASSIGNED' || row.completed_at) throw makeError('La HUMAN ROG di questo ciclo e gia stata utilizzata', 'ROG_PROOF_USED');
    if (hasPharaohRecoveryEvidence(row, sessionManager)) {
      throw makeError('Pagamento PHARAOH o intento di broadcast gia rilevato: usare il recovery della stessa sessione', 'PHARAOH_RECOVERY_REQUIRED', true);
    }
    if (!hasCompletedFreshRog(row)) throw makeError('La nuova HUMAN ROG dedicata a questo ciclo non e ancora completata', 'DIRECT_ROG_POSITION_REQUIRED', true);

    const expiresAt = asMs(row.rog_eligibility_expires_at) || ((asMs(row.rog_eligibility_completed_at || row.rog_confirmed_at) || 0) + WINDOW_MS);
    if (!expiresAt || Date.now() >= expiresAt) throw makeError('La finestra ROG di 60 minuti e scaduta: serve una nuova donazione ROG', 'ROG_PROOF_EXPIRED');

    const proof = sessionManager.asJsonObject ? sessionManager.asJsonObject(row.rog_proof) : (typeof row.rog_proof === 'object' ? row.rog_proof : {});
    if (!row.rog_usdc_tx_hash || !row.rog_payment_confirmed_at || !row.rog_register_tx_hash || !row.rog_donation_id || !proof.usdc || !proof.registration) {
      throw makeError('Prove complete del nuovo ciclo ROG mancanti', 'DIRECT_ROG_PROOF_REQUIRED', true);
    }

    const claimExpiresCurrent = asMs(row.rog_claim_expires_at);
    if (row.rog_claimed_at && claimExpiresCurrent != null && claimExpiresCurrent > Date.now()) {
      throw makeError('Questa prova ROG ha gia un pagamento PHARAOH in corso', 'ROG_PROOF_CLAIMED', true);
    }

    const now = Date.now();
    const claimExpiresMs = Math.min(now + CLAIM_MS, expiresAt);
    if (claimExpiresMs <= now) throw makeError('La finestra ROG di 60 minuti e scaduta: serve una nuova donazione ROG', 'ROG_PROOF_EXPIRED');
    const claimExpires = new Date(claimExpiresMs);
    const updated = await client.query(
      `UPDATE direct_donation_sessions
          SET rog_claimed_at=NOW(), rog_claim_expires_at=$2, updated_at=NOW()
        WHERE session_ref=$1
        RETURNING *`,
      [ref, claimExpires.toISOString()]
    );
    await client.query('COMMIT');
    return {
      success: true,
      authorized: true,
      sessionRef: ref,
      rogHumanPosition: Number(updated.rows[0].rog_human_position),
      expiresAt: new Date(expiresAt).toISOString(),
      claimExpiresAt: claimExpires.toISOString()
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function release(wallet, sessionRef, options = {}, dependencies = {}) {
  // Compatibilita con eventuali test/invocazioni che passavano dependencies come terzo argomento.
  if (options && (options.pg || options.sessions || options.community) && !options.reason) {
    dependencies = options;
    options = {};
  }
  const db = dependencies.pg || pg;
  const sessionManager = dependencies.sessions || sessions;
  const w = sessionManager.normalizeWallet(wallet);
  const ref = sessionManager.normalizeSessionRef(sessionRef);
  const reason = String(options?.reason || '').trim().toUpperCase();
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PHARAOH:DIRECT:BROADCAST:${ref}`]);
    let row = await sessionManager.requireSession(ref, w, client, { forUpdate: true });
    const state = sessionManager.pharaohReconciliationState ? sessionManager.pharaohReconciliationState(row) : null;
    if (row.status === 'POSITION_ASSIGNED' || row.completed_at || row.pharaoh_tx_hash || row.pharaoh_candidate_tx_hash) {
      await client.query('COMMIT');
      return { success: true, released: false, reconciliationRequired: !!(row.pharaoh_tx_hash || row.pharaoh_candidate_tx_hash), reconciliationState: state };
    }

    const activeIntent = sessionManager.hasActivePharaohBroadcastIntent
      ? sessionManager.hasActivePharaohBroadcastIntent(row)
      : !!(row.pharaoh_broadcast_intent_at && !row.pharaoh_broadcast_cancelled_at);
    // A claim is never released as a generic cleanup operation. Under the
    // server-first protocol the wallet can open only after an active intent;
    // therefore the sole early-release case is the wallet's explicit reject
    // for that same intent. All other claims expire naturally and remain
    // fail-closed while their outcome is ambiguous.
    if (!activeIntent || reason !== 'EXPLICIT_USER_REJECTION') {
      await client.query('COMMIT');
      return { success: true, released: false, reconciliationRequired: activeIntent, reconciliationState: state };
    }
    row = await sessionManager.cancelPharaohBroadcastIntent({
      sessionRef: ref, wallet: w, reason: 'EXPLICIT_USER_REJECTION'
    }, client);
    await client.query('COMMIT');
    return {
      success: true,
      released: true,
      intentCancelled: activeIntent,
      reconciliationRequired: false,
      reconciliationState: sessionManager.pharaohReconciliationState ? sessionManager.pharaohReconciliationState(row) : null
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function markBroadcastIntent(wallet, sessionRef, dependencies = {}) {
  const communityManager = dependencies.community || community;
  const db = dependencies.pg || pg;
  const sessionManager = dependencies.sessions || sessions;
  const w = sessionManager.normalizeWallet(wallet);
  const ref = sessionManager.normalizeSessionRef(sessionRef);
  await communityManager.assertCommunityMember(w);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PHARAOH:DIRECT:BROADCAST:${ref}`]);
    let row = await sessionManager.requireSession(ref, w, client, { forUpdate: true });
    if (row.status === 'POSITION_ASSIGNED' || row.completed_at) {
      await client.query('COMMIT');
      return { success: true, intentRecorded: false, completed: true, session: sessionManager.publicSession(row) };
    }
    if (row.status === 'CANCELLED') throw makeError('La sessione DIRECT e annullata', 'DIRECT_SESSION_CANCELLED');
    if (row.pharaoh_broadcast_intent_at && !row.pharaoh_broadcast_cancelled_at) {
      await client.query('COMMIT');
      return { success: true, intentRecorded: true, idempotent: true, session: sessionManager.publicSession(row) };
    }
    if (row.pharaoh_tx_hash || row.pharaoh_candidate_tx_hash) {
      throw makeError('La sessione contiene gia una transazione PHARAOH da riconciliare', 'PHARAOH_RECOVERY_REQUIRED', true);
    }
    if (row.rog_eligibility_source !== PROTOCOL || !hasCompletedFreshRog(row)) {
      throw makeError('La nuova HUMAN ROG dedicata a questo ciclo non e ancora completata', 'DIRECT_ROG_POSITION_REQUIRED', true);
    }
    const now = Date.now();
    const eligibilityExpiry = asMs(row.rog_eligibility_expires_at) || ((asMs(row.rog_eligibility_completed_at || row.rog_confirmed_at) || 0) + WINDOW_MS);
    if (!eligibilityExpiry || now >= eligibilityExpiry) throw makeError('La finestra ROG di 60 minuti e scaduta: serve una nuova donazione ROG', 'ROG_PROOF_EXPIRED');
    const claimExpiry = asMs(row.rog_claim_expires_at);
    if (!row.rog_claimed_at || claimExpiry == null || now >= claimExpiry) {
      throw makeError('Autorizzazione PHARAOH scaduta: riverificare i requisiti', 'DIRECT_AUTHORIZATION_REQUIRED', true);
    }
    row = await sessionManager.recordPharaohBroadcastIntent({
      sessionRef: ref,
      wallet: w,
      claimExpiresAt: new Date(claimExpiry).toISOString(),
      eligibilityExpiresAt: new Date(eligibilityExpiry).toISOString()
    }, client);
    await client.query('COMMIT');
    return { success: true, intentRecorded: true, idempotent: false, session: sessionManager.publicSession(row) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function attachCandidate(wallet, sessionRef, txHash, source = 'BROWSER', replacesTxHash = null, dependencies = {}) {
  if (replacesTxHash && typeof replacesTxHash === 'object' && (replacesTxHash.pg || replacesTxHash.sessions || replacesTxHash.community)) {
    dependencies = replacesTxHash;
    replacesTxHash = null;
  }
  const communityManager = dependencies.community || community;
  const db = dependencies.pg || pg;
  const sessionManager = dependencies.sessions || sessions;
  const w = sessionManager.normalizeWallet(wallet);
  const ref = sessionManager.normalizeSessionRef(sessionRef);
  const canonicalHash = sessionManager.normalizeHash(txHash, 'pharaohCandidateTxHash');
  await communityManager.assertCommunityMember(w);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PHARAOH:DIRECT:BROADCAST:${ref}`]);
    let row = await sessionManager.requireSession(ref, w, client, { forUpdate: true });
    if (row.status === 'CANCELLED') throw makeError('La sessione DIRECT e annullata', 'DIRECT_SESSION_CANCELLED');
    if (row.pharaoh_tx_hash && String(row.pharaoh_tx_hash).toLowerCase() !== canonicalHash) {
      throw makeError('La sessione DIRECT e gia associata a una tx PHARAOH differente', 'DIRECT_SESSION_PROOF_CONFLICT');
    }
    // Compatibilita controllata per client precedenti: il primo finish puo
    // registrare intento+candidato soltanto finche claim e finestra ROG sono vivi.
    if (!row.pharaoh_broadcast_intent_at || row.pharaoh_broadcast_cancelled_at) {
      if (row.rog_eligibility_source !== PROTOCOL || !hasCompletedFreshRog(row)) {
        throw makeError('Intento di broadcast PHARAOH non registrato sul server', 'DIRECT_BROADCAST_INTENT_REQUIRED');
      }
      const now = Date.now();
      const eligibilityExpiry = asMs(row.rog_eligibility_expires_at) || ((asMs(row.rog_eligibility_completed_at || row.rog_confirmed_at) || 0) + WINDOW_MS);
      const claimExpiry = asMs(row.rog_claim_expires_at);
      if (!eligibilityExpiry || now >= eligibilityExpiry) throw makeError('La finestra ROG di 60 minuti e scaduta: serve una riconciliazione verificata', 'ROG_PROOF_EXPIRED');
      if (!row.rog_claimed_at || claimExpiry == null || now >= claimExpiry) {
        throw makeError('Autorizzazione PHARAOH scaduta: serve una riconciliazione verificata', 'DIRECT_AUTHORIZATION_REQUIRED', true);
      }
      row = await sessionManager.recordPharaohBroadcastIntent({
        sessionRef: ref,
        wallet: w,
        claimExpiresAt: new Date(claimExpiry).toISOString(),
        eligibilityExpiresAt: new Date(eligibilityExpiry).toISOString()
      }, client);
    }

    row = await sessionManager.recordPharaohCandidate({
      sessionRef: ref, wallet: w, txHash: canonicalHash, source, replacesTxHash
    }, client);
    await client.query('COMMIT');
    return {
      success: true,
      candidateRecorded: true,
      idempotent: String(row.pharaoh_candidate_tx_hash || '').toLowerCase() === canonicalHash,
      reconciliationState: sessionManager.pharaohReconciliationState ? sessionManager.pharaohReconciliationState(row) : 'CANDIDATE_RECORDED',
      session: sessionManager.publicSession(row)
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function assertClaimReady(wallet, sessionRef, dependencies = {}) {
  const communityManager = dependencies.community || community;
  const sessionManager = dependencies.sessions || sessions;
  const w = sessionManager.normalizeWallet(wallet);
  await communityManager.assertCommunityMember(w);
  const row = await sessionManager.requireSession(sessionRef, w);
  if (row.status === 'POSITION_ASSIGNED') return { alreadyCompleted: true, session: row };

  // Recovery: una tx PHARAOH gia verificata/non completata deve poter essere ripresa
  // senza chiedere un secondo pagamento o un nuovo claim.
  if (row.pharaoh_tx_hash) {
    return { alreadyCompleted: false, recovery: true, rogHumanPosition: Number(row.rog_human_position) || null, session: row };
  }

  // Un hash candidato, registrato dopo un intento server valido, puo essere
  // verificato anche dopo la scadenza del claim/finestra senza chiedere un
  // secondo pagamento. Non equivale a un accredito: il verifier resta obbligatorio.
  if (row.pharaoh_broadcast_intent_at && !row.pharaoh_broadcast_cancelled_at && row.pharaoh_candidate_tx_hash) {
    return { alreadyCompleted: false, recovery: true, candidateRecovery: true, rogHumanPosition: Number(row.rog_human_position) || null, session: row };
  }
  if (row.pharaoh_broadcast_intent_at && !row.pharaoh_broadcast_cancelled_at) {
    throw makeError('Intento PHARAOH presente ma hash ancora sconosciuto: riconciliare la stessa sessione', 'DIRECT_RECONCILIATION_HASH_REQUIRED', true);
  }

  if (row.rog_eligibility_source !== PROTOCOL) {
    throw makeError('Una HUMAN ROG storica non abilita una nuova posizione PHARAOH: aprire un nuovo ciclo ROG', 'DIRECT_FRESH_ROG_CYCLE_REQUIRED');
  }
  if (!hasCompletedFreshRog(row)) {
    throw makeError('La nuova HUMAN ROG dedicata a questo ciclo non e ancora completata', 'DIRECT_ROG_POSITION_REQUIRED', true);
  }

  const eligibilityExpiry = asMs(row.rog_eligibility_expires_at) || ((asMs(row.rog_eligibility_completed_at || row.rog_confirmed_at) || 0) + WINDOW_MS);
  if (!eligibilityExpiry || Date.now() >= eligibilityExpiry) {
    throw makeError('La finestra ROG di 60 minuti e scaduta: serve una nuova donazione ROG', 'ROG_PROOF_EXPIRED');
  }
  const claimExpiry = asMs(row.rog_claim_expires_at);
  if (!row.rog_claimed_at || claimExpiry == null || claimExpiry <= Date.now()) {
    throw makeError('Autorizzazione PHARAOH scaduta: riverificare i requisiti', 'DIRECT_AUTHORIZATION_REQUIRED', true);
  }

  const live = await communityManager._rogRequest(`/api/user-positions/${encodeURIComponent(w)}`);
  if (live?.degraded === true) throw makeError('ROG temporaneamente non disponibile', 'ROG_POSITION_VERIFY_RETRY', true);
  const found = (Array.isArray(live?.posizioni) ? live.posizioni : []).find((p) =>
    Number(p?.posizione) === Number(row.rog_human_position) &&
    String(p?.wallet || '').toLowerCase() === w &&
    String(p?.tipo || 'HUMAN').toUpperCase() === 'HUMAN'
  );
  if (!found) throw makeError('La nuova HUMAN ROG del ciclo non risulta piu verificabile', 'ROG_POSITION_NOT_FOUND', true);

  return { alreadyCompleted: false, rogHumanPosition: Number(row.rog_human_position), session: row };
}

module.exports = {
  getEligibility,
  authorize,
  release,
  markBroadcastIntent,
  attachCandidate,
  assertClaimReady,
  stateFromRow,
  hasPharaohRecoveryEvidence,
  WINDOW_MS,
  CLAIM_MS,
  PROTOCOL
};

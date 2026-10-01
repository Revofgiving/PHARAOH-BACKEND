'use strict';

const crypto = require('crypto');
const pg = require('./pg-connection-manager');
const community = require('./rog-community-manager');
const sessions = require('./direct-donation-session-manager');

const WINDOW_MS = 60 * 60 * 1000;
const CLAIM_MS = 10 * 60 * 1000;

function makeError(message, code, retryable = false) {
  const error = new Error(message); error.code = code; error.retryable = retryable; return error;
}

function positionTime(position) {
  const ms = new Date(position?.created_at || '').getTime();
  return Number.isFinite(ms) ? ms : null;
}

async function readRogState(wallet) {
  const w = sessions.normalizeWallet(wallet);
  const [positions, donation] = await Promise.all([
    community._rogRequest(`/api/user-positions/${encodeURIComponent(w)}`),
    community._rogRequest(`/api/donation/status/${encodeURIComponent(w)}`).catch(() => null)
  ]);
  if (positions?.degraded === true) throw makeError('ROG temporaneamente occupato: verifica in corso', 'ROG_POSITION_VERIFY_RETRY', true);
  const humans = (Array.isArray(positions?.posizioni) ? positions.posizioni : [])
    .filter((p) => String(p?.tipo || 'HUMAN').toUpperCase() === 'HUMAN')
    .filter((p) => String(p?.wallet || w).toLowerCase() === w)
    .map((p) => ({ ...p, _time: positionTime(p), _position: Number(p?.posizione) }))
    .filter((p) => Number.isSafeInteger(p._position) && p._position > 0 && p._time)
    .sort((a, b) => b._time - a._time);
  return { humans, donation };
}

async function bindPosition(wallet, position, client) {
  const w = sessions.normalizeWallet(wallet);
  const completedAt = new Date(position._time);
  const expiresAt = new Date(position._time + WINDOW_MS);
  const existing = await client.query('SELECT * FROM direct_donation_sessions WHERE rog_human_position = $1 LIMIT 1 FOR UPDATE', [position._position]);
  if (existing.rows[0]) {
    const current = existing.rows[0];
    const updated = await client.query(
      `UPDATE direct_donation_sessions
          SET rog_eligibility_source = COALESCE(rog_eligibility_source, 'ROG_POSITION_API'),
              rog_eligibility_completed_at = COALESCE(rog_eligibility_completed_at, $2),
              rog_eligibility_expires_at = COALESCE(rog_eligibility_expires_at, $3),
              updated_at = NOW()
        WHERE session_ref = $1 RETURNING *`,
      [current.session_ref, completedAt.toISOString(), expiresAt.toISOString()]
    );
    return updated.rows[0];
  }
  const ref = `0x${crypto.randomBytes(32).toString('hex')}`;
  try {
    const result = await client.query(
      `INSERT INTO direct_donation_sessions
       (session_ref, wallet, status, rog_amount_usdc, rog_fulfillment_status, rog_human_position,
        rog_confirmed_at, rog_fulfillment_updated_at, rog_eligibility_source,
        rog_eligibility_completed_at, rog_eligibility_expires_at, rog_result)
       VALUES ($1,$2,'ROG_CONFIRMED',2,'COMPLETED',$3,$4,NOW(),'ROG_POSITION_API',$4,$5,$6)
       RETURNING *`,
      [ref, w, position._position, completedAt.toISOString(), expiresAt.toISOString(), { position }]
    );
    return result.rows[0];
  } catch (error) {
    if (String(error?.code || '') === '23505') {
      const raced = await client.query('SELECT * FROM direct_donation_sessions WHERE rog_human_position = $1 LIMIT 1', [position._position]);
      if (raced.rows[0]) return raced.rows[0];
    }
    throw error;
  }
}

function stateFromRow(row, now = Date.now()) {
  if (!row) return null;
  const expires = new Date(row.rog_eligibility_expires_at || row.rog_confirmed_at || 0).getTime();
  const completed = new Date(row.rog_eligibility_completed_at || row.rog_confirmed_at || 0).getTime();
  const claimExpires = row.rog_claim_expires_at ? new Date(row.rog_claim_expires_at).getTime() : 0;
  let status;
  if (row.status === 'POSITION_ASSIGNED' || row.completed_at) status = 'USED';
  else if (row.rog_claimed_at && claimExpires > now) status = 'CLAIMED';
  else if (Number.isFinite(expires) && expires > now) status = 'ELIGIBLE';
  else status = 'EXPIRED';
  return {
    status,
    sessionRef: row.session_ref,
    rogHumanPosition: Number(row.rog_human_position),
    completedAt: Number.isFinite(completed) ? new Date(completed).toISOString() : null,
    expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
    secondsRemaining: Number.isFinite(expires) ? Math.max(0, Math.floor((expires - now) / 1000)) : 0,
    claimed: status === 'CLAIMED'
  };
}

async function getEligibility(wallet, dependencies = {}) {
  const communityManager = dependencies.community || community;
  const w = sessions.normalizeWallet(wallet);
  const communityStatus = await communityManager.getCommunityStatus(w);
  if (!communityStatus.registered) {
    return { success: true, wallet: w, community: 'NOT_REGISTERED', rog: 'NOT_FOUND', pharaoh: 'LOCKED', reason: 'COMMUNITY_REQUIRED' };
  }

  const rogState = await readRogState(w);
  const client = await pg.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PHARAOH:DIRECT:ELIGIBILITY:${w}`]);
    const discoveryNow = Date.now();
    for (const position of rogState.humans.slice(0, 25)) {
      // Non materializzare nel DB l'intera storia ROG: una nuova prova nasce
      // soltanto se la HUMAN e ancora dentro la finestra operativa di 60 minuti.
      if (discoveryNow - position._time > WINDOW_MS) continue;
      await bindPosition(w, position, client);
    }
    await client.query('COMMIT');

    const now = Date.now();
    const all = await pg.query(
      `SELECT * FROM direct_donation_sessions WHERE LOWER(wallet)=LOWER($1) AND rog_human_position IS NOT NULL ORDER BY COALESCE(rog_eligibility_completed_at, rog_confirmed_at, created_at) DESC LIMIT 25`,
      [w]
    );
    const states = all.rows.map((r) => stateFromRow(r, now));
    const eligible = states.find((s) => s.status === 'ELIGIBLE');
    const claimed = states.find((s) => s.status === 'CLAIMED');
    if (eligible || claimed) {
      const s = eligible || claimed;
      return { success: true, wallet: w, community: 'REGISTERED', rog: s.status, pharaoh: s.status === 'ELIGIBLE' ? 'READY' : 'LOCKED', reason: s.status === 'CLAIMED' ? 'PAYMENT_IN_PROGRESS' : null, ...s };
    }

    const newestHumanTime = rogState.humans[0]?._time || 0;
    const lastDonationTime = rogState.donation?.lastDonationDate ? new Date(rogState.donation.lastDonationDate).getTime() : 0;
    if (lastDonationTime && lastDonationTime > newestHumanTime && Date.now() - lastDonationTime < 6 * 60 * 60 * 1000) {
      return { success: true, wallet: w, community: 'REGISTERED', rog: 'PROCESSING', pharaoh: 'LOCKED', reason: 'ROG_HUMAN_PROCESSING', message: 'Donazione ROG rilevata. Attendere la creazione della nuova posizione HUMAN e non effettuare un secondo pagamento.' };
    }
    const latest = states[0] || null;
    return { success: true, wallet: w, community: 'REGISTERED', rog: latest?.status || 'NOT_FOUND', pharaoh: 'LOCKED', reason: latest?.status === 'EXPIRED' ? 'ROG_PROOF_EXPIRED' : latest?.status === 'USED' ? 'ROG_PROOF_USED' : 'ROG_DONATION_REQUIRED', ...(latest || {}) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}

async function authorize(wallet) {
  const current = await getEligibility(wallet);
  if (current.community !== 'REGISTERED') throw makeError('Registrazione Community ROG richiesta', 'ROG_COMMUNITY_REQUIRED');
  if (current.rog === 'PROCESSING') throw makeError('Donazione ROG in elaborazione: non effettuare un secondo pagamento', 'ROG_HUMAN_PROCESSING', true);
  if (current.rog !== 'ELIGIBLE' || !current.sessionRef) throw makeError('Serve una nuova donazione ROG con nuova posizione HUMAN valida', current.rog === 'EXPIRED' ? 'ROG_PROOF_EXPIRED' : 'DIRECT_ROG_POSITION_REQUIRED');
  const w = sessions.normalizeWallet(wallet);
  const client = await pg.getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM direct_donation_sessions WHERE session_ref=$1 FOR UPDATE', [current.sessionRef]);
    const row = result.rows[0];
    if (!row || String(row.wallet).toLowerCase() !== w) throw makeError('Prova ROG non disponibile', 'DIRECT_SESSION_NOT_FOUND');
    const expiresAt = new Date(row.rog_eligibility_expires_at || row.rog_confirmed_at).getTime();
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw makeError('La finestra ROG di 60 minuti e scaduta', 'ROG_PROOF_EXPIRED');
    if (row.status === 'POSITION_ASSIGNED' || row.completed_at) throw makeError('La posizione HUMAN ROG e gia stata utilizzata', 'ROG_PROOF_USED');
    if (row.rog_claimed_at && row.rog_claim_expires_at && new Date(row.rog_claim_expires_at).getTime() > Date.now()) throw makeError('Questa prova ROG ha gia un pagamento PHARAOH in corso', 'ROG_PROOF_CLAIMED', true);
    const claimExpires = new Date(Date.now() + CLAIM_MS);
    const updated = await client.query(
      `UPDATE direct_donation_sessions SET rog_claimed_at=NOW(), rog_claim_expires_at=$2, updated_at=NOW() WHERE session_ref=$1 RETURNING *`,
      [current.sessionRef, claimExpires.toISOString()]
    );
    await client.query('COMMIT');
    return { success: true, authorized: true, sessionRef: current.sessionRef, rogHumanPosition: Number(updated.rows[0].rog_human_position), expiresAt: row.rog_eligibility_expires_at, claimExpiresAt: claimExpires.toISOString() };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}

async function release(wallet, sessionRef) {
  const w = sessions.normalizeWallet(wallet);
  const row = await sessions.requireSession(sessionRef, w);
  if (row.status === 'POSITION_ASSIGNED' || row.pharaoh_tx_hash) return { success: true, released: false };
  await pg.query('UPDATE direct_donation_sessions SET rog_claimed_at=NULL, rog_claim_expires_at=NULL, updated_at=NOW() WHERE session_ref=$1 AND LOWER(wallet)=LOWER($2)', [sessionRef, w]);
  return { success: true, released: true };
}

async function assertClaimReady(wallet, sessionRef) {
  const w = sessions.normalizeWallet(wallet);
  await community.assertCommunityMember(w);
  const row = await sessions.requireSession(sessionRef, w);
  if (row.status === 'POSITION_ASSIGNED') return { alreadyCompleted: true, session: row };
  if (row.rog_eligibility_expires_at) {
    const claimExpiry = row.rog_claim_expires_at ? new Date(row.rog_claim_expires_at).getTime() : 0;
    if (!row.pharaoh_tx_hash && (!row.rog_claimed_at || claimExpiry <= Date.now())) throw makeError('Autorizzazione PHARAOH scaduta: riverificare i requisiti', 'DIRECT_AUTHORIZATION_REQUIRED', true);
    const live = await community._rogRequest(`/api/user-positions/${encodeURIComponent(w)}`);
    if (live?.degraded === true) throw makeError('ROG temporaneamente non disponibile', 'ROG_POSITION_VERIFY_RETRY', true);
    const found = (live.posizioni || []).find((p) => Number(p?.posizione) === Number(row.rog_human_position) && String(p?.wallet || '').toLowerCase() === w && String(p?.tipo || 'HUMAN').toUpperCase() === 'HUMAN');
    if (!found) throw makeError('La posizione HUMAN ROG non risulta piu verificabile', 'ROG_POSITION_NOT_FOUND', true);
    return { alreadyCompleted: false, rogHumanPosition: Number(row.rog_human_position), session: row };
  }
  return null;
}

module.exports = { getEligibility, authorize, release, assertClaimReady, WINDOW_MS, CLAIM_MS };

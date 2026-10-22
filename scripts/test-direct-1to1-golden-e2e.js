'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const wallet = '0x1111111111111111111111111111111111111111';
const wallet2 = '0x2222222222222222222222222222222222222222';
const wallet3 = '0x3333333333333333333333333333333333333333';
const treasury = '0x0000000000000000000000000000000000000002';
const hash = (byte) => `0x${byte.repeat(64)}`;
const nowSec = () => Math.floor(Date.now() / 1000);

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function err(message, code = 'ERROR') { const e = new Error(message); e.code = code; return e; }

class MemoryPg {
  constructor() {
    this.sessions = new Map();
    this.donations = [];
    this.candidates = [];
    this.positionSeq = 0;
  }
  rows() { return [...this.sessions.values()]; }
  async getClient() { return new MemoryClient(this); }
  async query(sql, values = []) { const client = await this.getClient(); try { return await client.query(sql, values); } finally { client.release(); } }
  uniqueConflict(targetRef, patch) {
    const checks = [
      ['rog_usdc_tx_hash', true], ['rog_register_tx_hash', true], ['rog_donation_id', false],
      ['rog_human_position', false], ['pharaoh_tx_hash', true], ['pharaoh_candidate_tx_hash', true], ['registry_tx_hash', true]
    ];
    for (const [field, lower] of checks) {
      if (patch[field] == null) continue;
      const incoming = lower ? String(patch[field]).toLowerCase() : String(patch[field]);
      for (const row of this.sessions.values()) {
        if (row.session_ref === targetRef || row[field] == null) continue;
        const existing = lower ? String(row[field]).toLowerCase() : String(row[field]);
        if (existing === incoming) return true;
      }
    }
    return false;
  }
}

class MemoryClient {
  constructor(db) { this.db = db; }
  release() {}
  async query(sql, values = []) {
    const compact = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)( |$)/i.test(compact)) return { rows: [] };
    if (/pg_advisory_(xact_)?lock|pg_advisory_unlock/i.test(compact)) return { rows: [] };

    if (/INSERT INTO direct_donation_sessions/i.test(compact)) {
      const [ref, w, amount] = values;
      const ts = new Date().toISOString();
      const row = {
        session_ref: ref, wallet: String(w).toLowerCase(), status: 'COMMUNITY_CONFIRMED', rog_amount_usdc: Number(amount),
        rog_usdc_tx_hash: null, rog_register_tx_hash: null, rog_donation_id: null, rog_proof: null, rog_result: null,
        rog_confirmed_at: null, pharaoh_amount_usdc: null, pharaoh_tx_hash: null, pharaoh_proof: null, pharaoh_verified_at: null,
        registry_tx_hash: null, registry_session_id: null, registry_block_number: null, registry_confirmed_at: null,
        position_result: null, last_error: null, completed_at: null, created_at: ts, updated_at: ts,
        rog_payment_confirmed_at: null, rog_registration_candidate_tx_hash: null, rog_registration_candidate_donation_id: null,
        rog_registration_candidate_at: null, rog_fulfillment_status: 'WAITING_PAYMENT', rog_human_position: null,
        rog_fulfillment_retry_count: 0, rog_fulfillment_last_error: null, rog_fulfillment_next_retry_at: null,
        rog_fulfillment_updated_at: null, rog_eligibility_source: null, rog_eligibility_completed_at: null,
        rog_eligibility_expires_at: null, rog_claimed_at: null, rog_claim_expires_at: null,
        pharaoh_broadcast_intent_at: null, pharaoh_broadcast_claim_expires_at: null,
        pharaoh_broadcast_eligibility_expires_at: null, pharaoh_broadcast_cancelled_at: null,
        pharaoh_broadcast_cancel_reason: null, pharaoh_candidate_tx_hash: null,
        pharaoh_candidate_recorded_at: null, pharaoh_candidate_source: null,
        pharaoh_reconciliation_last_error: null, pharaoh_reconciliation_updated_at: null
      };
      this.db.sessions.set(ref, row);
      return { rows: [clone(row)] };
    }

    if (/SELECT \* FROM direct_pharaoh_tx_candidates/i.test(compact)) {
      const ref = String(values[0]).toLowerCase(), tx = String(values[1]).toLowerCase();
      const found = this.db.candidates.find(c => c.session_ref === ref && c.tx_hash === tx);
      return { rows: found ? [clone(found)] : [] };
    }
    if (/SELECT COUNT\(\*\)::int AS count FROM direct_pharaoh_tx_candidates/i.test(compact)) {
      const ref = String(values[0]).toLowerCase();
      return { rows: [{ count: this.db.candidates.filter(c => c.session_ref === ref).length }] };
    }
    if (/INSERT INTO direct_pharaoh_tx_candidates/i.test(compact)) {
      const [sessionRef, txHash, source, replacesTxHash] = values;
      const ref = String(sessionRef).toLowerCase(), tx = String(txHash).toLowerCase();
      if (this.db.candidates.some(c => c.tx_hash === tx)) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
      const candidate = { id: this.db.candidates.length + 1, session_ref: ref, tx_hash: tx, source, replaces_tx_hash: replacesTxHash ? String(replacesTxHash).toLowerCase() : null, recorded_at: new Date().toISOString(), verified_at: null, last_error: null };
      this.db.candidates.push(candidate); return { rows: [clone(candidate)] };
    }
    if (/UPDATE direct_pharaoh_tx_candidates SET verified_at/i.test(compact)) {
      const ref = String(values[0]).toLowerCase(), tx = String(values[1]).toLowerCase();
      const found = this.db.candidates.find(c => c.session_ref === ref && c.tx_hash === tx);
      if (found) { found.verified_at ||= new Date().toISOString(); found.last_error = null; }
      return { rows: found ? [clone(found)] : [] };
    }

    if (/SELECT \* FROM direct_donation_sessions WHERE session_ref = \$1/i.test(compact) || /SELECT \* FROM direct_donation_sessions WHERE session_ref=\$1/i.test(compact)) {
      const row = this.db.sessions.get(String(values[0]).toLowerCase()) || this.db.sessions.get(String(values[0]));
      return { rows: row ? [clone(row)] : [] };
    }

    if (/FROM direct_donation_sessions WHERE LOWER\(wallet\)=LOWER\(\$1\) AND rog_eligibility_source=\$2 AND status NOT IN/i.test(compact)) {
      const w = String(values[0]).toLowerCase(), source = values[1];
      const rows = this.db.rows().filter(r => r.wallet === w && r.rog_eligibility_source === source && !['POSITION_ASSIGNED','CANCELLED'].includes(r.status))
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows: rows.slice(0,1).map(clone) };
    }

    if (/FROM direct_donation_sessions WHERE LOWER\(wallet\)=LOWER\(\$1\) AND rog_eligibility_source=\$2 AND status <> 'CANCELLED'/i.test(compact)) {
      const w = String(values[0]).toLowerCase(), source = values[1];
      const rows = this.db.rows().filter(r => r.wallet === w && r.rog_eligibility_source === source && r.status !== 'CANCELLED')
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows: rows.slice(0,25).map(clone) };
    }

    if (/SELECT id FROM donazioni WHERE LOWER\(tx_hash\) = \$1 LIMIT 1/i.test(compact)) {
      const tx = String(values[0]).toLowerCase();
      const found = this.db.donations.find(d => String(d.txHash).toLowerCase() === tx);
      return { rows: found ? [{ id: found.id }] : [] };
    }

    if (/UPDATE direct_donation_sessions/i.test(compact)) {
      const ref = String(values[0]).toLowerCase();
      const row = this.db.sessions.get(ref) || this.db.sessions.get(values[0]);
      if (!row) return { rows: [] };
      const patch = {};
      const setMatch = compact.match(/ SET (.+?) WHERE /i);
      if (!setMatch) throw new Error(`Unsupported UPDATE: ${compact}`);
      const assignments = setMatch[1].split(',').map(x => x.trim());
      for (const a of assignments) {
        let m = a.match(/^([a-z_]+) = \$(\d+)$/i);
        if (m) { patch[m[1]] = clone(values[Number(m[2]) - 1]); continue; }
        m = a.match(/^([a-z_]+)=\$(\d+)$/i);
        if (m) { patch[m[1]] = clone(values[Number(m[2]) - 1]); continue; }
        m = a.match(/^([a-z_]+)=(?:NOW\(\)|now\(\))$/i);
        if (m) { patch[m[1]] = new Date().toISOString(); continue; }
        m = a.match(/^([a-z_]+)=(?:NULL|null)$/i);
        if (m) { patch[m[1]] = null; continue; }
        m = a.match(/^([a-z_]+)='([^']*)'$/i);
        if (m) { patch[m[1]] = m[2]; continue; }
        // updated_at = NOW() is harmless and may appear with spaces.
        if (/^updated_at\s*=\s*NOW\(\)$/i.test(a)) { patch.updated_at = new Date().toISOString(); continue; }
        throw new Error(`Unsupported assignment: ${a}`);
      }
      if (this.db.uniqueConflict(row.session_ref, patch)) {
        const e = new Error('duplicate key'); e.code = '23505'; throw e;
      }
      Object.assign(row, patch, { updated_at: new Date().toISOString() });
      return { rows: [clone(row)] };
    }

    throw new Error(`Unsupported SQL: ${compact}`);
  }
}

const mem = new MemoryPg();
let currentHumanCreatedAt = () => new Date().toISOString();
let currentHumanPosition = 7001;
let currentPositions = [];
let proofTimes = new Map();
let registryFailOnce = false;
let registrySeq = 900;

const communityStub = {
  async assertCommunityMember(w) { return { success: true, wallet: String(w).toLowerCase(), registered: true }; },
  async getCommunityStatus(w) { return { success: true, wallet: String(w).toLowerCase(), registered: true }; },
  async _rogRequest(path) {
    if (path.startsWith('/api/user-positions/')) return { success: true, posizioni: clone(currentPositions) };
    return { success: true };
  }
};

const rogStub = {
  getConfig() { return { amountUsdc: 2 }; },
  async verifyRogUsdcTransfer({ txHash: tx, wallet: w, amountUsdc }) {
    return { txHash: tx.toLowerCase(), wallet: w.toLowerCase(), amountUsdc, blockNumber: 100, blockTimestamp: proofTimes.get(tx.toLowerCase()) ?? nowSec(), confirmations: 2 };
  },
  async verifyRogRegistration({ registerTxHash, wallet: w, amountUsdc, donationId }) {
    return { txHash: registerTxHash.toLowerCase(), donor: w.toLowerCase(), amountUsdc, donationId: String(donationId), blockNumber: 101, blockTimestamp: proofTimes.get(registerTxHash.toLowerCase()) ?? nowSec(), confirmations: 2 };
  },
  async finalizeRogDonation({ wallet: w }) {
    const human = { posizione: currentHumanPosition, wallet: w.toLowerCase(), tipo: 'HUMAN', created_at: currentHumanCreatedAt() };
    currentPositions = [human, ...currentPositions.filter(p => Number(p.posizione) !== Number(human.posizione))];
    return { success: true, completion: { success: true, status: 'COMPLETED', positions: { posizioni: [human] } } };
  }
};

const dbStub = {
  async initDatabase() { return true; },
  async createDonazione(data) { const row = { id: mem.donations.length + 1, ...clone(data), txHash: data.txHash }; mem.donations.push(row); return row; }
};
const verifierStub = {
  async verificaDonazione({ txHash, walletMittente }) {
    return {
      txHash: txHash.toLowerCase(), numeroPosizioni: 1, importoEffettivo: 100,
      proof: { txHash: txHash.toLowerCase(), from: walletMittente.toLowerCase(), to: treasury, amountUsdc: 100,
        amountBaseUnits: '100000000', tokenContract: '0x3333333333333333333333333333333333333333', chainId: '137',
        blockNumber: '200', blockHash: hash('a'), confirmations: '5', transferLogIndexes: [0] }
    };
  }
};
const registryStub = {
  async registerDirectIncoming({ session, onSubmitted }) {
    const tx = hash(registrySeq % 10 === 0 ? 'b' : String(registrySeq % 10));
    registrySeq += 1;
    if (onSubmitted) await onSubmitted(tx);
    if (registryFailOnce) { registryFailOnce = false; throw err('injected registry interruption', 'INJECTED_REGISTRY_INTERRUPTION'); }
    return { txHash: tx, txId: registrySeq, blockNumber: 500 + registrySeq };
  }
};
const economicLedgerStub = { configuredLedger: () => ({ ready: async () => true }) };
const economicFlowStub = {
  configuredFlow: () => ({
    admitExternal: async ({ eventKey, beneficiaryWallet }) => ({
      positions: [{ positionId: ++mem.positionSeq, accountId: mem.positionSeq, number: mem.positionSeq, sigla: String(mem.positionSeq), tableId: 1, tableNumber: 1,
        slot: mem.positionSeq, personalTableId: 100 + mem.positionSeq, personalTableNumber: 100 + mem.positionSeq, completed: false,
        turnId: 1, turnNumber: 1, heirAccountId: 1, heirWallet: treasury, positionClass: 'HUMAN', origin: 'DIRECT', ownerWallet: beneficiaryWallet, index: 1,
        eventKey }
      ]
    })
  }),
  publicPosition: p => ({ posizione_id: p.positionId, numero_posizionale: p.number, sigla: p.sigla, tavola_id: p.tableId, casella: p.slot })
};

const originalLoad = Module._load;
const stubbed = new Map([
  ['./pg-connection-manager', mem],
  ['./rog-community-manager', communityStub],
  ['./rog-donation-manager', rogStub],
  ['./db-manager', dbStub],
  ['./table-manager', {}], ['./container-manager', {}], ['./function-manager', {}],
  ['./rules-engine', { IMPORTI: { DONO_ENTRATA: 100 } }],
  ['./blockchain-verifier', verifierStub], ['./payout-manager', {}],
  ['./pharaoh-registry-manager', registryStub], ['./cross-outbound-manager', {}],
  ['./economic-ledger', economicLedgerStub], ['./economic-flow', economicFlowStub]
]);
Module._load = function(request, parent, isMain) {
  if (stubbed.has(request)) return stubbed.get(request);
  return originalLoad.call(this, request, parent, isMain);
};

let sessions, eligibility, direct, donationFlow;
sessions = require('../direct-donation-session-manager');
eligibility = require('../direct-rog-eligibility-manager');
direct = require('../direct-donation-manager');
// Let donation-flow-manager use the already loaded real DIRECT modules.
stubbed.set('./direct-donation-manager', direct);
stubbed.set('./direct-donation-session-manager', sessions);
donationFlow = require('../donation-flow-manager');

function row(ref) { return mem.sessions.get(String(ref).toLowerCase()) || mem.sessions.get(ref); }
async function expectCode(promiseFactory, code) {
  await assert.rejects(promiseFactory, e => e && e.code === code, `expected ${code}`);
}

async function completeFreshRog({ w, sessionRef, usdcTx, registerTx, donationId, humanPosition }) {
  currentHumanPosition = humanPosition;
  currentHumanCreatedAt = () => new Date(Date.now() + 500).toISOString();
  proofTimes.set(usdcTx.toLowerCase(), nowSec());
  proofTimes.set(registerTx.toLowerCase(), nowSec());
  const result = await direct.confirmRogDonation({ wallet: w, sessionRef, rogUsdcTxHash: usdcTx, rogRegisterTxHash: registerTx, rogDonationId: String(donationId) });
  assert.equal(result.canProceedToPharaoh, true);
  assert.equal(result.rogHumanPosition, humanPosition);
}

async function run() {
  let checks = 0;
  // Historical HUMAN exists before any PHARAOH cycle: must not auto-bind.
  currentPositions = [{ posizione: 6000, wallet, tipo: 'HUMAN', created_at: new Date().toISOString() }];
  let e = await eligibility.getEligibility(wallet);
  assert.equal(e.reason, 'DIRECT_CYCLE_REQUIRED');
  assert.equal(mem.sessions.size, 0); checks++;

  // Cycle #1 must start BEFORE its ROG proof.
  const s1 = (await direct.startSession(wallet)).session.sessionRef;
  assert.equal(row(s1).rog_eligibility_source, sessions.DIRECT_ROG_PROTOCOL); checks++;
  const oldUsdc = hash('1');
  proofTimes.set(oldUsdc, Math.floor((new Date(row(s1).created_at).getTime() - 120000) / 1000));
  await expectCode(() => direct.confirmRogPayment({ wallet, sessionRef: s1, rogUsdcTxHash: oldUsdc }), 'DIRECT_ROG_PROOF_NOT_FRESH'); checks++;

  const usdc1 = hash('2'), reg1 = hash('3');
  await completeFreshRog({ w: wallet, sessionRef: s1, usdcTx: usdc1, registerTx: reg1, donationId: 1001, humanPosition: 7001 });
  assert.equal(row(s1).rog_human_position, 7001); checks++;

  const a1 = await eligibility.authorize(wallet, s1);
  assert.equal(a1.authorized, true); checks++;
  // Second browser/device cannot claim concurrently.
  await expectCode(() => eligibility.authorize(wallet, s1), 'ROG_PROOF_CLAIMED'); checks++;
  // A claim without a server broadcast intent cannot be cleared early: it
  // expires naturally, because no generic cleanup may authorize a second try.
  assert.equal((await eligibility.release(wallet, s1, { reason: 'EXPLICIT_USER_REJECTION' })).released, false);
  row(s1).rog_claim_expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await eligibility.authorize(wallet, s1)).authorized, true); checks++;
  // Claim timeout is fail-closed, then a fresh authorize repairs it.
  row(s1).rog_claim_expires_at = new Date(Date.now() - 1000).toISOString();
  await expectCode(() => direct.assertReadyForPharaoh({ wallet, sessionRef: s1 }), 'DIRECT_AUTHORIZATION_REQUIRED');
  row(s1).rog_eligibility_expires_at = new Date(Date.now() + 45_000).toISOString();
  const capped = await eligibility.authorize(wallet, s1);
  assert.equal(capped.authorized, true);
  assert.ok(Date.parse(capped.claimExpiresAt) <= Date.parse(capped.expiresAt), 'claim non deve oltrepassare la finestra ROG'); checks++;

  const pharaoh1 = hash('4');
  const intent1 = await eligibility.markBroadcastIntent(wallet, s1);
  assert.equal(intent1.intentRecorded, true);
  const candidate1 = await eligibility.attachCandidate(wallet, s1, pharaoh1, 'TEST');
  assert.equal(candidate1.candidateRecorded, true);
  assert.equal(mem.donations.length, 0, 'intento/hash candidato non devono creare posizioni');
  assert.equal((await eligibility.release(wallet, s1)).released, false, 'un intento non deve essere liberato senza rifiuto esplicito');
  await expectCode(() => eligibility.attachCandidate(wallet, s1, hash('9'), 'TEST'), 'DIRECT_SESSION_PROOF_CONFLICT');
  const replacementCandidate = hash('8');
  const replaced = await eligibility.attachCandidate(wallet, s1, replacementCandidate, 'WALLET_REPLACEMENT', pharaoh1);
  assert.equal(replaced.candidateRecorded, true);
  assert.equal(mem.candidates.length, 2, 'la sostituzione deve essere append-only');
  assert.equal(mem.candidates[0].tx_hash, pharaoh1);
  assert.equal(mem.candidates[1].replaces_tx_hash, pharaoh1);
  row(s1).rog_claim_expires_at = new Date(Date.now() - 1000).toISOString();
  row(s1).rog_eligibility_expires_at = new Date(Date.now() - 1000).toISOString();
  const sameRecovery = await direct.startSession(wallet);
  assert.equal(sameRecovery.session.sessionRef, s1, 'sessione incerta non deve essere cancellata dopo scadenza');
  assert.equal(sameRecovery.recovery, true);
  assert.equal((await eligibility.getEligibility(wallet)).rog, 'RECOVERY'); checks++;
  const p1 = await donationFlow.processaDonoEntrataWallet({ wallet, txHash: replacementCandidate, sessionRef: s1, nome: 'QA ONE' });
  assert.equal(p1.numeroPosizioni, 1);
  assert.equal(row(s1).status, 'POSITION_ASSIGNED');
  assert.equal(mem.donations.length, 1); checks++;
  const retry1 = await donationFlow.processaDonoEntrataWallet({ wallet, txHash: replacementCandidate, sessionRef: s1, nome: 'QA ONE' });
  assert.equal(retry1.idempotent, true);
  assert.equal(mem.donations.length, 1); checks++;

  // New PHARAOH position => new cycle. Reusing old ROG tx must fail.
  const s2 = (await direct.startSession(wallet)).session.sessionRef;
  assert.notEqual(s2, s1); checks++;
  await expectCode(() => direct.confirmRogPayment({ wallet, sessionRef: s2, rogUsdcTxHash: usdc1 }), 'DIRECT_SESSION_PROOF_CONFLICT'); checks++;

  const usdc2 = hash('5'), reg2 = hash('6');
  await completeFreshRog({ w: wallet, sessionRef: s2, usdcTx: usdc2, registerTx: reg2, donationId: 1002, humanPosition: 7002 });
  await eligibility.authorize(wallet, s2);

  // Inject interruption AFTER the PHARAOH tx hash is persisted; retry must recover same cycle without new ROG/claim.
  registryFailOnce = true;
  const pharaoh2 = hash('7');
  await expectCode(() => donationFlow.processaDonoEntrataWallet({ wallet, txHash: pharaoh2, sessionRef: s2, nome: 'QA TWO' }), 'INJECTED_REGISTRY_INTERRUPTION');
  assert.equal(row(s2).pharaoh_tx_hash, pharaoh2);
  row(s2).rog_claimed_at = null; row(s2).rog_claim_expires_at = null;
  const recovered = await donationFlow.processaDonoEntrataWallet({ wallet, txHash: pharaoh2, sessionRef: s2, nome: 'QA TWO' });
  assert.equal(recovered.numeroPosizioni, 1);
  assert.equal(row(s2).status, 'POSITION_ASSIGNED');
  assert.equal(mem.donations.length, 2); checks++;

  // Solo il rifiuto esplicito del wallet puo annullare un intento senza hash.
  const sReject = (await direct.startSession(wallet3)).session.sessionRef;
  await completeFreshRog({ w: wallet3, sessionRef: sReject, usdcTx: hash('a'), registerTx: hash('b'), donationId: 1003, humanPosition: 7003 });
  await eligibility.authorize(wallet3, sReject);
  await eligibility.markBroadcastIntent(wallet3, sReject);
  const rejected = await eligibility.release(wallet3, sReject, { reason: 'EXPLICIT_USER_REJECTION' });
  assert.equal(rejected.released, true);
  assert.equal(rejected.intentCancelled, true);
  assert.equal(row(sReject).pharaoh_broadcast_cancel_reason, 'EXPLICIT_USER_REJECTION');
  assert.equal(sessions.hasPharaohReconciliationEvidence(row(sReject)), false);
  assert.equal((await eligibility.authorize(wallet3, sReject)).authorized, true);
  const restartedIntent = await eligibility.markBroadcastIntent(wallet3, sReject);
  assert.equal(restartedIntent.intentRecorded, true);
  assert.equal(row(sReject).pharaoh_broadcast_cancelled_at, null); checks++;

  // HUMAN older than cycle is rejected centrally even if a ROG completion tries to return it.
  const s3 = (await direct.startSession(wallet2)).session.sessionRef;
  currentHumanPosition = 8001;
  const staleHuman = { completion: { positions: { posizioni: [{ posizione: 8001, wallet: wallet2, tipo: 'HUMAN', created_at: new Date(new Date(row(s3).created_at).getTime() - 120000).toISOString() }] } } };
  await expectCode(() => sessions.recordRogFulfillmentCompleted({ sessionRef: s3, wallet: wallet2, rogResult: staleHuman }), 'DIRECT_ROG_HUMAN_NOT_FRESH'); checks++;

  // Explicitly verify final one-to-one mapping.
  const used = [row(s1), row(s2)];
  assert.deepEqual(used.map(r => r.rog_human_position), [7001, 7002]);
  assert.equal(new Set(used.map(r => r.rog_usdc_tx_hash)).size, 2);
  assert.equal(new Set(used.map(r => r.rog_donation_id)).size, 2);
  assert.equal(new Set(mem.donations.map(d => d.sourceEventKey)).size, 2);
  assert.equal(mem.positionSeq, 2); checks++;

  console.log(JSON.stringify({
    status: 'PASS', checks,
    invariant: '1 NEW ROG donation -> 1 NEW HUMAN ROG -> 1 PHARAOH position',
    assignedSessions: used.length, pharaohPositions: mem.positionSeq,
    cases: ['historical-human-rejected','proof-before-cycle-rejected','fresh-cycle-pass','double-browser-claim-blocked','claim-generic-release-blocked','claim-timeout','claim-capped-by-rog-window','server-broadcast-intent','explicit-user-rejection-cancels-intent','candidate-no-credit','candidate-conflict','candidate-replacement-append-only','recovery-after-claim-and-rog-expiry','idempotent-retry','rog-replay-blocked','pharaoh-tx-known-recovery','stale-human-rejected','second-position-new-cycle'],
    scope: 'Golden application-flow E2E with in-memory PostgreSQL/chain/ROG adapters; no production, no live chain, no real PostgreSQL server'
  }, null, 2));
}

run().then(() => { Module._load = originalLoad; }).catch(e => { Module._load = originalLoad; console.error(e); process.exit(1); });

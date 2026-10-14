'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const pgStub = { query: async () => ({ rows: [] }), getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
Module._load = function(request, parent, isMain) {
  if (request === './pg-connection-manager') return pgStub;
  if (request === './rog-community-manager') return { assertCommunityMember: async () => true, _rogRequest: async () => ({ success: true, posizioni: [] }) };
  if (request === './rog-donation-manager') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const direct = require('../direct-donation-manager');
const sessionsModule = require('../direct-donation-session-manager');
Module._load = originalLoad;

const wallet = '0x1111111111111111111111111111111111111111';
const sessionRef = '0x' + '22'.repeat(32);
const usdc = '0x' + '33'.repeat(32);
const register = '0x' + '44'.repeat(32);

function baseRow(overrides = {}) {
  return {
    session_ref: sessionRef,
    wallet,
    status: 'ROG_CONFIRMED',
    rog_amount_usdc: 2,
    rog_usdc_tx_hash: usdc,
    rog_register_tx_hash: register,
    rog_donation_id: '123',
    rog_payment_confirmed_at: new Date().toISOString(),
    rog_confirmed_at: new Date().toISOString(),
    rog_proof: {
      usdc: { txHash: usdc, wallet, amountUsdc: 2, blockNumber: 100 },
      registration: { txHash: register, donor: wallet, donationId: '123', blockNumber: 101 }
    },
    rog_fulfillment_status: 'COMPLETED',
    rog_human_position: 77,
    created_at: new Date(Date.now() - 5000).toISOString(),
    ...overrides
  };
}

function deps(row) {
  return {
    sessions: {
      normalizeWallet: v => String(v).toLowerCase(),
      requireSession: async () => row,
      publicSession: r => ({ status: r.status, rogFulfillmentStatus: r.rog_fulfillment_status, rogHumanPosition: r.rog_human_position })
    },
    community: { assertCommunityMember: async () => true }
  };
}

async function testGateRejectsPaymentOnly() {
  const row = baseRow({
    status: 'ROG_PAYMENT_CONFIRMED',
    rog_register_tx_hash: null,
    rog_donation_id: null,
    rog_confirmed_at: null,
    rog_proof: { usdc: { txHash: usdc } },
    rog_fulfillment_status: 'WAITING_REGISTRATION',
    rog_human_position: null
  });
  await assert.rejects(
    () => direct.assertReadyForPharaoh({ wallet, sessionRef }, deps(row)),
    e => e && e.code === 'DIRECT_ROG_POSITION_REQUIRED'
  );
}

async function testGateRejectsProcessingWithoutHuman() {
  const row = baseRow({ rog_confirmed_at: null, rog_fulfillment_status: 'PROCESSING', rog_human_position: null });
  await assert.rejects(
    () => direct.assertReadyForPharaoh({ wallet, sessionRef }, deps(row)),
    e => e && e.code === 'DIRECT_ROG_POSITION_REQUIRED'
  );
}

async function testGateRejectsMissingRegistrationProof() {
  const row = baseRow({ rog_proof: { usdc: { txHash: usdc } } });
  await assert.rejects(
    () => direct.assertReadyForPharaoh({ wallet, sessionRef }, deps(row)),
    e => e && e.code === 'DIRECT_ROG_PROOF_REQUIRED'
  );
}

async function testGateAcceptsCompletedHuman() {
  const row = baseRow();
  const result = await direct.assertReadyForPharaoh({ wallet, sessionRef }, deps(row));
  assert.equal(result.alreadyCompleted, false);
  assert.equal(result.rogFulfillmentPending, false);
  assert.equal(result.rogHumanPosition, 77);
}

async function testPositionVerifyMatchesAuthoritativeSessionAndRog() {
  const row = baseRow();
  const dependencies = deps(row);
  dependencies.rogApi = {
    _rogRequest: async () => ({
      success: true,
      posizioni: [{ posizione: 77, wallet: wallet.toUpperCase(), tipo: 'HUMAN', created_at: new Date().toISOString() }]
    })
  };
  const result = await direct.verifyRogPositionForSession({ wallet, sessionRef, rogPosition: 77 }, dependencies);
  assert.equal(result.verified, true);
  assert.equal(result.rogHumanPosition, 77);
}

async function testPositionVerifyRejectsDifferentPosition() {
  const row = baseRow();
  await assert.rejects(
    () => direct.verifyRogPositionForSession({ wallet, sessionRef, rogPosition: 76 }, deps(row)),
    e => e && e.code === 'ROG_POSITION_NOT_FOUND'
  );
}

async function testRecordCompletedRejectsMissingHuman() {
  let queryCount = 0;
  const client = {
    async query(sql) {
      queryCount += 1;
      if (/SELECT \* FROM direct_donation_sessions/.test(sql)) return { rows: [baseRow({ rog_human_position: null })] };
      throw new Error('UPDATE must not run when HUMAN position is missing');
    }
  };
  await assert.rejects(
    () => sessionsModule.recordRogFulfillmentCompleted({
      sessionRef,
      wallet,
      rogResult: { completion: { positions: { posizioni: [] } } }
    }, client),
    e => e && e.code === 'DIRECT_ROG_HUMAN_POSITION_REQUIRED'
  );
  assert.equal(queryCount, 1);
}

(async () => {
  await testGateRejectsPaymentOnly();
  await testGateRejectsProcessingWithoutHuman();
  await testGateRejectsMissingRegistrationProof();
  await testGateAcceptsCompletedHuman();
  await testPositionVerifyMatchesAuthoritativeSessionAndRog();
  await testPositionVerifyRejectsDifferentPosition();
  await testRecordCompletedRejectsMissingHuman();
  console.log('DIRECT_ROG_POSITION_MANDATORY_TESTS=PASS');
})().catch(err => {
  console.error(err);
  process.exit(1);
});

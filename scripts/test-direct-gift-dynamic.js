'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;

process.env.NODE_ENV = 'test';
process.env.PHARAOH_TREASURY_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const WALLET = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const BENEFICIARY = '0x3333333333333333333333333333333333333333';
const SESSION = `0x${'d'.repeat(64)}`;
const ROG_TX = `0x${'e'.repeat(64)}`;
const PHARAOH_TX = `0x${'1'.repeat(64)}`;
const GIFT_ID = `gift_${'g'.repeat(24)}`;

const directSessionStub = {};
const giftSessionStub = {};
const rogGiftStub = {};
const rogCommunityStub = {};
const verifierStub = {};
const verifiedEntryStub = {};
const registryStub = {};
const pgStub = { query: async () => ({ rows: [] }), getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }) };

Module._load = function(request, parent, isMain) {
  if (request === './pg-connection-manager') return pgStub;
  if (request === './direct-donation-session-manager') return directSessionStub;
  if (request === './rog-community-manager') return rogCommunityStub;
  if (request === './rog-donation-manager') return {};
  if (request === './gift-session-manager') return giftSessionStub;
  if (request === './rog-gift-manager') return rogGiftStub;
  if (request === './blockchain-verifier') return verifierStub;
  if (request === './verified-entry-manager') return verifiedEntryStub;
  if (request === './pharaoh-registry-manager') return registryStub;
  return originalLoad.call(this, request, parent, isMain);
};
const direct = require('../direct-donation-manager');
const giftFlow = require('../gift-flow-manager');
Module._load = originalLoad;

function fakeLockPg() {
  return {
    async getClient() {
      return { async query(sql) { if (!sql.includes('pg_advisory_')) throw new Error(`Unexpected SQL ${sql}`); return { rows: [] }; }, release() {} };
    }
  };
}

async function testDirectPaymentOnlyOpensPharaohGate() {
  const calls = [];
  let row = {
    session_ref: SESSION,
    wallet: WALLET,
    status: 'COMMUNITY_CONFIRMED',
    rog_amount_usdc: 2,
    rog_usdc_tx_hash: null,
    rog_payment_confirmed_at: null,
    rog_proof: null,
    rog_register_tx_hash: null,
    rog_donation_id: null,
    rog_fulfillment_status: 'WAITING_PAYMENT',
    rog_human_position: null
  };
  const sessions = {
    normalizeWallet: x => String(x).toLowerCase(),
    normalizeHash: x => String(x).toLowerCase(),
    async requireSession() { return { ...row }; },
    async recordError() {},
    async recordRogPaymentConfirmed(args) {
      row = {
        ...row,
        status: 'ROG_PAYMENT_CONFIRMED',
        rog_usdc_tx_hash: args.usdcTxHash,
        rog_payment_confirmed_at: new Date().toISOString(),
        rog_proof: { usdc: args.proof },
        rog_fulfillment_status: 'WAITING_REGISTRATION'
      };
      return { ...row };
    },
    publicSession: r => ({ status: r.status, rogPaymentConfirmedAt: r.rog_payment_confirmed_at, rogHumanPosition: r.rog_human_position || null })
  };
  const result = await direct.confirmRogPayment({ wallet: WALLET, sessionRef: SESSION, rogUsdcTxHash: ROG_TX }, {
    pg: fakeLockPg(),
    community: { async assertCommunityMember() { calls.push('community'); } },
    sessions,
    rogDonation: {
      async verifyRogUsdcTransfer() {
        calls.push('usdc');
        return { txHash: ROG_TX, from: WALLET, amountUsdc: 2, blockNumber: 100, confirmations: 2 };
      }
    }
  });
  assert.deepEqual(calls, ['community', 'usdc']);
  assert.equal(result.canProceedToPharaoh, true);
  assert.equal(result.session.status, 'ROG_PAYMENT_CONFIRMED');

  const gate = await direct.assertReadyForPharaoh({ wallet: WALLET, sessionRef: SESSION }, {
    community: { async assertCommunityMember() {} },
    sessions: {
      normalizeWallet: x => String(x).toLowerCase(),
      async requireSession() { return { ...row }; }
    }
  });
  assert.equal(gate.alreadyCompleted, false);
  assert.equal(gate.rogFulfillmentPending, true);
  assert.equal(row.rog_human_position, null);
}

async function testGiftTwoRogThenHundredPharaohWithoutBeneficiaryCommunityGate() {
  let status = 'ROG_PAYMENT_CONFIRMED';
  let communityTouched = false;
  let row = {
    gift_id: GIFT_ID,
    payment_wallet: PAYER,
    beneficiary_wallet: BENEFICIARY,
    rog_amount_usdc: 2,
    status,
    rog_usdc_tx_hash: ROG_TX,
    rog_transfer_proof: { blockNumber: 100 },
    rog_register_tx_hash: null,
    rog_donation_id: null,
    rog_result: null,
    pharaoh_tx_hash: null,
    pharaoh_proof: null,
    position_result: null
  };

  Object.assign(giftSessionStub, {
    normalizeGiftId: x => x,
    normalizeWallet: x => String(x).toLowerCase(),
    normalizeHash: x => String(x).toLowerCase(),
    normalizeGiftAmount: x => Number(x),
    withGiftLock: async (_id, op) => op(),
    assertActive: x => x,
    statusAtLeast: (r, wanted) => {
      const order = { CREATED: 10, ROG_PAYMENT_CONFIRMED: 20, ROG_REGISTERED: 30, ROG_COMPLETED: 40, PHARAOH_VERIFIED: 50, POSITION_ASSIGNED: 60 };
      return (order[r.status] || 0) >= (order[wanted] || 0);
    },
    requireSession: async () => ({ ...row }),
    publicSession: r => ({ ...r }),
    recordPharaohVerified: async args => {
      status = 'PHARAOH_VERIFIED';
      row = { ...row, status, pharaoh_tx_hash: args.txHash, pharaoh_amount_usdc: 100, pharaoh_proof: args.proof };
      return { ...row };
    },
    recordRegistrySubmitted: async ({ txHash }) => ({ ...row, registry_tx_hash: txHash }),
    recordRegistryConfirmed: async ({ txHash, txId, blockNumber }) => {
      row = { ...row, registry_tx_hash: txHash, registry_session_id: txId, registry_block_number: blockNumber, registry_confirmed_at: new Date().toISOString() };
      return { ...row };
    },
    markPositionAssigned: async ({ result }) => {
      status = 'POSITION_ASSIGNED';
      row = { ...row, status, position_result: result };
      return { ...row };
    },
    recordError: async () => null
  });

  rogCommunityStub.getCommunityStatus = async () => { communityTouched = true; throw new Error('BENEFICIARY COMMUNITY MUST NOT BE CALLED'); };
  verifierStub.verificaDonazione = async () => ({
    txHash: PHARAOH_TX,
    importoEffettivo: 100,
    numeroPosizioni: 1,
    proof: { txHash: PHARAOH_TX, from: PAYER, to: process.env.PHARAOH_TREASURY_WALLET, amountUsdc: 100, blockNumber: 102 }
  });
  registryStub.registerGiftIncoming = async ({ onSubmitted }) => {
    const txHash = `0x${'9'.repeat(64)}`;
    await onSubmitted(txHash);
    return { txHash, txId: 55, blockNumber: 103 };
  };
  verifiedEntryStub.assignOneVerifiedEntry = async args => {
    assert.equal(args.paymentWallet, PAYER);
    assert.equal(args.beneficiaryWallet, BENEFICIARY);
    assert.equal(args.amountUsdc, 100);
    assert.equal(args.sourcePlatform, 'GIFT');
    const result = { success: true, beneficiaryWallet: BENEFICIARY, numeroPosizioni: 1 };
    await args.atomicComplete({}, result);
    return result;
  };

  const result = await giftFlow.processPharaohPayment({ giftId: GIFT_ID, paymentWallet: PAYER, pharaohTxHash: PHARAOH_TX });
  assert.equal(result.success, true);
  assert.equal(status, 'POSITION_ASSIGNED');
  assert.equal(communityTouched, false);
}

(async () => {
  await testDirectPaymentOnlyOpensPharaohGate();
  await testGiftTwoRogThenHundredPharaohWithoutBeneficiaryCommunityGate();
  console.log('PASS DIRECT: 2 USDC ROG verificati aprono subito il gate 100 USDC PHARAOH; ROG fulfillment resta asincrono');
  console.log('PASS GIFT: donor paga 2 ROG + 100 PHARAOH; posizione al beneficiario; nessun gate Community sul beneficiario durante il dono');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

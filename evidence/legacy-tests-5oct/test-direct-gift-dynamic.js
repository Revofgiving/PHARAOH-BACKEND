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
  assert.equal(result.canProceedToPharaoh, false);
  assert.equal(result.session.status, 'ROG_PAYMENT_CONFIRMED');

  await assert.rejects(
    () => direct.assertReadyForPharaoh({ wallet: WALLET, sessionRef: SESSION }, {
      community: { async assertCommunityMember() {} },
      sessions: {
        normalizeWallet: x => String(x).toLowerCase(),
        async requireSession() { return { ...row }; }
      }
    }),
    err => err && err.code === 'DIRECT_ROG_POSITION_REQUIRED'
  );
  assert.equal(row.rog_human_position, null);
}

async function testGiftSmartboxRequiresBeneficiaryCommunity() {
  const future = new Date(Date.now() + 86400000).toISOString();
  const row = {
    gift_id: GIFT_ID,
    payment_wallet: PAYER,
    beneficiary_wallet: null,
    rog_amount_usdc: 2,
    status: 'PAID_AWAITING_ACTIVATION',
    rog_usdc_tx_hash: ROG_TX,
    rog_register_tx_hash: `0x${'7'.repeat(64)}`,
    rog_donation_id: '99',
    pharaoh_tx_hash: PHARAOH_TX,
    pharaoh_proof: { txHash: PHARAOH_TX, from: PAYER, amountUsdc: 100, blockNumber: 102 },
    activation_expires_at: future,
    position_result: null
  };
  Object.assign(giftSessionStub, {
    normalizeGiftId: x => x,
    normalizeWallet: x => String(x).toLowerCase(),
    getSessionByGiftCode: async () => ({ ...row }),
    withGiftLock: async (_id, op) => op(),
    assertActive: x => x,
    requireSession: async () => ({ ...row }),
    publicSession: r => ({ ...r }),
    recordError: async () => null
  });
  let checked = false;
  rogCommunityStub.getCommunityStatus = async wallet => {
    checked = true;
    assert.equal(wallet, BENEFICIARY);
    return { success: true, registered: false };
  };
  await assert.rejects(
    () => giftFlow.redeemSmartboxGift({ giftCode: 'PHR-AAAA-BBBB-CCCC-DDDD', beneficiaryWallet: BENEFICIARY }),
    err => err && err.code === 'GIFT_BENEFICIARY_COMMUNITY_REQUIRED'
  );
  assert.equal(checked, true);
}

(async () => {
  await testDirectPaymentOnlyOpensPharaohGate();
  await testGiftSmartboxRequiresBeneficiaryCommunity();
  console.log('PASS DIRECT: 2 USDC ROG verificati non aprono il gate finche la HUMAN ROG non e COMPLETED');
  console.log('PASS GIFT SMARTBOX: il beneficiario non puo attivare il codice senza Community ROG personale');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

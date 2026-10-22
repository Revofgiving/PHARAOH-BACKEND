'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './pg-connection-manager') return {};
  if (request === './rog-community-manager') return {};
  if (request === './direct-rog-eligibility-manager') return {};
  if (request === './rog-donation-manager') return {};
  if (request === './direct-donation-session-manager') return { DIRECT_ROG_PROTOCOL: 'ROG_DIRECT_CYCLE_1TO1_V2', ROG_FRESHNESS_SKEW_MS: 5000 };
  return originalLoad.call(this, request, parent, isMain);
};
const direct = require('../direct-donation-manager');
Module._load = originalLoad;

const wallet = '0x' + '1'.repeat(40);
const sessionRef = '0x' + 'a'.repeat(64);
const rogHash = '0x' + 'b'.repeat(64);
const PROTOCOL = 'ROG_DIRECT_CYCLE_1TO1_V2';

function fakePg() {
  const client = {
    async query(sql) {
      if (/SELECT \*/.test(sql) && /direct_donation_sessions/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  return { async getClient() { return client; } };
}

(async () => {
  let communityChecks = 0;
  const created = {
    session_ref: sessionRef,
    wallet,
    status: 'SESSION_OPEN',
    rog_amount_usdc: 2,
    rog_eligibility_source: null,
    created_at: new Date(Date.now() - 1000).toISOString()
  };
  const sessionManager = {
    DIRECT_ROG_PROTOCOL: PROTOCOL,
    ROG_FRESHNESS_SKEW_MS: 5000,
    normalizeWallet: v => String(v).toLowerCase(),
    normalizeHash: v => String(v).toLowerCase(),
    hasPharaohReconciliationEvidence: () => false,
    publicSession: row => ({
      sessionRef: row.session_ref,
      wallet: row.wallet,
      status: row.status,
      rogAmountUsdc: Number(row.rog_amount_usdc),
      rogEligibilitySource: row.rog_eligibility_source || null
    }),
    async createSession() { return { ...created }; },
    async updateSession(ref, fields) { assert.equal(ref, sessionRef); Object.assign(created, fields); return { ...created }; }
  };
  const dependencies = {
    pg: fakePg(),
    community: { async assertCommunityMember() { communityChecks++; throw new Error('Community must not be checked by startSession'); } },
    sessions: sessionManager,
    rogDonation: { getConfig() { return { amountUsdc: 2 }; } }
  };

  const opened = await direct.startSession(wallet, dependencies);
  assert.equal(opened.success, true);
  assert.equal(opened.session.sessionRef, sessionRef);
  assert.equal(opened.session.status, 'SESSION_OPEN');
  assert.equal(communityChecks, 0, 'startSession must precede Community verification');

  const row = {
    ...created,
    rog_eligibility_source: PROTOCOL,
    rog_usdc_tx_hash: null,
    rog_payment_confirmed_at: null,
    rog_fulfillment_status: 'WAITING_PAYMENT'
  };
  const paymentSessionManager = {
    ...sessionManager,
    async requireSession(ref, w) { assert.equal(ref, sessionRef); assert.equal(w, wallet); return row; },
    async updateSession(ref, fields) { assert.equal(ref, sessionRef); Object.assign(row, fields); return { ...row }; },
    async recordRogPaymentConfirmed({ sessionRef: ref, wallet: w, usdcTxHash, proof }) {
      assert.equal(ref, sessionRef); assert.equal(w, wallet); assert.equal(row.status, 'COMMUNITY_CONFIRMED');
      row.rog_usdc_tx_hash = usdcTxHash;
      row.rog_payment_confirmed_at = new Date().toISOString();
      row.rog_proof = { usdc: proof };
      row.status = 'ROG_PAYMENT_CONFIRMED';
      row.rog_fulfillment_status = 'WAITING_REGISTRATION';
      return { ...row };
    }
  };
  communityChecks = 0;
  const paymentDeps = {
    pg: fakePg(),
    community: { async assertCommunityMember(w) { assert.equal(w, wallet); communityChecks++; } },
    sessions: paymentSessionManager,
    rogDonation: {
      async verifyRogUsdcTransfer({ txHash, wallet: w, amountUsdc }) {
        assert.equal(txHash, rogHash); assert.equal(w, wallet); assert.equal(amountUsdc, 2);
        return { blockTimestamp: Math.floor(Date.now() / 1000), txHash };
      }
    }
  };
  const paid = await direct.confirmRogPayment({ wallet, sessionRef, rogUsdcTxHash: rogHash }, paymentDeps);
  assert.equal(communityChecks, 1, 'Community must be verified before accepting ROG payment');
  assert.equal(row.status, 'ROG_PAYMENT_CONFIRMED');
  assert.equal(paid.success, true);
  assert.equal(paid.paymentConfirmed, true);

  console.log('PASS direct session-before-community: PHARAOH session opens first; Community remains mandatory at ROG gate');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

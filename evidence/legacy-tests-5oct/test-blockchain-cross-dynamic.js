'use strict';

const assert = require('node:assert/strict');
const { ethers } = require('ethers');

process.env.NODE_ENV = 'test';
process.env.POLYGON_CHAIN_ID = '137';
process.env.POLYGON_MIN_CONFIRMATIONS = '2';
process.env.PHARAOH_TREASURY_WALLET = '0x2222222222222222222222222222222222222222';
process.env.ROG_TREASURY_WALLET = '0x3333333333333333333333333333333333333333';
process.env.URANUS_TREASURY_WALLET = '0x4444444444444444444444444444444444444444';
process.env.USDC_CONTRACT_ADDRESS = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
process.env.CROSS_PLATFORM_SECRET = 'z'.repeat(64);
process.env.ROG_CROSS_INGRESS_URL = 'https://rog.example.invalid/api/cross/donation/entrata';

const verifier = require('../blockchain-verifier');
const outbound = require('../cross-outbound-manager');
const auth = require('../cross-platform-auth');

const ERC20 = new ethers.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const SENDER = '0x1111111111111111111111111111111111111111';
const TX = `0x${'a'.repeat(64)}`;
const BLOCK = `0x${'b'.repeat(64)}`;

function transferLog(from, to, amountUsdc, index = 0) {
  const encoded = ERC20.encodeEventLog(ERC20.getEvent('Transfer'), [from, to, ethers.parseUnits(String(amountUsdc), 6)]);
  return { address: process.env.USDC_CONTRACT_ADDRESS, topics: encoded.topics, data: encoded.data, logIndex: index, index };
}

function providerFor({ from = SENDER, to = process.env.PHARAOH_TREASURY_WALLET, amount = 100 } = {}) {
  return {
    async getNetwork() { return { chainId: 137n, name: 'polygon' }; },
    async getTransactionReceipt() {
      return { status: 1, transactionHash: TX, hash: TX, from, blockNumber: 100, blockHash: BLOCK, logs: [transferLog(from, to, amount)] };
    },
    async getBlockNumber() { return 101; }
  };
}
const fakePg = { async queryOne() { return null; } };

async function expectCode(promise, code) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, `Atteso ${code}`);
  assert.equal(caught.code, code);
}

async function testVerifier() {
  const one = await verifier.verificaDonazione({ txHash: TX, walletMittente: SENDER, importoMinimo: 100, maxPosizioni: 1 }, { provider: providerFor(), pg: fakePg });
  assert.equal(one.importoEffettivo, 100);
  assert.equal(one.numeroPosizioni, 1);
  assert.equal(one.proof.to, process.env.PHARAOH_TREASURY_WALLET);

  await expectCode(
    verifier.verificaDonazione({ txHash: TX, walletMittente: SENDER, importoMinimo: 100, maxPosizioni: 1 }, { provider: providerFor({ amount: 200 }), pg: fakePg }),
    'BLOCKCHAIN_AMOUNT_TOO_HIGH'
  );
  await expectCode(
    verifier.verificaDonazione({ txHash: TX, walletMittente: SENDER, importoMinimo: 100, maxPosizioni: 100 }, { provider: providerFor({ amount: 150 }), pg: fakePg }),
    'BLOCKCHAIN_AMOUNT_NOT_EXACT_MULTIPLE'
  );

  const cross = await verifier.verificaDonazione({
    txHash: TX,
    walletMittente: SENDER,
    importoMinimo: 100,
    destinatarioWallet: process.env.PHARAOH_TREASURY_WALLET,
    maxPosizioni: 100
  }, { provider: providerFor({ amount: 200 }), pg: fakePg });
  assert.equal(cross.numeroPosizioni, 2);
  assert.equal(cross.importoEffettivo, 200);

  await expectCode(
    verifier.verificaDonazione({ txHash: TX, walletMittente: SENDER, importoMinimo: 100, maxPosizioni: 1 }, { provider: providerFor({ from: '0x5555555555555555555555555555555555555555' }), pg: fakePg }),
    'BLOCKCHAIN_SENDER_MISMATCH'
  );
}

async function testOutboundProofAndNotification() {
  const cfg = {
    target: 'ROG',
    sourceWallet: process.env.PHARAOH_TREASURY_WALLET,
    destinationWallet: process.env.ROG_TREASURY_WALLET,
    receiverUrl: process.env.ROG_CROSS_INGRESS_URL,
    chainId: 137,
    minConfirmations: 2,
    usdcAddress: process.env.USDC_CONTRACT_ADDRESS
  };
  const row = {
    event_key: 'PHARAOH:L3:1:user:USCITA_L3:PHARAOH_TO_ROG',
    rha_event_key: 'PHARAOH:L3:1:user:USCITA_L3',
    rog_donation_id: 'TEST-ROG-DONATION-001',
    beneficiary_wallet: '0x6666666666666666666666666666666666666666',
    payment_tx_hash: TX,
    amount_usdc: 300,
    positions_expected: 150,
    protocol_version: outbound.RHA_PROTOCOL_V2
  };
  const p = {
    async getTransactionReceipt() { return { status: 1, from: cfg.sourceWallet, blockNumber: 100, blockHash: BLOCK, logs: [transferLog(cfg.sourceWallet, cfg.destinationWallet, 300)] }; },
    async getBlockNumber() { return 101; }
  };
  outbound._assertOperationInvariant({ ...row, source_wallet: cfg.sourceWallet, destination_wallet: cfg.destinationWallet, target_platform: 'ROG' }, cfg);
  assert.throws(() => outbound._assertOperationInvariant({ ...row, source_wallet: cfg.sourceWallet, destination_wallet: cfg.destinationWallet, target_platform: 'ROG', amount_usdc: 301 }, cfg), error => error.code === 'CROSS_OUTBOUND_SPEC_MISMATCH');

  const proof = await outbound._verifyConfirmedTransfer(row, p, cfg);
  assert.equal(proof.amountUsdc, 300);
  assert.equal(proof.to, cfg.destinationWallet);

  await expectCode(
    outbound._verifyConfirmedTransfer(row, {
      async getTransactionReceipt() { return { status: 1, from: '0x7777777777777777777777777777777777777777', blockNumber: 100, blockHash: BLOCK, logs: [transferLog(cfg.sourceWallet, cfg.destinationWallet, 300)] }; },
      async getBlockNumber() { return 101; }
    }, cfg),
    'CROSS_OUTBOUND_SENDER_MISMATCH'
  );

  let captured = null;
  const fakeFetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return {
  ok: true,
  status: 200,
  async json() {
    return {
      success: true,
      status: 'COMPLETED',
      donation_id: String(row.rog_donation_id),
      beneficiaryWallet: row.beneficiary_wallet,
      positionsOwnerWallet: row.beneficiary_wallet,
      rgxOwnerWallet: cfg.sourceWallet,
      rgxMinted: Number(row.positions_expected)
    };
  }
};
  };
  const result = await outbound._notifyTarget(row, cfg, fakeFetch);
  assert.equal(result.success, true);
  assert.equal(captured.body.wallet_origine, cfg.sourceWallet);
  assert.equal(captured.body.wallet_beneficiario, row.beneficiary_wallet);
  assert.equal(captured.body.importo_totale, 300);
  assert.equal(captured.body.num_ingressi, 150);
  assert.equal(captured.options.headers['X-Platform-Origin'], 'PHARAOH');
  assert.equal(captured.options.headers['X-Platform-Signature'], auth.signBody(captured.body, 'ROG'));
}

(async () => {
  await testVerifier();
  await testOutboundProofAndNotification();
  console.log('PASS dynamic blockchain verifier: exact 100 DIRECT, reject 200/150, allow cross multiple');
  console.log('PASS dynamic RHA outbound: exact on-chain proof + signed beneficiary event');
})().catch(error => { console.error(error); process.exitCode = 1; });

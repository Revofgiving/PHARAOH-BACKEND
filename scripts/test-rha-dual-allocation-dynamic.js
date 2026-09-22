'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'ethers') return { ethers: {} };
  if (request === 'dotenv') return { config() { return {}; } };
  if (request === './pg-connection-manager' && (parent?.filename?.endsWith('cross-outbound-manager.js') || parent?.filename?.endsWith('pharaoh-registry-manager.js'))) {
    return {
      async queryMany() { return []; },
      async queryOne() { return null; },
      async getClient() { throw new Error('DB client non previsto in questo test'); }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const outbound = require('../cross-outbound-manager');
Module._load = originalLoad;

const PHARAOH = '0x1111111111111111111111111111111111111111';
const ROG = '0x2222222222222222222222222222222222222222';
const URANUS = '0x3333333333333333333333333333333333333333';
const BENEFICIARY = '0x4444444444444444444444444444444444444444';
const USDC = '0x5555555555555555555555555555555555555555';
const ROG_CONTRACT = '0x6666666666666666666666666666666666666666';
const ACCOUNT_ID = 701;
const ACCOUNT_SIGLA = '23.1';
const TX = `0x${'a'.repeat(64)}`;

process.env.NODE_ENV = 'test';
process.env.PHARAOH_TREASURY_WALLET = PHARAOH;
process.env.ROG_TREASURY_WALLET = ROG;
process.env.URANUS_TREASURY_WALLET = URANUS;
process.env.USDC_CONTRACT_ADDRESS = USDC;
process.env.ROG_CONTRACT_ADDRESS = ROG_CONTRACT;
process.env.ROG_CROSS_INGRESS_URL = 'https://rog.example.test/api/cross/pharaoh/rog';
process.env.URANUS_CROSS_INGRESS_URL = 'https://uranus.example.test/api/cross/pharaoh/uranus';
process.env.ROG_CROSS_PLATFORM_SECRET = 'r'.repeat(40);
process.env.URANUS_CROSS_PLATFORM_SECRET = 'u'.repeat(40);

function clone(row) { return JSON.parse(JSON.stringify(row)); }

function fakeScheduleClient({ preexistingAllocation = null, preexistingOperations = [] } = {}) {
  const state = {
    allocation: preexistingAllocation ? clone(preexistingAllocation) : null,
    operations: new Map(preexistingOperations.map(row => [row.event_key, clone(row)]))
  };
  return {
    state,
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO rha_exit_allocations')) {
        if (!state.allocation) {
          state.allocation = {
            rha_event_key: params[0],
            beneficiary_wallet: params[1],
            account_id: params[2],
            account_sigla: params[3],
            turno: params[4],
            protocol_version: params[5],
            rog_usdc: 300,
            uranus_usdc: 200,
            repayable: false
          };
        }
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT * FROM rha_exit_allocations')) {
        return { rows: state.allocation ? [clone(state.allocation)] : [] };
      }
      if (normalized.startsWith('INSERT INTO cross_outbound_operations')) {
        const eventKey = params[0];
        if (!state.operations.has(eventKey)) {
          state.operations.set(eventKey, {
            event_key: params[0],
            rha_event_key: params[1],
            target_platform: params[2],
            source_wallet: params[3],
            beneficiary_wallet: params[4],
            account_id: params[5],
            account_sigla: params[6],
            destination_wallet: params[7],
            amount_usdc: params[8],
            positions_expected: params[9],
            protocol_version: params[10],
            status: 'PENDING',
            attempts: 0
          });
        }
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT * FROM cross_outbound_operations')) {
        const row = state.operations.get(params[0]);
        return { rows: row ? [clone(row)] : [] };
      }
      throw new Error(`SQL inatteso nel test: ${normalized}`);
    }
  };
}

async function testFreshV2Schedule() {
  const client = fakeScheduleClient();
  const event = 'PHARAOH:RHA:TURN:77:EXIT';
  const result = await outbound.scheduleRhaExit({
    rhaEventKey: event,
    beneficiaryWallet: BENEFICIARY,
    accountId: ACCOUNT_ID,
    accountSigla: ACCOUNT_SIGLA,
    turno: 77
  }, client);

  assert.equal(result.allocation.protocolVersion, outbound.RHA_PROTOCOL_V2);
  assert.equal('staffOmaggiReservedUsdc' in result.allocation, false);
  assert.equal(result.allocation.rogUsdc, 300);
  assert.equal(result.allocation.rogDualPositions, 150);
  assert.equal(result.allocation.uranusUsdc, 200);
  assert.equal(result.allocation.uranusDualPositions, 10);
  assert.equal(result.allocation.beneficiaryWallet, BENEFICIARY);
  assert.equal(result.allocation.accountId, ACCOUNT_ID);
  assert.equal(result.allocation.accountSigla, ACCOUNT_SIGLA);
  assert.equal(result.operations.length, 2);

  const rog = result.operations.find(op => op.targetPlatform === 'ROG');
  const uranus = result.operations.find(op => op.targetPlatform === 'URANUS');
  assert.equal(rog.amountUsdc, 300);
  assert.equal(rog.positionsExpected, 150);
  assert.equal(rog.beneficiaryWallet, BENEFICIARY);
  assert.equal(rog.accountId, ACCOUNT_ID);
  assert.equal(rog.accountSigla, ACCOUNT_SIGLA);
  assert.equal(uranus.amountUsdc, 200);
  assert.equal(uranus.positionsExpected, 10);
  assert.equal(uranus.beneficiaryWallet, BENEFICIARY);
  assert.equal(uranus.accountId, ACCOUNT_ID);
  assert.equal(uranus.accountSigla, ACCOUNT_SIGLA);

  const retry = await outbound.scheduleRhaExit({
    rhaEventKey: event,
    beneficiaryWallet: BENEFICIARY,
    accountId: ACCOUNT_ID,
    accountSigla: ACCOUNT_SIGLA,
    turno: 77
  }, client);
  assert.deepEqual(retry.operations.map(op => [op.eventKey, op.amountUsdc, op.positionsExpected]),
    result.operations.map(op => [op.eventKey, op.amountUsdc, op.positionsExpected]));
  assert.equal(client.state.operations.size, 2, 'retry non deve creare operazioni duplicate');
}

async function testLegacyV1RemainsHistorical() {
  const event = 'PHARAOH:RHA:LEGACY:1';
  const client = fakeScheduleClient({
    preexistingAllocation: {
      rha_event_key: event,
      beneficiary_wallet: BENEFICIARY,
      turno: 1,
      protocol_version: outbound.RHA_PROTOCOL_V1,
      rog_usdc: 200,
      uranus_usdc: 100,
      repayable: false
    }
  });
  const result = await outbound.scheduleRhaExit({ rhaEventKey: event, beneficiaryWallet: BENEFICIARY, turno: 1 }, client);
  assert.equal(result.allocation.protocolVersion, outbound.RHA_PROTOCOL_V1);
  assert.equal(result.operations.find(op => op.targetPlatform === 'ROG').amountUsdc, 200);
  assert.equal(result.operations.find(op => op.targetPlatform === 'ROG').positionsExpected, 100);
  assert.equal(result.operations.find(op => op.targetPlatform === 'URANUS').amountUsdc, 100);
  assert.equal(result.operations.find(op => op.targetPlatform === 'URANUS').positionsExpected, 5);
}

async function testNotifyPayloadUsesBeneficiaryAndNewRates() {
  const rows = [
    {
      target: 'ROG', destination: ROG, amount: 300, positions: 150,
      event: 'PHARAOH:RHA:88:PHARAOH_TO_ROG'
    },
    {
      target: 'URANUS', destination: URANUS, amount: 200, positions: 10,
      event: 'PHARAOH:RHA:88:PHARAOH_TO_URANUS'
    }
  ];
  for (const spec of rows) {
    let captured = null;
    const cfg = {
      target: spec.target,
      sourceWallet: PHARAOH,
      destinationWallet: spec.destination,
      receiverUrl: `https://${spec.target.toLowerCase()}.example.test/cross`,
      chainId: 137,
      minConfirmations: 1,
      usdcAddress: USDC,
      rogContractAddress: spec.target === 'ROG' ? ROG_CONTRACT : null
    };
    const row = {
      event_key: spec.event,
      rha_event_key: 'PHARAOH:RHA:88',
      target_platform: spec.target,
      protocol_version: outbound.RHA_PROTOCOL_V2,
      source_wallet: PHARAOH,
      beneficiary_wallet: BENEFICIARY,
      destination_wallet: spec.destination,
      amount_usdc: spec.amount,
      positions_expected: spec.positions,
      payment_tx_hash: TX,
      rog_register_tx_hash: spec.target === 'ROG' ? `0x${'b'.repeat(64)}` : null,
      rog_donation_id: spec.target === 'ROG' ? '9001' : null
    };
    outbound._assertOperationInvariant(row, cfg);
    await outbound._notifyTarget(row, cfg, async (_url, options) => {
      captured = JSON.parse(options.body);
      const payload = spec.target === 'ROG'
        ? {
            success: true,
            status: 'COMPLETED',
            donation_id: '9001',
            beneficiaryWallet: BENEFICIARY,
            positionsOwnerWallet: BENEFICIARY,
            rgxOwnerWallet: PHARAOH,
            rgxMinted: 150
          }
        : { success: true };
      return { ok: true, status: 200, async json() { return payload; } };
    });
    assert.equal(captured.wallet_origine, PHARAOH);
    assert.equal(captured.wallet_beneficiario, BENEFICIARY);
    assert.equal(captured.wallet_cassa, spec.destination);
    assert.equal(captured.importo_totale, spec.amount);
    assert.equal(captured.num_ingressi, spec.positions);
    assert.equal(captured.payment_tx_hash, TX);
    if (spec.target === 'ROG') {
      assert.equal(captured.protocol_version, outbound.RHA_PROTOCOL_V2);
      assert.equal(captured.register_tx_hash, row.rog_register_tx_hash);
      assert.equal(captured.donation_id, '9001');
    }
  }
}

(async () => {
  await testFreshV2Schedule();
  await testLegacyV1RemainsHistorical();
  await testNotifyPayloadUsesBeneficiaryAndNewRates();
  console.log('PASS RHA DUAL DYNAMIC: schedule V2 idempotente, V1 preservato, payload 300/150 ROG + 200/10 URANUS al ricevente RHA');
})().catch(error => {
  console.error('FAIL RHA DUAL DYNAMIC');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

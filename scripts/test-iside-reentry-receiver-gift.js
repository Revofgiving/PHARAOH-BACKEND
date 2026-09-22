'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const rules = require(path.join(ROOT, 'rules-engine.js'));

function testStaticIntegration() {
  const flow = fs.readFileSync(path.join(ROOT, 'donation-flow-manager.js'), 'utf8');
  const fn = fs.readFileSync(path.join(ROOT, 'function-manager.js'), 'utf8');
  const db = fs.readFileSync(path.join(ROOT, 'db-manager.js'), 'utf8');
  const migration = fs.readFileSync(path.join(ROOT, 'database/0007_iside_reentry_receiver_gift.sql'), 'utf8');

  const start = flow.indexOf('async function gestisciUscitaFaraoneL5Atomica');
  const end = flow.indexOf('/**\n * Avvia il prossimo turno L5', start);
  assert.ok(start >= 0 && end > start, 'Gestore uscita ISIDE deve esistere');
  const l5flow = flow.slice(start, end);
  assert.ok(l5flow.includes('const isideAllocation = await functionManager.rilasciaFunzioniL5({'));
  assert.ok(l5flow.includes('faraoneAccountId: account.id'));
  assert.ok(l5flow.includes('faraoneSigla: account.sigla || null'));
  assert.ok(l5flow.includes('uscita.payoutRicevente'));
  assert.ok(l5flow.includes('nettoBaseUsdc: uscita.nettoBase'));
  assert.ok(l5flow.includes('donoRiceventeUsdc: uscita.quotaRicevente'));
  assert.ok(!l5flow.includes('110 crediti'));

  assert.ok(fn.includes("source: 'ISIDE_REENTRY'"));
  assert.ok(fn.includes('sourceAccountId: account.id'));
  assert.ok(fn.includes('sourceAccountSigla: account.sigla'));
  assert.ok(db.includes('async function createIsideExitAllocation'));
  assert.ok(db.includes('async function completeIsideExitAllocation'));
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS iside_exit_allocations'));
  assert.ok(migration.includes('reentry_positions_expected = 50'));
  assert.ok(migration.includes('receiver_gift_usdc = 6000'));
  assert.ok(migration.includes('receiver_payout_usdc = 25000'));
  assert.ok(!migration.includes('UPDATE iside_exit_allocations'), '0007 non deve retro-modificare lo storico ISIDE');
}

function testRules(tipoAccount) {
  const out = rules.calcolaUscitaLivello(5, tipoAccount, 30000);
  assert.equal(out.tipoAccount, tipoAccount);
  assert.equal(out.categoriaAccount, 'SECONDARIO');
  assert.equal(out.trattenutaRientriEntrata, 5000);
  assert.equal(out.numRientriEntrata, 50);
  assert.equal(out.importoSingoloRientro, 100);
  assert.equal(out.nettoBase, 19000);
  assert.equal(out.quotaRicevente, 6000);
  assert.equal(out.payoutRicevente, 25000);
  assert.equal(out.netto, 25000);
  assert.equal('trattenutaCrediti' in out, false);
  assert.equal('numCrediti' in out, false);
  assert.equal(out.payoutRicevente + out.trattenutaRientriEntrata, 30000);
}

async function testOrchestration(tipoAccount) {
  const wallet = tipoAccount === 'PERPETUO'
    ? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    : '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const cassa = '0x2222222222222222222222222222222222222222';
  const accountId = tipoAccount === 'PERPETUO' ? 801 : 802;
  const sigla = tipoAccount === 'PERPETUO' ? '23.1' : '1-23';
  const eventKey = `USCITA_L5_TEST_${tipoAccount}_T9`;
  const allocations = new Map();
  let materializeCalls = 0;

  const dbStub = {
    async getAccountByIdentity(identity) {
      assert.equal(Number(identity.accountId), accountId);
      assert.equal(String(identity.wallet).toLowerCase(), wallet);
      assert.equal(identity.sigla, sigla);
      return { id: accountId, wallet, nome: `TEST_${tipoAccount}`, tipo: tipoAccount, sigla };
    },
    async createIsideExitAllocation(input) {
      if (!allocations.has(input.eventKey)) {
        allocations.set(input.eventKey, {
          iside_event_key: input.eventKey,
          beneficiary_wallet: String(input.beneficiaryWallet).toLowerCase(),
          cassa_wallet: String(input.cassaWallet).toLowerCase(),
          source_account_id: Number(input.sourceAccountId),
          source_account_sigla: input.sourceAccountSigla,
          turno: Number(input.turno),
          total_received_usdc: Number(input.totalReceivedUsdc),
          base_net_usdc: Number(input.baseNetUsdc),
          receiver_gift_usdc: Number(input.receiverGiftUsdc),
          receiver_payout_usdc: Number(input.receiverPayoutUsdc),
          reentry_usdc: Number(input.reentryUsdc),
          reentry_unit_usdc: Number(input.reentryUnitUsdc),
          reentry_positions_expected: Number(input.reentryPositionsExpected),
          reentry_positions_created: 0,
          position_result: [],
          status: 'ALLOCATED'
        });
      }
      return { ...allocations.get(input.eventKey) };
    },
    async completeIsideExitAllocation({ eventKey: key, positions }) {
      const row = allocations.get(key);
      row.reentry_positions_created = positions.length;
      row.position_result = JSON.parse(JSON.stringify(positions));
      row.status = 'MATERIALIZED';
      return { ...row };
    }
  };

  const reentryStub = {
    async materializzaRientriEntrata(input) {
      materializeCalls += 1;
      assert.equal(input.source, 'ISIDE_REENTRY');
      assert.equal(input.eventKey, eventKey);
      assert.equal(input.wallet, wallet);
      assert.equal(input.sourceAccountId, accountId);
      assert.equal(input.sourceAccountSigla, sigla);
      assert.equal(input.count, 50);
      return Array.from({ length: 50 }, (_, i) => ({
        index: i + 1,
        wallet,
        accountId: 11000 + i,
        ticketNumber: 12000 + i,
        sigla: String(12000 + i),
        sourceAccountId: accountId,
        sourceAccountSigla: sigla,
        amountUsdc: 100,
        personalTableId: 13000 + i
      }));
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent && path.resolve(parent.filename) === path.join(ROOT, 'function-manager.js')) {
      if (request === './db-manager') return dbStub;
      if (request === './rules-engine') return rules;
      if (request === './account-manager') return {};
      if (request === './table-manager') return {};
      if (request === './reentry-manager') return reentryStub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const functionPath = require.resolve(path.join(ROOT, 'function-manager.js'));
  delete require.cache[functionPath];
  try {
    const functionManager = require(functionPath);
    const client = {
      async query(sql) {
        assert.match(String(sql), /pg_advisory_xact_lock/);
        return { rows: [{ locked: true }] };
      }
    };

    const first = await functionManager.rilasciaFunzioniL5({
      faraoneWallet: wallet,
      faraoneAccountId: accountId,
      faraoneSigla: sigla,
      turnoCorrente: 9,
      eventKey,
      cassaWallet: cassa
    }, client);

    assert.equal(first.idempotent, false);
    assert.deepEqual(first.accounting, {
      cassaWallet: cassa,
      totalReceivedUsdc: 30000,
      baseNetUsdc: 19000,
      receiverGiftUsdc: 6000,
      receiverPayoutUsdc: 25000
    });
    assert.equal(first.reentries.amountUsdc, 5000);
    assert.equal(first.reentries.positionsCreated, 50);
    assert.equal(materializeCalls, 1);

    const retry = await functionManager.rilasciaFunzioniL5({
      faraoneWallet: wallet,
      faraoneAccountId: accountId,
      faraoneSigla: sigla,
      turnoCorrente: 9,
      eventKey,
      cassaWallet: cassa
    }, client);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.reentries.positionsCreated, 50);
    assert.equal(materializeCalls, 1, 'Retry ISIDE non deve rimaterializzare i rientri');
  } finally {
    delete require.cache[functionPath];
    Module._load = originalLoad;
  }
}

(async () => {
  testStaticIntegration();
  for (const tipo of ['PERPETUO', 'GEMELLO']) {
    testRules(tipo);
    await testOrchestration(tipo);
  }
  console.log('PASS ISIDE: PERPETUO + GEMELLO => 50x100 ENTRATA + 6000 quota diretta + 19000 netto base = 25000 payout; identita propagata');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

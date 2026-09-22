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
  const migration = fs.readFileSync(path.join(ROOT, 'database/0006_thot_humanitarian_reentry.sql'), 'utf8');
  const identityMigration = fs.readFileSync(path.join(ROOT, 'database/0010_secondary_identity_wallets.sql'), 'utf8');

  const start = flow.indexOf('async function gestisciUscitaFaraoneL4Atomica');
  const end = flow.indexOf('/**\n * Avvia il prossimo turno L4', start);
  assert.ok(start >= 0 && end > start, 'Gestore uscita THOT deve esistere');
  const l4flow = flow.slice(start, end);
  assert.ok(l4flow.includes('const thotAllocation = await functionManager.rilasciaFunzioniL4({'));
  assert.ok(l4flow.includes('faraoneAccountId: account.id'));
  assert.ok(l4flow.includes('faraoneSigla: account.sigla || null'));
  assert.ok(l4flow.includes('uscita.trattenutaProgettiUmanitari'));
  assert.ok(l4flow.includes('uscita.trattenutaRientriEntrata'));
  assert.ok(!l4flow.includes('10 crediti'));

  assert.ok(fn.includes("source: 'THOT_REENTRY'"));
  assert.ok(fn.includes('sourceAccountId: account.id'));
  assert.ok(fn.includes('sourceAccountSigla: account.sigla'));
  assert.ok(db.includes('async function createThotExitAllocation'));
  assert.ok(db.includes('async function completeThotExitAllocation'));
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS thot_exit_allocations'));
  assert.ok(!migration.includes('UPDATE thot_exit_allocations'), '0006 non deve retro-modificare lo storico THOT');
  assert.ok(identityMigration.includes('source_account_id'));
  assert.ok(identityMigration.includes('source_event_key'));
}

function testRules(tipoAccount) {
  const out = rules.calcolaUscitaLivello(4, tipoAccount, 15000);
  assert.equal(out.tipoAccount, tipoAccount);
  assert.equal(out.categoriaAccount, 'SECONDARIO');
  assert.equal(out.trattenutaIngressoL5, 10000);
  assert.equal(out.trattenutaProgettiUmanitari, 500);
  assert.equal(out.destinazioneProgettiUmanitari, 'PROGETTI_UMANITARI');
  assert.equal(out.trattenutaRientriEntrata, 500);
  assert.equal(out.numRientriEntrata, 5);
  assert.equal(out.importoSingoloRientro, 100);
  assert.equal('trattenutaCrediti' in out, false);
  assert.equal('numCrediti' in out, false);
  assert.equal(out.netto, 4000);
  assert.equal(
    out.trattenutaIngressoL5 + out.trattenutaProgettiUmanitari + out.trattenutaRientriEntrata + out.netto,
    15000
  );
}

async function testOrchestration(tipoAccount) {
  const wallet = tipoAccount === 'PERPETUO'
    ? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    : '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const cassa = '0x2222222222222222222222222222222222222222';
  const accountId = tipoAccount === 'PERPETUO' ? 701 : 702;
  const sigla = tipoAccount === 'PERPETUO' ? '23.1' : '1-23';
  const eventKey = `USCITA_L4_TEST_${tipoAccount}_T7`;
  const allocations = new Map();
  let materializeCalls = 0;

  const dbStub = {
    async getAccountByIdentity(identity) {
      assert.equal(Number(identity.accountId), accountId);
      assert.equal(String(identity.wallet).toLowerCase(), wallet);
      assert.equal(identity.sigla, sigla);
      return { id: accountId, wallet, nome: `TEST_${tipoAccount}`, tipo: tipoAccount, sigla };
    },
    async createThotExitAllocation(input) {
      if (!allocations.has(input.eventKey)) {
        allocations.set(input.eventKey, {
          thot_event_key: input.eventKey,
          beneficiary_wallet: String(input.beneficiaryWallet).toLowerCase(),
          cassa_wallet: String(input.cassaWallet).toLowerCase(),
          source_account_id: Number(input.sourceAccountId),
          source_account_sigla: input.sourceAccountSigla,
          turno: Number(input.turno),
          humanitarian_reserved_usdc: Number(input.humanitarianUsdc),
          humanitarian_destination: input.humanitarianDestination,
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
    async completeThotExitAllocation({ eventKey: key, positions }) {
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
      assert.equal(input.source, 'THOT_REENTRY');
      assert.equal(input.eventKey, eventKey);
      assert.equal(input.wallet, wallet);
      assert.equal(input.sourceAccountId, accountId);
      assert.equal(input.sourceAccountSigla, sigla);
      assert.equal(input.count, 5);
      return Array.from({ length: 5 }, (_, i) => ({
        index: i + 1,
        wallet,
        accountId: 8000 + i,
        ticketNumber: 9000 + i,
        sigla: String(9000 + i),
        sourceAccountId: accountId,
        sourceAccountSigla: sigla,
        amountUsdc: 100,
        personalTableId: 10000 + i
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

    const first = await functionManager.rilasciaFunzioniL4({
      faraoneWallet: wallet,
      faraoneAccountId: accountId,
      faraoneSigla: sigla,
      turnoCorrente: 7,
      eventKey,
      cassaWallet: cassa
    }, client);

    assert.equal(first.idempotent, false);
    assert.equal(first.humanitarian.amountUsdc, 500);
    assert.equal(first.humanitarian.destination, 'PROGETTI_UMANITARI');
    assert.equal(first.reentries.amountUsdc, 500);
    assert.equal(first.reentries.positionsCreated, 5);
    assert.equal(materializeCalls, 1);

    const retry = await functionManager.rilasciaFunzioniL4({
      faraoneWallet: wallet,
      faraoneAccountId: accountId,
      faraoneSigla: sigla,
      turnoCorrente: 7,
      eventKey,
      cassaWallet: cassa
    }, client);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.reentries.positionsCreated, 5);
    assert.equal(materializeCalls, 1, 'Retry THOT non deve rimaterializzare i rientri');
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
  console.log('PASS THOT: PERPETUO + GEMELLO => 500 umanitari + 5 rientri x100; identita Secondario propagata e retry idempotente');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

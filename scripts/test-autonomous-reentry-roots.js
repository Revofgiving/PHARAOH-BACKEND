'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const rules = require(path.join(ROOT, 'rules-engine.js'));

async function runCase({ source, count, sourceId, sourceSigla, tipo }) {
  const wallet = '0x1111111111111111111111111111111111111111';
  const eventKey = `${source}_AUTONOMOUS_ROOT_TEST`;
  const rootsByKey = new Map();
  const rootsById = new Map();
  const createdInputs = [];
  const placements = [];
  const postCommit = [];
  let nextId = 10000;
  let nextTicket = source === 'THOT_REENTRY' ? 501 : 1001;
  let activeTurn = 1;
  let occupied = 0;
  let entryStarts = 0;

  const sourceAccount = {
    id: sourceId,
    wallet,
    nome: `${tipo} SOURCE`,
    tipo,
    sigla: sourceSigla,
    root_account_id: 23
  };

  const dbStub = {
    async getAccountByIdentity(identity) {
      assert.equal(Number(identity.accountId), sourceId);
      assert.equal(String(identity.wallet).toLowerCase(), wallet);
      assert.equal(identity.sigla, sourceSigla);
      return { ...sourceAccount };
    },
    async getAccountByKey(key) {
      return rootsByKey.get(key) || null;
    },
    async createAccount(input) {
      assert.equal(input.wallet, wallet);
      assert.equal(input.tipo, 'PRIMARIO');
      assert.equal(input.parentAccountId, null);
      assert.equal(input.rootAccountId, null);
      assert.equal(input.sourceAccountId, sourceId);
      assert.equal(input.sourceEventKey, eventKey);
      assert.equal(input.originKind, source);
      const row = {
        id: nextId++,
        wallet: input.wallet,
        nome: input.nome,
        tipo: input.tipo,
        sigla: input.sigla,
        account_key: input.accountKey,
        parent_account_id: null,
        root_account_id: null,
        source_account_id: input.sourceAccountId,
        source_event_key: input.sourceEventKey,
        origin_kind: input.originKind,
        ticket_number: null
      };
      rootsByKey.set(input.accountKey, row);
      rootsById.set(row.id, row);
      createdInputs.push({ ...input, id: row.id });
      return { ...row };
    },
    async assignTicketToAccountId(id) {
      const row = rootsById.get(Number(id));
      assert.ok(row, `Radice ${id} deve esistere`);
      if (!row.ticket_number) row.ticket_number = nextTicket++;
      return { ...row };
    },
    async updateAccountIdentity(id, updates) {
      const row = rootsById.get(Number(id));
      row.sigla = updates.sigla;
      row.root_account_id = updates.rootAccountId;
      return { ...row };
    },
    async getTurnoCorrente(sezione, livello) {
      assert.equal(sezione, 'ENTRATA');
      assert.equal(livello, 0);
      return {
        id: 2000 + activeTurn,
        numero_turno: activeTurn,
        faraone_wallet: `0x${String(7000 + activeTurn).padStart(40, '0')}`,
        faraone_account_id: 9000 + activeTurn,
        faraone_sigla: String(400 + activeTurn),
        status: 'IN_CORSO'
      };
    },
    async incrementSacerdotiEntrati() {
      return { ok: true };
    },
    async getAccountById(id) {
      return {
        id: Number(id),
        wallet: `0x${String(7000 + activeTurn).padStart(40, '0')}`,
        nome: `EREDE_${activeTurn}`,
        tipo: 'PRIMARIO',
        sigla: String(400 + activeTurn)
      };
    },
    async getAccount(walletArg) {
      return {
        id: 9000 + activeTurn,
        wallet: String(walletArg).toLowerCase(),
        nome: `EREDE_${activeTurn}`,
        tipo: 'PRIMARIO',
        sigla: String(400 + activeTurn)
      };
    },
    async createPostCommitOperation(op) {
      postCommit.push(JSON.parse(JSON.stringify(op)));
      return op;
    }
  };

  const tableStub = {
    async getTavolaPercorsoAttiva(livello, turno) {
      assert.equal(livello, 0);
      assert.equal(turno, activeTurn);
      return {
        id: 3000 + activeTurn,
        numero: 600 + activeTurn,
        livello: 0,
        turno: activeTurn,
        faraone_wallet: `0x${String(7000 + activeTurn).padStart(40, '0')}`,
        faraone_account_id: 9000 + activeTurn,
        faraone_sigla: String(400 + activeTurn),
        status: 'APERTA'
      };
    },
    async posizionaDonatore(input) {
      assert.equal(String(input.wallet).toLowerCase(), wallet);
      assert.equal(input.livello, 0);
      assert.equal(input.donoImporto, 100);
      assert.equal(input.sdoppiabile, true);
      assert.ok(Number.isInteger(Number(input.accountId)) && Number(input.accountId) !== sourceId);
      assert.match(String(input.accountSigla), /^\d+$/);

      occupied += 1;
      const complete = occupied === 6;
      const result = {
        casellaOccupata: occupied,
        tavolaCompleta: complete,
        tavolaSdoppiamento: {
          id: 50000 + placements.length + 1,
          numero: 60000 + placements.length + 1,
          faraone_account_id: Number(input.accountId),
          faraone_sigla: input.accountSigla
        }
      };
      placements.push({
        wallet: String(input.wallet).toLowerCase(),
        accountId: Number(input.accountId),
        accountSigla: input.accountSigla,
        turno: Number(input.turno),
        tavolaId: Number(input.tavolaId),
        casella: occupied,
        personalTableId: result.tavolaSdoppiamento.id,
        completed: complete
      });
      if (complete) occupied = 0;
      return result;
    }
  };

  const donationFlowStub = {
    async avviaNuovoTurnoEntrata(turnoChiuso) {
      assert.equal(Number(turnoChiuso.numero_turno), activeTurn);
      activeTurn += 1;
      entryStarts += 1;
      // Dalla Tavola 2 in poi il turno apre con il riporto reale da 100 USDC
      // della Cassa PHARAOH, che occupa una casella ma non e una radice rientro.
      occupied = 1;
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const parentFile = parent && path.resolve(parent.filename);
    if (parentFile === path.join(ROOT, 'reentry-manager.js')) {
      if (request === './db-manager') return dbStub;
      if (request === './table-manager') return tableStub;
      if (request === './rules-engine') return rules;
      if (request === './donation-flow-manager') return donationFlowStub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const reentryPath = require.resolve(path.join(ROOT, 'reentry-manager.js'));
  delete require.cache[reentryPath];
  try {
    const reentryManager = require(reentryPath);
    const result = await reentryManager.materializzaRientriEntrata({
      source,
      eventKey,
      wallet,
      nome: 'OWNER',
      sourceAccountId: sourceId,
      sourceAccountSigla: sourceSigla,
      count,
      client: { query: async () => ({ rows: [] }) }
    });

    assert.equal(result.length, count);
    assert.equal(createdInputs.length, count);
    assert.equal(placements.length, count);
    assert.equal(new Set(result.map(x => x.accountId)).size, count, 'Ogni rientro deve avere account_id autonomo');
    assert.equal(new Set(result.map(x => x.ticketNumber)).size, count, 'Ogni rientro deve avere ticket autonomo');
    assert.equal(new Set(result.map(x => x.sigla)).size, count, 'Ogni rientro deve avere sigla radice autonoma');
    assert.equal(new Set(result.map(x => x.personalTableId)).size, count, 'Ogni rientro deve avere tavola personale autonoma');
    assert.ok(result.every(x => x.wallet === wallet), 'Tutti i rientri devono restare sul wallet MetaMask originale');
    assert.ok(result.every(x => x.accountId !== sourceId), 'La radice rientro non deve riusare account_id del Secondario sorgente');
    assert.ok(result.every(x => x.sourceAccountId === sourceId && x.sourceAccountSigla === sourceSigla));
    assert.ok(result.every(x => String(x.ticketNumber) === x.sigla), 'Sigla radice deve essere il ticket Entrata');
    assert.ok(placements.every((p, i) => p.accountId === result[i].accountId && p.accountSigla === result[i].sigla));
    assert.ok(createdInputs.every(x => x.wallet === wallet && x.tipo === 'PRIMARIO' && x.parentAccountId === null));
    assert.ok(createdInputs.every(x => x.sourceAccountId === sourceId && x.sourceEventKey === eventKey && x.originKind === source));

    const completed = placements.filter(p => p.completed).length;
    assert.equal(postCommit.length, completed);
    assert.equal(entryStarts, completed);
    assert.ok(postCommit.every(op => op.operationType === 'USCITA_ENTRATA_POST_COMMIT'));
    assert.ok(postCommit.every(op => op.payload.source === source));
    assert.ok(postCommit.every(op => Number.isInteger(Number(op.payload.eredeAccountId))));

    return { result, placements, postCommit, entryStarts };
  } finally {
    delete require.cache[reentryPath];
    Module._load = originalLoad;
  }
}

(async () => {
  const thot = await runCase({
    source: 'THOT_REENTRY',
    count: 5,
    sourceId: 900,
    sourceSigla: '23.1',
    tipo: 'PERPETUO'
  });
  assert.deepEqual(thot.placements.map(x => x.casella), [1, 2, 3, 4, 5]);
  assert.equal(thot.entryStarts, 0);

  const iside = await runCase({
    source: 'ISIDE_REENTRY',
    count: 50,
    sourceId: 901,
    sourceSigla: '1-23',
    tipo: 'GEMELLO'
  });
  assert.equal(iside.entryStarts, 9);
  assert.equal(iside.placements.filter(x => x.completed).length, 9);
  assert.equal(iside.placements.slice(-2)[0].turno, 10);
  assert.equal(iside.placements.slice(-2)[1].turno, 10);

  const flow = fs.readFileSync(path.join(ROOT, 'donation-flow-manager.js'), 'utf8');
  assert.ok(flow.includes('eredeAccountId: eredeAccount.id'));
  assert.ok(flow.includes('await posizionaSacerdoteInPharaoh(wallet, nomeErede, client, eredeIdentity);'));
  assert.ok(flow.includes('if (prossimaTavolaFaraone.faraone_account_id)'));

  console.log('PASS AUTONOMOUS REENTRY: THOT 5/5 e ISIDE 50/50 = nuove radici Entrata autonome, ticket/sigla/account_id distinti, stesso wallet MetaMask');
  console.log('PASS AUTONOMOUS REENTRY: ogni radice crea la propria tavola personale; con riporto Cassa dalla Tavola 2, ISIDE attraversa 9 chiusure e continua nella decima tavola');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

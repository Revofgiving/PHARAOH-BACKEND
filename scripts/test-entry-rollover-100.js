'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CASSA = '0x2222222222222222222222222222222222222222';

const positions = new Map();
const reserved = new Map();
const rollovers = new Map();
const tableStatus = new Map();
let nextPositionId = 1;
let nextTableId = 1000;
let nextTableNumber = 1000;

function list(tableId) {
  if (!positions.has(Number(tableId))) positions.set(Number(tableId), []);
  return positions.get(Number(tableId));
}

const dbStub = {
  async countPosizioniInTavola(tableId) { return list(tableId).length; },
  async getPosizioniTavola(tableId) { return list(tableId).map(x => ({ ...x })); },
  async getEntryReservedSlots({ turnoNumero, tavolaNumero }) {
    return reserved.get(`${turnoNumero}:${tavolaNumero}`) || [];
  },
  async createPosizione(input) {
    const row = { id: nextPositionId++, tavola_id: Number(input.tavolaId), casella: Number(input.casella), wallet: input.wallet, nome: input.nome, tipo: input.tipo, dono_importo: Number(input.donoImporto), account_id: input.accountId, account_sigla: input.accountSigla };
    const rows = list(input.tavolaId);
    assert.ok(!rows.some(x => x.casella === row.casella), `casella duplicata ${row.casella}`);
    rows.push(row);
    return { ...row };
  },
  async updateTavolaDoni() { return { ok: true }; },
  async getNextTavolaNumero() { return nextTableNumber++; },
  async createTavola(input) { return { id: nextTableId++, ...input }; },
  async updatePosizioneSdoppiamento() { return { ok: true }; },
  async updateTavolaStatus(numero, status) { tableStatus.set(Number(numero), status); return { numero, status }; },
  async getEntryRolloverBySourceTable(sourceId) { return rollovers.get(Number(sourceId)) || null; },
  async createEntryRolloverAudit(input) {
    const existing = rollovers.get(Number(input.sourceTavolaId));
    if (existing) return existing;
    const row = {
      id: rollovers.size + 1,
      event_key: input.eventKey,
      source_tavola_id: Number(input.sourceTavolaId),
      source_tavola_numero: Number(input.sourceTavolaNumero),
      target_tavola_id: Number(input.targetTavolaId),
      target_tavola_numero: Number(input.targetTavolaNumero),
      target_turno: Number(input.targetTurno),
      cassa_wallet: input.cassaWallet,
      amount_usdc: Number(input.amountUsdc),
      target_casella: Number(input.targetCasella),
      posizione_id: Number(input.posizioneId),
      status: 'MATERIALIZED'
    };
    rollovers.set(Number(input.sourceTavolaId), row);
    return { ...row };
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && path.resolve(parent.filename) === path.join(ROOT, 'table-manager.js') && request === './db-manager') {
    return dbStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  const tablePath = require.resolve(path.join(ROOT, 'table-manager.js'));
  delete require.cache[tablePath];
  const tm = require(tablePath);

  const table1 = { id: 1, numero: 1, turno: 1 };
  for (let i = 1; i <= 6; i += 1) {
    const r = await tm.posizionaDonatore({
      tavolaId: table1.id,
      tavolaNumero: table1.numero,
      livello: 0,
      wallet: `0x${String(i).padStart(40, '0')}`,
      nome: `D${i}`,
      tipo: 'DONATORE',
      donoImporto: 100,
      turno: 1,
      sdoppiabile: true,
      accountId: i,
      accountSigla: String(i),
      client: {}
    });
    assert.equal(r.casellaOccupata, i);
    assert.equal(r.tavolaCompleta, i === 6);
  }
  assert.equal(tableStatus.get(1), 'COMPLETATA');
  assert.equal(list(1).filter(x => x.tipo === 'DONATORE').length, 6, 'Tavola 1 deve avere 6 donatori reali');
  assert.equal(list(1).filter(x => x.tipo === 'ROLLOVER').length, 0, 'Tavola 1 non deve avere rollover');

  const table2 = { id: 2, numero: 2, turno: 2 };
  const rollover = await tm.materializzaRolloverEntrata({ sourceTavola: table1, targetTavola: table2, targetTurno: 2, cassaWallet: CASSA, client: {} });
  assert.equal(rollover.placement.casellaOccupata, 1);
  assert.equal(rollover.placement.tavolaSdoppiamento, null);
  assert.equal(list(2)[0].tipo, 'ROLLOVER');
  assert.equal(list(2)[0].wallet, CASSA);
  assert.equal(list(2)[0].dono_importo, 100);
  assert.equal(list(2)[0].account_id, null);

  const repeat = await tm.materializzaRolloverEntrata({ sourceTavola: table1, targetTavola: table2, targetTurno: 2, cassaWallet: CASSA, client: {} });
  assert.equal(repeat.idempotent, true);
  assert.equal(list(2).filter(x => x.tipo === 'ROLLOVER').length, 1, 'Retry non deve duplicare rollover');

  for (let i = 1; i <= 5; i += 1) {
    const r = await tm.posizionaDonatore({
      tavolaId: table2.id,
      tavolaNumero: table2.numero,
      livello: 0,
      wallet: `0x${String(100 + i).padStart(40, '0')}`,
      nome: `N${i}`,
      tipo: 'DONATORE',
      donoImporto: 100,
      turno: 2,
      sdoppiabile: true,
      accountId: 100 + i,
      accountSigla: String(100 + i),
      client: {}
    });
    assert.equal(r.casellaOccupata, i + 1);
    assert.equal(r.tavolaCompleta, i === 5);
  }
  assert.equal(list(2).length, 6, 'Tavola 2 = 1 rollover + 5 nuovi ingressi');
  assert.equal(list(2).filter(x => x.tipo === 'DONATORE').length, 5);
  assert.equal(tableStatus.get(2), 'COMPLETATA');

  const table3 = { id: 3, numero: 3, turno: 3 };
  reserved.set('3:3', [1, 4]);
  const rolloverReserved = await tm.materializzaRolloverEntrata({ sourceTavola: table2, targetTavola: table3, targetTurno: 3, cassaWallet: CASSA, client: {} });
  assert.equal(rolloverReserved.placement.casellaOccupata, 2, 'Rollover deve saltare casella Funzione 1');
  const donor = await tm.posizionaDonatore({
    tavolaId: table3.id,
    tavolaNumero: table3.numero,
    livello: 0,
    wallet: '0x3333333333333333333333333333333333333333',
    nome: 'Rientro',
    tipo: 'DONATORE',
    donoImporto: 100,
    turno: 3,
    sdoppiabile: true,
    accountId: 333,
    accountSigla: '333',
    client: {}
  });
  assert.equal(donor.casellaOccupata, 3, 'Rientro deve saltare caselle Funzione 1 e 4');
  assert.ok(![1, 4].includes(rolloverReserved.placement.casellaOccupata));
  assert.ok(![1, 4].includes(donor.casellaOccupata));

  const flow = fs.readFileSync(path.join(ROOT, 'donation-flow-manager.js'), 'utf8');
  const dbSource = fs.readFileSync(path.join(ROOT, 'db-manager.js'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'api-server.js'), 'utf8');
  assert.ok(flow.includes('materializzaRolloverEntrata'));
  assert.ok(flow.includes('sacerdotiNecessari: 5'));
  assert.ok(!flow.includes('ENTRY_RESERVE_WALLET'));
  assert.ok(!api.includes('/api/admin/doni-pendenti/entry-reserve/process'));
  assert.ok(dbSource.includes("pf.stato IN ('RESERVED','MATERIALIZED')"), 'Ticket ordinari devono rispettare prenotazioni Funzioni');

  console.log('ENTRY_ROLLOVER_100_PASS');
  console.log('PASS Tavola 1: 6 donatori reali; Tavola 2+: 100 Cassa PHARAOH + 5 nuovi ingressi; rollover/rientri non invadono prenotazioni Funzioni');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
});

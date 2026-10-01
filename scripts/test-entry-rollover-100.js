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
const accountsByKey = new Map();
let nextAccountId = 5000;
const tableStatus = new Map();
let nextPositionId = 1;
let nextTableId = 1000;
let nextTableNumber = 2;

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
  async shiftEntryFunctionReservationFromSlotOne({ turnoNumero, tavolaNumero }) {
    const key = `${turnoNumero}:${tavolaNumero}`;
    const slots = [...(reserved.get(key) || [])];
    if (!slots.includes(1)) return null;
    const used = new Set(slots.filter(x => x !== 1));
    let target = null;
    for (let c = 2; c <= 6; c += 1) { if (!used.has(c)) { target = c; break; } }
    assert.ok(target, 'deve esistere una casella per spostare la Funzione');
    reserved.set(key, slots.map(x => x === 1 ? target : x));
    return { casella: target };
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
  async getAccountByKey(key) { return accountsByKey.get(String(key)) || null; },
  async createAccount(input) {
    const row = { id: nextAccountId++, wallet: String(input.wallet).toLowerCase(), nome: input.nome, tipo: input.tipo, sigla: input.sigla || null, account_key: input.accountKey, numero_posizionale: null, root_account_id: input.rootAccountId || null, origin_kind: input.originKind };
    accountsByKey.set(String(input.accountKey), row);
    return { ...row };
  },
  async setAccountNumeroPosizionale(id, numero) {
    for (const [k, row] of accountsByKey.entries()) {
      if (Number(row.id) === Number(id)) { row.numero_posizionale = Number(numero); if (!row.sigla) row.sigla = String(numero); accountsByKey.set(k, row); return { ...row }; }
    }
    throw new Error('account stub non trovato');
  },
  async updateAccountIdentity(id, patch) {
    for (const [k, row] of accountsByKey.entries()) {
      if (Number(row.id) === Number(id)) { if (patch.rootAccountId !== undefined) row.root_account_id = patch.rootAccountId; if (patch.sigla !== undefined) row.sigla = patch.sigla; accountsByKey.set(k, row); return { ...row }; }
    }
    throw new Error('account stub non trovato');
  },
  async syncEntryPlacementIdentity({ posizioneId, tavolaSdoppiamentoId, accountId, accountSigla }) {
    for (const rows of positions.values()) { const p = rows.find(x => Number(x.id) === Number(posizioneId)); if (p) { p.account_id = accountId; p.account_sigla = accountSigla; p.sdoppiamento_tavola_id = tavolaSdoppiamentoId; } }
    return { ok: true };
  },
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
  assert.equal(list(1).filter(x => x.tipo === 'CASSA').length, 0, 'Tavola 1 non deve avere posizione Cassa');

  const table2 = { id: 2, numero: 2, turno: 2 };
  const rollover = await tm.materializzaCassaEntrata({ sourceTavola: table1, targetTavola: table2, targetTurno: 2, cassaWallet: CASSA, client: {} });
  assert.equal(rollover.placement.casellaOccupata, 1);
  assert.equal(rollover.placement.numeroPosizionaleGlobale, 7, 'Tavola 2/casella 1 deve essere globale 7');
  assert.ok(rollover.placement.tavolaSdoppiamento, 'La Cassa deve generare tavola personale');
  assert.equal(rollover.placement.tavolaSdoppiamento.numero, 8, 'Posizione Cassa #7 deve generare Tavola personale #8');
  assert.equal(rollover.account.numero_posizionale, 7);
  assert.equal(rollover.account.sigla, '7');
  assert.equal(list(2)[0].tipo, 'CASSA');
  assert.equal(list(2)[0].wallet, CASSA);
  assert.equal(list(2)[0].dono_importo, 100);
  assert.equal(Number(list(2)[0].account_id), Number(rollover.account.id));

  const repeat = await tm.materializzaCassaEntrata({ sourceTavola: table1, targetTavola: table2, targetTurno: 2, cassaWallet: CASSA, client: {} });
  assert.equal(repeat.idempotent, true);
  assert.equal(list(2).filter(x => x.tipo === 'CASSA').length, 1, 'Retry non deve duplicare la posizione Cassa');

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
    assert.equal(r.numeroPosizionaleGlobale, 7 + i, `Donatore Tavola 2 deve avere globale ${7 + i}`);
    assert.equal(r.tavolaCompleta, i === 5);
  }
  assert.equal(list(2).length, 6, 'Tavola 2 = 1 Cassa completa + 5 nuovi ingressi');
  assert.equal(list(2).filter(x => x.tipo === 'DONATORE').length, 5);
  assert.equal(tableStatus.get(2), 'COMPLETATA');

  const table3 = { id: 3, numero: 3, turno: 3 };
  reserved.set('3:3', [1, 4]);
  const rolloverReserved = await tm.materializzaCassaEntrata({ sourceTavola: table2, targetTavola: table3, targetTurno: 3, cassaWallet: CASSA, client: {} });
  assert.equal(rolloverReserved.placement.casellaOccupata, 1, 'Cassa PHARAOH deve avere precedenza assoluta sulla casella 1');
  assert.equal(rolloverReserved.placement.numeroPosizionaleGlobale, 13, 'Tavola 3/casella 1 deve essere globale 13');
  assert.equal(rolloverReserved.placement.tavolaSdoppiamento.numero, 14, 'Posizione Cassa #13 deve generare Tavola personale #14');
  assert.deepEqual(reserved.get('3:3'), [2, 4], 'La Funzione prenotata in casella 1 deve slittare alla casella 2');
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
  assert.equal(donor.numeroPosizionaleGlobale, 15, 'Tavola 3/casella 3 deve essere globale 15');
  assert.equal(rolloverReserved.placement.casellaOccupata, 1);
  assert.ok(![1, 4].includes(donor.casellaOccupata));

  const flow = fs.readFileSync(path.join(ROOT, 'donation-flow-manager.js'), 'utf8');
  const dbSource = fs.readFileSync(path.join(ROOT, 'db-manager.js'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'api-server.js'), 'utf8');
  assert.ok(flow.includes('materializzaCassaEntrata'));
  assert.ok(flow.includes('sacerdotiNecessari: 6'));
  assert.ok(flow.includes('incrementSacerdotiEntrati(nuovoTurno.id'), 'La Cassa deve contare tra i 6 occupanti del turno');
  assert.ok(!flow.includes('ENTRY_RESERVE_WALLET'));
  assert.ok(!api.includes('/api/admin/doni-pendenti/entry-reserve/process'));
  assert.ok(dbSource.includes("pf.stato IN ('RESERVED','MATERIALIZED')"), 'Numero posizionale ordinari devono rispettare prenotazioni Funzioni');

  const expected = [
    [1, 1, 1], [1, 6, 6],
    [2, 1, 7], [2, 6, 12],
    [3, 1, 13], [3, 6, 18],
    [4, 1, 19], [4, 6, 24],
    [5, 1, 25], [5, 6, 30],
    [6, 1, 31], [6, 6, 36]
  ];
  for (const [tavola, casella, globale] of expected) {
    assert.equal(tm.calcolaPosizioneGlobaleEntrata(tavola, casella), globale);
  }

  console.log('ENTRY_CASSA_POSITION_100_PASS');
  console.log('PASS Tavola 1: 1..6 HUMAN; Tavola 2: Cassa completa=7 + HUMAN 8..12; Tavola 3: Cassa completa=13; Cassa sdoppia e Funzione in slot 1 slitta a slot 2');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
});

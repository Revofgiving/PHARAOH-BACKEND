'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CASSA = '0x2222222222222222222222222222222222222222';

process.env.PHARAOH_PROJECTS_WALLET = CASSA;
const projectMemberships = [];
const positions = new Map();
const rollovers = new Map();
const accountsByKey = new Map();
const accountsById = new Map();
let nextAccountId = 5000;
const tableStatus = new Map();
let nextPositionId = 1;
let nextTableId = 1000;
let nextTableNumber = 2;
let lastGlobal = 0;

function list(tableId) {
  if (!positions.has(Number(tableId))) positions.set(Number(tableId), []);
  return positions.get(Number(tableId));
}
function isGemelloReserved(n) { return n >= 26 && (n - 26) % 14 === 0; }
function allPositions() { return [...positions.values()].flat(); }

const dbStub = {
  async countPosizioniInTavola(tableId) { return list(tableId).length; },
  async getPosizioniTavola(tableId) { return list(tableId).map(x => ({ ...x })); },
  async allocateNextEntryNumeroPosizionale() {
    let n = lastGlobal + 1;
    while (isGemelloReserved(n) || allPositions().some(p => Number(p.numero_posizionale) === n)) n += 1;
    lastGlobal = n;
    return n;
  },
  async assertEntryNumeroPosizionaleAssignable(_client, numero) {
    const n = Number(numero);
    assert.ok(Number.isInteger(n) && n > 0);
    assert.ok(!isGemelloReserved(n), `numero ${n} non deve essere riservato Gemello`);
    assert.ok(!allPositions().some(p => Number(p.numero_posizionale) === n), `numero ${n} non deve essere occupato`);
    return n;
  },
  async createPosizione(input) {
    const row = {
      id: nextPositionId++,
      tavola_id: Number(input.tavolaId),
      casella: Number(input.casella),
      wallet: input.wallet,
      nome: input.nome,
      tipo: input.tipo,
      dono_importo: Number(input.donoImporto),
      account_id: input.accountId,
      account_sigla: input.accountSigla,
      numero_posizionale: Number(input.numeroPosizionale)
    };
    const rows = list(input.tavolaId);
    assert.ok(!rows.some(x => x.casella === row.casella), `casella duplicata ${row.casella}`);
    assert.ok(!allPositions().some(x => Number(x.numero_posizionale) === row.numero_posizionale), `numero globale duplicato ${row.numero_posizionale}`);
    rows.push(row);
    return { ...row };
  },
  async updateTavolaDoni() { return { ok: true }; },
  async getNextTavolaNumero() { return nextTableNumber++; },
  async createTavola(input) { return { id: nextTableId++, ...input }; },
  async getAccountByKey(key) { return accountsByKey.get(String(key)) || null; },
  async getAccountById(id) { return accountsById.get(Number(id)) || null; },
  async createAccount(input) {
    const row = {
      id: nextAccountId++,
      wallet: String(input.wallet).toLowerCase(),
      nome: input.nome,
      tipo: input.tipo,
      sigla: input.sigla || null,
      account_key: input.accountKey,
      numero_posizionale: null,
      root_account_id: input.rootAccountId || null,
      origin_kind: input.originKind
    };
    accountsByKey.set(String(input.accountKey), row);
    accountsById.set(Number(row.id), row);
    return { ...row };
  },
  async setAccountNumeroPosizionale(id, numero) {
    const row = accountsById.get(Number(id));
    if (!row) throw new Error('account stub non trovato');
    row.numero_posizionale = Number(numero);
    if (!row.sigla) row.sigla = String(numero);
    accountsById.set(Number(id), row);
    if (row.account_key) accountsByKey.set(String(row.account_key), row);
    return { ...row };
  },
  async updateAccountIdentity(id, patch) {
    const row = accountsById.get(Number(id));
    if (!row) throw new Error('account stub non trovato');
    if (patch.rootAccountId !== undefined) row.root_account_id = patch.rootAccountId;
    if (patch.sigla !== undefined) row.sigla = patch.sigla;
    accountsById.set(Number(id), row);
    if (row.account_key) accountsByKey.set(String(row.account_key), row);
    return { ...row };
  },
  async syncEntryPlacementIdentity({ posizioneId, tavolaSdoppiamentoId, accountId, accountSigla }) {
    for (const rows of positions.values()) {
      const p = rows.find(x => Number(x.id) === Number(posizioneId));
      if (p) {
        p.account_id = accountId;
        p.account_sigla = accountSigla;
        p.sdoppiamento_tavola_id = tavolaSdoppiamentoId;
      }
    }
    return { ok: true };
  },
  async updatePosizioneSdoppiamento(posizioneId, tavolaSdoppiamentoId) {
    for (const rows of positions.values()) {
      const p = rows.find(x => Number(x.id) === Number(posizioneId));
      if (p) p.sdoppiamento_tavola_id = tavolaSdoppiamentoId;
    }
    return { ok: true };
  },
  async getPosizioneById(id) { return allPositions().find(p => Number(p.id) === Number(id)) || null; },
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
  if (parent && path.resolve(parent.filename) === path.join(ROOT, 'table-manager.js') && request === './db-manager') return dbStub;
  if (parent && path.resolve(parent.filename) === path.join(ROOT, 'table-manager.js') && request === './economic-flow') return {configuredFlow(c){assert.ok(c);return {async assertProjectsCapital(){return {wallet:CASSA,balance_atomic:'100000000'};},async recordProjectsPosition(account,placed){projectMemberships.push({accountId:account.id,number:placed.number});}};}};
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  const tablePath = require.resolve(path.join(ROOT, 'table-manager.js'));
  delete require.cache[tablePath];
  const tm = require(tablePath);

  const table1 = { id: 1, numero: 1, turno: 1 };
  for (let i = 1; i <= 6; i += 1) {
    const r = await tm.posizionaDonatore({
      tavolaId: 1, tavolaNumero: 1, livello: 0,
      wallet: `0x${String(i).padStart(40, '0')}`, nome: `D${i}`,
      tipo: 'DONATORE', donoImporto: 100, turno: 1, sdoppiabile: true,
      accountId: i, accountSigla: String(i), client: {}
    });
    assert.equal(r.casellaOccupata, i);
    assert.equal(r.numeroPosizionaleGlobale, i);
  }
  assert.equal(tableStatus.get(1), 'COMPLETATA');

  const table2 = { id: 2, numero: 2, turno: 2 };
  const c7 = await tm.materializzaCassaEntrata({ sourceTavola: table1, targetTavola: table2, targetTurno: 2, cassaWallet: CASSA, client: {} });
  assert.equal(c7.placement.casellaOccupata, 1);
  assert.equal(c7.placement.numeroPosizionaleGlobale, 7);
  assert.equal(c7.account.numero_posizionale, 7);
  assert.ok(c7.placement.tavolaSdoppiamento);
  const retry = await tm.materializzaCassaEntrata({ sourceTavola: table1, targetTavola: table2, targetTurno: 2, cassaWallet: CASSA, client: {} });
  assert.equal(retry.idempotent, true);

  for (let i = 1; i <= 5; i += 1) {
    const r = await tm.posizionaDonatore({
      tavolaId: 2, tavolaNumero: 2, livello: 0,
      wallet: `0x${String(100 + i).padStart(40, '0')}`, nome: `N${i}`,
      tipo: 'DONATORE', donoImporto: 100, turno: 2, sdoppiabile: true,
      accountId: 100 + i, accountSigla: String(100 + i), client: {}
    });
    assert.equal(r.numeroPosizionaleGlobale, 7 + i);
  }
  assert.equal(list(2).length, 6, 'Tavola 2 = Cassa + 5 HUMAN');

  // Simulazione dinamica completa fino alla 19a Cassa del prospetto operativo.
  // Ogni nuova tavola riceve Cassa in casella 1 e cinque HUMAN reali.
  const cassaAtteseDinamiche = [7,13,19,25,32,38,45,51,58,64,71,77,84,90,97,103,109,116,122];
  assert.equal(c7.placement.numeroPosizionaleGlobale, cassaAtteseDinamiche[0]);
  for (let tavolaNumero = 3; tavolaNumero <= 70; tavolaNumero += 1) {
    const sourceTavola = { id: tavolaNumero - 1, numero: tavolaNumero - 1, turno: tavolaNumero - 1 };
    const targetTavola = { id: tavolaNumero, numero: tavolaNumero, turno: tavolaNumero };
    const cassa = await tm.materializzaCassaEntrata({
      sourceTavola, targetTavola, targetTurno: tavolaNumero, cassaWallet: CASSA, client: {}
    });
    assert.equal(
      cassa.placement.numeroPosizionaleGlobale,
      cassaAtteseDinamiche[tavolaNumero - 2] ?? tm.calcolaPosizioneGlobaleEntrata(tavolaNumero,1),
      `Cassa Tavola ${tavolaNumero}`
    );
    assert.equal(cassa.placement.casellaOccupata, 1);

    for (let slot = 2; slot <= 6; slot += 1) {
      const donorId = tavolaNumero * 100 + slot;
      const r = await tm.posizionaDonatore({
        tavolaId: tavolaNumero, tavolaNumero, livello: 0,
        wallet: `0x${String(donorId).padStart(40, '0')}`, nome: `T${tavolaNumero}H${slot - 1}`,
        tipo: 'DONATORE', donoImporto: 100, turno: tavolaNumero, sdoppiabile: true,
        accountId: donorId, accountSigla: String(donorId), client: {}
      });
      assert.equal(r.casellaOccupata, slot);
      assert.ok(!isGemelloReserved(r.numeroPosizionaleGlobale), `HUMAN non puo usare ${r.numeroPosizionaleGlobale}`);
    }
    assert.equal(list(tavolaNumero).length, 6, `Tavola ${tavolaNumero} deve avere 6 posizioni fisiche`);
  }

  const globaliMaterializzati = allPositions().map(p => Number(p.numero_posizionale));
  assert.ok(Math.max(...globaliMaterializzati)>=393);
  assert.equal(projectMemberships.length,69);
  for(let n=26;n<=393;n+=14)assert.ok(!globaliMaterializzati.includes(n));
  assert.equal(new Set(globaliMaterializzati).size, globaliMaterializzati.length, 'Nessun numero posizionale puo duplicarsi');
  [26,40,54,68,82,96,110,124].forEach(n => {
    assert.ok(!globaliMaterializzati.includes(n), `Il numero riservato ${n} non deve essere materializzato in ENTRATA`);
  });

  // La prenotazione 26 NON occupa una casella fisica. La quinta tavola fisica
  // usa i numeri 25,27,28,29,30,31 e la Cassa successiva diventa 32.
  const expected = [
    [1, 1, 1], [1, 6, 6],
    [2, 1, 7], [2, 6, 12],
    [3, 1, 13], [3, 6, 18],
    [4, 1, 19], [4, 6, 24],
    [5, 1, 25], [5, 2, 27], [5, 6, 31],
    [6, 1, 32], [6, 6, 37],
    [7, 1, 38], [7, 2, 39], [7, 3, 41], [7, 6, 44],
    [8, 1, 45]
  ];
  for (const [tavola, casella, globale] of expected) {
    assert.equal(tm.calcolaPosizioneGlobaleEntrata(tavola, casella), globale);
  }

  const cassaAttesePure = [7,13,19,25,32,38,45,51,58,64,71,77,84,90,97,103,109,116,122];
  cassaAttesePure.forEach((numero, index) => {
    const tavola = index + 2;
    assert.equal(tm.calcolaPosizioneGlobaleEntrata(tavola, 1), numero, `Cassa tavola ${tavola}`);
  });
  [26,40,54,68,82,96,110].forEach(n => assert.ok(isGemelloReserved(n)));

  const flow = fs.readFileSync(path.join(ROOT, 'donation-flow-manager.js'), 'utf8');
  const dbSource = fs.readFileSync(path.join(ROOT, 'db-manager.js'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'api-server.js'), 'utf8');
  assert.ok(flow.includes('materializzaCassaEntrata'));
  assert.ok(flow.includes('sacerdotiNecessari: 6'));
  assert.ok(flow.includes('incrementSacerdotiEntrati(nuovoTurno.id'));
  assert.ok(!flow.includes('ENTRY_RESERVE_WALLET'));
  assert.ok(!api.includes('/api/admin/doni-pendenti/entry-reserve/process'));
  assert.ok(dbSource.includes('allocateNextEntryNumeroPosizionale'));
  assert.ok(dbSource.includes("pf.stato IN ('RESERVED','MATERIALIZED','CONSUMED')"));

  console.log('ENTRY_GLOBAL_PROGRESSIVE_CASSA_FUNCTION_RESERVATIONS_PASS: 70 tables through number '+Math.max(...globaliMaterializzati)+'; real table manager with in-memory DB and protected-capital fixture, NOT PostgreSQL');
  console.log('PASS: progressivo 1->infinito; Gemelli 26/40/54... riservati; Casse 7/13/19/25/32/38/45...');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
});

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const rules = require('../rules-engine');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

for (const type of ['FONDO', 'PRIMARIO']) {
  const c = rules.classificaAccountRha(type);
  assert.equal(c.categoria, 'PRIMARIO');
  const u = rules.calcolaUscitaLivello(3, type, 9000);
  assert.equal(u.dettaglioFunzioni.allocazioneRha.rogUsdc, 300);
  assert.equal(u.dettaglioFunzioni.allocazioneRha.rogDualPositions, 150);
  assert.equal(u.dettaglioFunzioni.allocazioneRha.uranusUsdc, 200);
  assert.equal(u.dettaglioFunzioni.allocazioneRha.uranusDualPositions, 10);
  assert.equal(u.dettaglioFunzioni.allocazioneRha.rogUsdc + u.dettaglioFunzioni.allocazioneRha.uranusUsdc, 500);
  assert.equal(u.trattenutaCassa, 3000);
  assert.equal(u.netto, 6000);
}
for (const type of ['PERPETUO', 'GEMELLO']) {
  const c = rules.classificaAccountRha(type);
  assert.equal(c.categoria, 'SECONDARIO');
  const u = rules.calcolaUscitaLivello(3, type, 9000);
  assert.equal(u.dettaglioFunzioni.allocazioneRha.rogUsdc, 300);
  assert.equal(u.dettaglioFunzioni.allocazioneRha.rogDualPositions, 150);
  assert.equal(u.dettaglioFunzioni.allocazioneRha.uranusUsdc, 200);
  assert.equal(u.dettaglioFunzioni.allocazioneRha.uranusDualPositions, 10);
  assert.equal(u.dettaglioFunzioni.allocazioneRha.rogUsdc + u.dettaglioFunzioni.allocazioneRha.uranusUsdc, 500);
  assert.equal(u.trattenutaCassa, 3000);
  assert.equal(u.netto, 1000);
}

const flow = read('donation-flow-manager.js');
assert.ok(flow.includes("!['PRIMARIO', 'SECONDARIO'].includes(classificazione.categoria)"));
assert.ok(flow.includes('crossOutbound.scheduleRhaExit({'));
assert.ok(flow.includes('beneficiaryWallet: faraoneWallet'));
assert.ok(flow.includes('accountId: account.id'));
assert.ok(flow.includes('accountSigla: sigla'));
const ruleSource = read('rules-engine.js');
assert.ok(ruleSource.includes('RHA_ROG_OUTBOUND: 300'));
assert.ok(ruleSource.includes('RHA_ROG_DUAL_POSITIONS: 150'));
assert.ok(ruleSource.includes('RHA_URANUS_OUTBOUND: 200'));
assert.ok(ruleSource.includes('RHA_URANUS_DUAL_POSITIONS: 10'));
console.log('PASS RHA DUAL STATIC: PRIMARI+SECONDARI, 300 ROG/150 dual, 200 URANUS/10 dual, beneficiario ricevente RHA');

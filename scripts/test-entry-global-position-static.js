'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const api = fs.readFileSync(path.join(__dirname, '..', 'api-server.js'), 'utf8');
const table = fs.readFileSync(path.join(__dirname, '..', 'table-manager.js'), 'utf8');
const db = fs.readFileSync(path.join(__dirname, '..', 'db-manager.js'), 'utf8');

assert.ok(api.includes('pe.numero_posizionale AS numero_posizionale'), 'Area Personale deve leggere il numero canonico della posizione ENTRATA');
assert.ok(api.includes('ep.entrata_tavola_numero'), 'Area Personale deve esporre la tavola Entrata origine');
assert.ok(api.includes('ep.entrata_casella'), 'Area Personale deve esporre la casella Entrata origine');
assert.ok(table.includes('((tavola - 1) * 6) + slot'), 'Formula canonica deve essere tavola/casella su blocchi da 6');
assert.ok(db.includes('numero_posizionale'), 'Database deve usare numero_posizionale');
assert.ok(!api.includes('/api/account/ticket/'), 'Endpoint ticket legacy deve essere assente');
assert.ok(api.includes('/api/account/posizione/:numeroPosizionale'), 'Deve esistere endpoint per numero_posizionale');

console.log('ENTRY_GLOBAL_POSITION_STATIC_PASS');

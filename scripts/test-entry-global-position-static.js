'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'api-server.js'), 'utf8');
const table = fs.readFileSync(path.join(root, 'table-manager.js'), 'utf8');
const db = fs.readFileSync(path.join(root, 'db-manager.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'database', '0025_entry_global_progressive_with_function_reservations.sql'), 'utf8');

assert.ok(api.includes('pe.numero_posizionale AS numero_posizionale'), 'Area Personale deve leggere il numero canonico della posizione ENTRATA');
assert.ok(api.includes('ep.entrata_tavola_numero'));
assert.ok(api.includes('ep.entrata_casella'));
assert.ok(!api.includes('(((t.numero - 1) * 6) + p.casella)::bigint'), 'API non deve ricostruire il numero globale dalla tavola/casella');
assert.ok(api.includes("WHEN t.sezione = 'ENTRATA' AND t.livello = 0 THEN p.numero_posizionale"), 'Fallback API deve usare il numero canonico persistito');
assert.ok(table.includes('allocateNextEntryNumeroPosizionale'), 'Runtime ENTRATA deve usare allocatore globale');
assert.ok(!table.includes('numeroPosizionaleGlobale: Number(livello) === 0\n      ? calcolaPosizioneGlobaleEntrata'), 'Runtime non deve derivare il numero dalla tavola');
assert.ok(db.includes('entry_position_counter'), 'Deve esistere contatore persistente globale');
assert.ok(db.includes('NUMERO_POSIZIONALE_ADVISORY_LOCK_KEY'), 'Allocazione deve essere serializzata');
assert.ok(db.includes('isNumeroPosizionaleGemello'), 'Allocatore deve preservare 26,40,54...');
assert.ok(migration.includes('CASSA: 7,13,19,25,32,38,45,51,58,64,71,77,84,90,97,103,109,116,122'));
assert.ok(migration.includes('GEMELLI riservati: 26,40,54,68,82,96,110'));
assert.ok(!api.includes('/api/account/ticket/'));
assert.ok(api.includes('/api/account/posizione/:numeroPosizionale'));

console.log('ENTRY_GLOBAL_POSITION_STATIC_PASS');

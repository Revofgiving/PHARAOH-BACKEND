'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const api = fs.readFileSync(path.join(__dirname, '..', 'api-server.js'), 'utf8');

assert.ok(api.includes("(((te.numero - 1) * 6) + pe.casella)::bigint AS numero_posizionale"), 'Area Personale deve derivare la posizione globale dalla tavola/casella Entrata');
assert.ok(api.includes('a.ticket_number AS ticket_number'), 'ticket_number deve restare separato dalla posizione globale');
assert.ok(api.includes('ep.entrata_tavola_numero'), 'Area Personale deve esporre la tavola Entrata origine');
assert.ok(api.includes('ep.entrata_casella'), 'Area Personale deve esporre la casella Entrata origine');
assert.ok(!api.includes('a.ticket_number AS numero_posizionale'), 'ticket_number non deve piu essere usato come numero_posizionale');

console.log('ENTRY_GLOBAL_POSITION_STATIC_PASS');

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const runtimeFiles = [
  'account-manager.js',
  'admin-routes.js',
  'api-server.js',
  'container-manager.js',
  'cross-outbound-manager.js',
  'db-manager.js',
  'donation-flow-manager.js',
  'function-manager.js',
  'rules-engine.js'
];
const runtime = runtimeFiles.map(rel => `\n/* ${rel} */\n${read(rel)}`).join('');

for (const forbidden of [
  'accantonaDoniCredito',
  'distribuisciCrediti',
  'contaCreditiDisponibili',
  'createDonoCredito',
  'getDoniCreditoByEventKey',
  'assegnaDoniCredito',
  'doni_credito',
  'credito_id',
  'RHA_STAFF_OMAGGI',
  'staffOmaggiReservedUsdc',
  'staff_omaggi_reserved_usdc',
  'staff_omaggi_status',
  'NON_HA_DONO',
  'DICHIARAZIONE_SENZA_DONO',
  '/api/lista-attesa',
  "tipo: '5.3'",
  "tipo: '5.1'"
]) {
  assert.equal(runtime.includes(forbidden), false, `Residuo runtime vietato: ${forbidden}`);
}

assert.equal(fs.existsSync(path.join(ROOT, 'waiting-list-manager.js')), false, 'waiting-list-manager.js deve essere eliminato');
assert.ok(read('database/0008_remove_doni_credito.sql').includes('DROP TABLE IF EXISTS doni_credito'));
assert.ok(read('database/0009_remove_dono_al_volo_staff_legacy.sql').includes("CHECK (tipo IN ('5','5.2'))"));
assert.ok(read('database/0009_remove_dono_al_volo_staff_legacy.sql').includes('DROP COLUMN IF EXISTS staff_omaggi_reserved_usdc'));
assert.ok(read('rules-engine.js').includes('QUOTA_RICEVENTE_L5: 6000'));
assert.ok(read('rules-engine.js').includes('RHA_ROG_OUTBOUND: 300'));
assert.ok(read('rules-engine.js').includes('RHA_URANUS_OUTBOUND: 200'));

console.log('PASS NO CREDIT / NO DONO AL VOLO: runtime pulito, 5.1/5.3 rimossi, staff omaggi rimossi');

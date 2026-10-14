'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.NODE_ENV = 'test';
process.env.CROSS_PLATFORM_SECRET = 'x'.repeat(64);
process.env.URANUS_TREASURY_WALLET = '0x1111111111111111111111111111111111111111';
process.env.PHARAOH_TREASURY_WALLET = '0x2222222222222222222222222222222222222222';
process.env.ROG_TREASURY_WALLET = '0x3333333333333333333333333333333333333333';
process.env.USDC_CONTRACT_ADDRESS = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

const auth = require('../cross-platform-auth');
const crossEntry = require('../cross-entry-manager');

function expectCode(fn, code) {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught, `Atteso errore ${code}`);
  assert.equal(caught.code, code);
}

function testHmac() {
  const body = { event_key: 'uranus:42', amount: 100 };
  const sig = auth.signBody(body, 'URANUS');
  assert.match(sig, /^[a-f0-9]{64}$/);
  assert.equal(sig, auth.signBody({ amount: 100, event_key: 'uranus:42' }, 'URANUS'), 'HMAC deve essere indipendente dall ordine delle chiavi JSON');
  const req = { headers: { 'x-platform-origin': 'URANUS', 'x-platform-signature': sig }, body };
  assert.equal(auth.verifyRequest(req, 'URANUS').signatureVerified, true);
  expectCode(() => auth.verifyRequest({ ...req, headers: { ...req.headers, 'x-platform-origin': 'ROG' } }, 'URANUS'), 'CROSS_ORIGIN_FORBIDDEN');
  expectCode(() => auth.verifyRequest({ ...req, headers: { ...req.headers, 'x-platform-signature': '0'.repeat(64) } }, 'URANUS'), 'CROSS_SIGNATURE_INVALID');
}

function testUranusPayload() {
  const payload = crossEntry.normalizePayload({
    event_key: 'URANUS:DEVOLUTION:1',
    origine: 'URANUS',
    wallet_origine: process.env.URANUS_TREASURY_WALLET,
    wallet_beneficiario: '0x4444444444444444444444444444444444444444',
    wallet_cassa: process.env.PHARAOH_TREASURY_WALLET,
    importo_totale: 200,
    num_ingressi: 2,
    payment_tx_hash: `0x${'a'.repeat(64)}`
  });
  assert.equal(payload.sourcePlatform, 'URANUS_TO_PHARAOH');
  assert.equal(payload.paymentWallet, process.env.URANUS_TREASURY_WALLET);
  assert.equal(payload.beneficiaryWallet, '0x4444444444444444444444444444444444444444');
  assert.equal(payload.amountUsdc, 200);
  assert.equal(payload.positionsExpected, 2);
  crossEntry.assertTreasuries(payload);

  expectCode(() => crossEntry.normalizePayload({
    event_key: 'URANUS:BAD:150', origine: 'URANUS', wallet_origine: process.env.URANUS_TREASURY_WALLET,
    wallet_beneficiario: payload.beneficiaryWallet, wallet_cassa: process.env.PHARAOH_TREASURY_WALLET,
    importo_totale: 150, payment_tx_hash: `0x${'b'.repeat(64)}`
  }), 'CROSS_AMOUNT_INVALID');
  expectCode(() => crossEntry.normalizePayload({
    event_key: 'ROG:FORBIDDEN', origine: 'ROG', wallet_origine: process.env.ROG_TREASURY_WALLET,
    wallet_beneficiario: payload.beneficiaryWallet, wallet_cassa: process.env.PHARAOH_TREASURY_WALLET,
    importo_totale: 100, payment_tx_hash: `0x${'c'.repeat(64)}`
  }), 'CROSS_SOURCE_FORBIDDEN');
  expectCode(() => crossEntry.assertTreasuries({ ...payload, paymentWallet: process.env.ROG_TREASURY_WALLET }), 'CROSS_SOURCE_TREASURY_MISMATCH');
}

function staticInvariants() {
  const api = read('api-server.js');
  const cross = read('cross-entry-manager.js');
  const outbound = read('cross-outbound-manager.js');
  const payout = read('payout-manager.js');
  const flow = read('donation-flow-manager.js');
  const functions = read('function-manager.js');
  const rules = read('rules-engine.js');
  const migration = read('database/0004_cross_movements.sql');
  const migrationRhaV2 = read('database/0005_rha_dual_300_200.sql');
  const migrationThot = read('database/0006_thot_humanitarian_reentry.sql');
  const migrationIside = read('database/0007_iside_reentry_receiver_gift.sql');
  const migrationNoCredit = read('database/0008_remove_doni_credito.sql');
  const migrationNoDonoAlVolo = read('database/0009_remove_dono_al_volo_staff_legacy.sql');
  const db = read('db-manager.js');
  const containers = read('container-manager.js');
  const apiRuntime = read('api-server.js');

  assert.ok(api.includes("crossAuth.verifyRequest(req, 'URANUS')"), 'URANUS inbound deve essere HMAC');
  assert.ok(!api.includes("crossAuth.verifyRequest(req, 'ROG')"), 'ROG_TO_PHARAOH deve restare disabilitato');
  assert.ok(cross.includes("const SOURCE = 'URANUS_TO_PHARAOH'"));
  assert.ok(cross.includes('paymentWallet: payload.paymentWallet'));
  assert.ok(cross.includes('beneficiaryWallet: payload.beneficiaryWallet'));
  assert.ok(cross.includes('positionsCreated: payload.positionsExpected'));
  assert.ok(cross.includes("sourcePlatform: SOURCE"));
  assert.ok(cross.includes('maxPosizioni: 100'));

  assert.ok(outbound.includes("ROG: Object.freeze({ amount: 300, positions: 150 })"));
  assert.ok(outbound.includes("URANUS: Object.freeze({ amount: 200, positions: 10 })"));
  assert.ok(outbound.includes("GLOBAL_PAYOUT_SIGNER_LOCK = 'PHARAOH:PAYOUT:SIGNER'"));
  assert.ok(payout.includes("GLOBAL_PAYOUT_SIGNER_LOCK = 'PHARAOH:PAYOUT:SIGNER'"), 'Payout e cross devono condividere il lock nonce');
  assert.ok(outbound.includes("status IN ('PENDING','TRANSFER_SUBMITTING','FUNDS_CONFIRMED','NOTIFY_PENDING')"), 'Worker deve recuperare tx gia inviate e notifiche pendenti');
  assert.ok(outbound.includes("status='RECONCILIATION_REQUIRED'"), 'Ambiguita nonce deve fail-closed');
  assert.ok(outbound.includes("'X-Platform-Origin': 'PHARAOH'"));
  assert.ok(outbound.includes('CROSS_OUTBOUND_SENDER_MISMATCH'), 'Receipt outbound deve provare receipt.from=Cassa PHARAOH');
  assert.ok(outbound.includes('CROSS_OUTBOUND_SPEC_MISMATCH'), 'Worker deve rifiutare righe DB con importi/posizioni alterati');
  assert.ok(api.includes("app.post('/api/admin/post-commit/recover'"), 'Recovery post-COMMIT deve essere esposto via admin');
  assert.ok(outbound.includes('wallet_beneficiario: String(row.beneficiary_wallet).toLowerCase()'));

  assert.ok(flow.includes('crossOutbound.scheduleRhaExit({'));
  assert.ok(flow.includes('beneficiaryWallet: faraoneWallet'));
  assert.ok(flow.includes('rhaEventKey: eventKey'));

  const l3 = functions.slice(functions.indexOf('async function rilasciaFunzioniL3'), functions.indexOf('async function rilasciaFunzioniL4'));
  const l4 = functions.slice(functions.indexOf('async function rilasciaFunzioniL4'), functions.indexOf('async function rilasciaFunzioniL5'));
  const l5 = functions.slice(functions.indexOf('async function rilasciaFunzioniL5'), functions.indexOf('// DISTRIBUZIONE CREDITI'));
  assert.ok(!l3.includes('accantonaDoniCredito'), 'L3 non deve piu creare crediti');
  assert.ok(!l3.includes('staffOmaggiReservedUsdc'));
  assert.ok(l3.includes('rogDualPositions'));
  assert.ok(l3.includes('uranusDualPositions'));
  assert.ok(l3.includes('repayable: false'));
  assert.ok(!l4.includes('accantonaDoniCredito'), 'THOT L4 non deve piu creare doni a credito');
  assert.ok(l4.includes('createThotExitAllocation'), 'THOT L4 deve registrare allocazione idempotente');
  assert.ok(l4.includes("source: 'THOT_REENTRY'"), 'THOT L4 deve materializzare rientri Entrata reali');
  assert.ok(!l5.includes('accantonaDoniCredito'), 'ISIDE L5 non deve piu creare doni a credito');
  assert.ok(l5.includes('createIsideExitAllocation'), 'ISIDE L5 deve registrare allocazione idempotente');
  assert.ok(l5.includes("source: 'ISIDE_REENTRY'"), 'ISIDE L5 deve materializzare 50 rientri Entrata reali');
  assert.ok(!rules.includes('RHA_STAFF_OMAGGI_RESERVED'));
  assert.ok(rules.includes('RHA_ROG_OUTBOUND: 300'));
  assert.ok(rules.includes('RHA_ROG_DUAL_POSITIONS: 150'));
  assert.ok(rules.includes('RHA_URANUS_OUTBOUND: 200'));
  assert.ok(rules.includes('RHA_URANUS_DUAL_POSITIONS: 10'));
  assert.ok(rules.includes('TRATTENUTA_PROGETTI_UMANITARI_L4: 500'));
  assert.ok(rules.includes("DESTINAZIONE_PROGETTI_UMANITARI_L4: 'PROGETTI_UMANITARI'"));
  assert.ok(rules.includes('TRATTENUTA_RIENTRI_ENTRATA_L4: 500'));
  assert.ok(rules.includes('NUM_RIENTRI_ENTRATA_L4: 5'));
  assert.ok(flow.includes('thotAllocation'));
  assert.ok(flow.includes('uscita.trattenutaProgettiUmanitari'));
  assert.ok(flow.includes('uscita.trattenutaRientriEntrata'));
  assert.ok(rules.includes('TRATTENUTA_RIENTRI_ENTRATA_L5: 5000'));
  assert.ok(rules.includes('NUM_RIENTRI_ENTRATA_L5: 50'));
  assert.ok(rules.includes('QUOTA_RICEVENTE_L5: 6000'));
  assert.ok(rules.includes('USCITA_L5_NETTO_BASE: 19000'));
  assert.ok(rules.includes('USCITA_L5_PAYOUT_TOTALE: 25000'));
  assert.ok(flow.includes('isideAllocation'));
  assert.ok(flow.includes('importo: uscita.payoutRicevente'));
  assert.ok(flow.includes('donoRiceventeUsdc: uscita.quotaRicevente'));
  assert.ok(migrationIside.includes('CREATE TABLE IF NOT EXISTS iside_exit_allocations'));
  assert.ok(migrationIside.includes('reentry_positions_expected = 50'));
  assert.ok(migrationIside.includes('receiver_gift_usdc = 6000'));
  assert.ok(migrationIside.includes('receiver_payout_usdc = 25000'));
  assert.ok(!migrationIside.includes('UPDATE iside_exit_allocations'), '0007 non deve riscrivere retroattivamente storico ISIDE');

  assert.ok(migration.includes("staff_omaggi_reserved_usdc NUMERIC(12,2) NOT NULL DEFAULT 200")); // legacy V1
  assert.ok(migrationRhaV2.includes("ALTER COLUMN staff_omaggi_reserved_usdc SET DEFAULT 0"));
  assert.ok(migrationRhaV2.includes("ALTER COLUMN rog_usdc SET DEFAULT 300"));
  assert.ok(migrationRhaV2.includes("ALTER COLUMN uranus_usdc SET DEFAULT 200"));
  assert.ok(migrationRhaV2.includes("amount_usdc = 300 AND positions_expected = 150"));
  assert.ok(migrationRhaV2.includes("amount_usdc = 200 AND positions_expected = 10"));
  assert.ok(migrationThot.includes('CREATE TABLE IF NOT EXISTS thot_exit_allocations'));
  assert.ok(migrationThot.includes('humanitarian_reserved_usdc NUMERIC(12,2) NOT NULL'));
  assert.ok(migrationThot.includes("humanitarian_destination = 'PROGETTI_UMANITARI'"));
  assert.ok(migrationThot.includes('reentry_positions_expected = 5'));
  assert.ok(!migrationThot.includes('UPDATE thot_exit_allocations'), '0006 non deve riscrivere retroattivamente storico THOT');
  assert.ok(migration.includes('chk_direct_sessions_rog_exact_2'));
  assert.ok(migration.includes('chk_direct_sessions_pharaoh_exact_100'));
  assert.ok(migration.includes('chk_cross_entry_amount_positions'));
  assert.ok(migration.includes('chk_cross_outbound_protocol_spec'));
  assert.ok(migration.includes("rog_usdc NUMERIC(12,2) NOT NULL DEFAULT 200")); // legacy V1
  assert.ok(migration.includes("uranus_usdc NUMERIC(12,2) NOT NULL DEFAULT 100")); // legacy V1
  assert.ok(migration.includes("repayable BOOLEAN NOT NULL DEFAULT FALSE"));
  assert.ok(migration.includes("WHERE rilasciato_al_livello = 3"));
  assert.ok(migration.includes("WHEN stato_restituzione = 'RESTITUITO' THEN 'RESTITUITO'"), 'La migration storica 0004 resta immutata');
  assert.ok(migration.includes("ELSE 'NON_DOVUTO'"));
  assert.ok(migrationNoCredit.includes('DROP TABLE IF EXISTS doni_credito'));
  assert.ok(migrationNoCredit.includes("CHECK (tipo IN ('5','5.1','5.2'))"));
  assert.ok(migrationNoDonoAlVolo.includes("CHECK (tipo IN ('5','5.2'))"));
  assert.ok(migrationNoDonoAlVolo.includes('DROP COLUMN IF EXISTS staff_omaggi_reserved_usdc'));
  assert.ok(migrationNoDonoAlVolo.includes('DROP COLUMN IF EXISTS staff_omaggi_status'));
  assert.ok(!db.includes('doni_credito'), 'Runtime DB manager non deve ricreare doni_credito');
  assert.ok(!containers.includes('5.3'), 'Runtime container manager non deve esporre 5.3');
  assert.ok(!containers.includes('5.1'), 'Runtime container manager non deve esporre 5.1');
  assert.ok(!apiRuntime.includes('/api/lista-attesa'), 'API lista attesa deve essere rimossa');
  assert.ok(!apiRuntime.includes('distribuisciCrediti'), 'API non deve assegnare crediti');
}

testHmac();
testUranusPayload();
staticInvariants();
console.log('PASS URANUS_TO_PHARAOH: HMAC + treasury binding + amount->positions + beneficiary separation');
console.log('PASS RHA V2: ogni uscita primaria/secondaria -> 300 ROG/150 dual + 200 URANUS/10 dual, beneficiario = ricevente RHA');
console.log('PASS safety: shared signer nonce lock + anti-resend reconciliation + ROG_TO_PHARAOH disabled');

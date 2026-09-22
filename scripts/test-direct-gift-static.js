'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function main() {
  const api = read('api-server.js');
  const direct = read('donation-flow-manager.js');
  const directMgr = read('direct-donation-manager.js');
  const directSession = read('direct-donation-session-manager.js');
  const directMigration = read('database/0002_direct_donation_sessions.sql');
  const registry = read('pharaoh-registry-manager.js');
  const gift = read('gift-flow-manager.js');
  const giftSession = read('gift-session-manager.js');
  const rogGift = read('rog-gift-manager.js');
  const verifiedEntry = read('verified-entry-manager.js');
  const giftMigration = read('database/0003_gift_sessions.sql');
  const env = read('.env.example');

  for (const route of [
    "app.post('/api/donazione/diretta/session'",
    "app.get('/api/donazione/diretta/session/:sessionRef'",
    "app.post('/api/donazione/diretta/rog/payment'",
    "app.post('/api/donazione/diretta/rog/register'",
    "app.post('/api/donazione/diretta/rog/confirm'",
    "app.post('/api/donazione/entrata/wallet'"
  ]) assert.ok(api.includes(route), `DIRECT endpoint mancante: ${route}`);
  assert.match(api, /processaDonoEntrataWallet\(\{\s*wallet,\s*txHash,\s*sessionRef,\s*nome\s*\}\)/s);
  assert.ok(!api.slice(api.indexOf("app.post('/api/donazione/entrata/wallet'"), api.indexOf("// CARTA REGALO")).includes('numeroPosizioni'), 'DIRECT API non deve accettare numeroPosizioni');

  assert.ok(directMgr.includes('await communityManager.assertCommunityMember(w)'), 'DIRECT deve verificare Community ROG server-side');
  assert.ok(directMgr.includes('verifyRogUsdcTransfer'), 'DIRECT deve provare Transfer ROG');
  assert.ok(directMgr.includes('verifyRogRegistration'), 'DIRECT deve provare registerDonation ROG');
  assert.ok(directMgr.includes('recordRogPaymentConfirmed'), 'DIRECT deve persistere il gate economico dei 2 USDC');
  assert.ok(directMgr.includes('recordRogRegistrationCandidate'), 'DIRECT deve persistere la registerDonation candidate senza bloccare il gate');
  assert.ok(directMgr.includes('processRogFulfillmentPending'), 'DIRECT deve completare ROG in background');
  assert.ok(directMgr.includes('finalizeRogDonation'), 'Worker DIRECT deve verificare il completamento ROG');
  assert.ok(api.includes("app.post('/api/donazione/diretta/rog/external/verify'"), 'Endpoint external/verify mancante');
  assert.ok(directMgr.includes('verifyExternalRogReturn'), 'Verifica server-side del ritorno ROG mancante');
  assert.ok(directMgr.includes("row.rog_fulfillment_status !== 'COMPLETED'"), 'Gate PHARAOH deve richiedere fulfillment ROG COMPLETED');
  assert.ok(directMgr.includes('row.rog_human_position'), 'Gate PHARAOH deve richiedere posizione HUMAN ROG persistita');
  assert.ok(directSession.includes('if (amount !== 2)'), 'DIRECT ROG deve essere esattamente 2 USDC');
  assert.match(directMigration, /rog_amount_usdc[^\n]+CHECK \(rog_amount_usdc = 2\)/);
  const asyncMigration = read('database/0015_direct_rog_async_gate.sql');
  assert.ok(asyncMigration.includes('ROG_PAYMENT_CONFIRMED'), 'Migration gate asincrono mancante');
  assert.ok(asyncMigration.includes('rog_human_position'), 'Persistenza posizione HUMAN ROG mancante');
  assert.ok(asyncMigration.includes('rog_registration_candidate_tx_hash'), 'Recovery durevole registerDonation candidate mancante');
  assert.ok(!directSession.includes('rog_piletta_position'), 'PILEtTA non deve essere esposta nella sessione DIRECT');
  assert.ok(directSession.includes('rogHumanPosition'), 'Sessione pubblica deve esporre solo posizione HUMAN ROG');
  assert.ok(api.includes('rogRegisterTxHash = req.body.rogRegisterTxHash ?'), 'Gate payment deve accettare candidate register opzionale senza bloccare');

  assert.ok(direct.includes('maxPosizioni: 1'), 'DIRECT deve bloccare una seconda posizione nella stessa tx');
  assert.ok(direct.includes('n !== 1'), 'DIRECT exact-one guard mancante');
  assert.ok(direct.includes("error.code = 'DIRECT_DONATION_EXACT_ENTRY_REQUIRED'"), 'DIRECT exact amount error mancante');
  assert.ok(direct.includes('pharaohRegistry.registerDirectIncoming'), 'DIRECT deve registrare il solo movimento 100 USDC verso Cassa PHARAOH');
  assert.ok(registry.includes('contract.registerIncoming('), 'Registry incoming call mancante');
  assert.ok(!registry.includes('registerDonationSession'), 'Registry PHARAOH non deve registrare la coreografia ROG');
  assert.ok(direct.includes('tavolaId: tavola.id'), 'donazioni.tavola_id deve usare tavole.id');
  assert.ok(direct.includes("sourcePlatform: 'DIRECT'"), 'DIRECT source metadata mancante');
  assert.ok(direct.includes('positionsCreated: 1'), 'DIRECT deve persistere una sola posizione');
  assert.ok(direct.includes('sessionRef obbligatorio: il backend non consente bypass'), 'DIRECT deve impedire bypass del prerequisito ROG');

  for (const unique of [
    'uq_direct_sessions_rog_usdc_tx_lower', 'uq_direct_sessions_rog_register_tx_lower',
    'uq_direct_sessions_rog_donation_id', 'uq_direct_sessions_pharaoh_tx_lower',
    'uq_direct_sessions_registry_tx_lower'
  ]) assert.ok(directMigration.includes(unique), `DIRECT anti-replay mancante: ${unique}`);

  for (const route of [
    "app.post('/api/gift/create'", "app.post('/api/gift/:giftId/rog/external/verify'", "app.post('/api/gift/:giftId/rog/payment'",
    "app.post('/api/gift/:giftId/rog/register'", "app.post('/api/gift/:giftId/pharaoh/payment'",
    "app.get('/api/gift/:giftId'", "app.post('/api/gift/:giftId/community-access'",
    "app.get('/api/community/access/:wallet'"
  ]) assert.ok(api.includes(route), `Gift endpoint mancante: ${route}`);

  assert.ok(giftSession.includes('payment_wallet, beneficiary_wallet'), 'Gift deve separare payer e beneficiary');
  assert.ok(giftSession.includes('VALUES ($1, $2, $3, $4, NULL)'), 'Gift PHARAOH deve nascere senza importo ROG deciso');
  assert.ok(giftSession.includes('bindRogIdentity'), 'Gift deve legare beneficiario/importo solo dopo read-back ROG');
  assert.ok(rogGift.includes('const GIFT_ROG_MIN_AMOUNT_USDC = 2'), 'Gift ROG minimo 2 mancante');
  assert.ok(rogGift.includes('amount % 2 !== 0') || giftSession.includes('amount % 2 !== 0'), 'Gift ROG deve accettare solo multipli interi di 2');
  assert.ok(gift.includes('const GIFT_PHARAOH_AMOUNT_USDC = 100'), 'Gift PHARAOH exact 100 mancante');
  assert.ok(gift.includes("require('./pharaoh-registry-manager')"), 'Gift deve usare PharaohRegistry treasury');
  assert.ok(gift.includes('pharaohRegistry.registerGiftIncoming'), 'Gift deve registrare il solo pagamento 100 USDC verso Cassa PHARAOH');
  assert.ok(!rogGift.includes("require('./pharaoh-registry-manager')"), 'ROG Gift wrapper NON deve usare PharaohRegistry');
  assert.ok(gift.includes("'GIFT_BLOCK_ORDER_INVALID'"), 'Gift deve imporre ordine ROG -> PHARAOH');
  assert.ok(rogGift.includes('expectedGiftUnits'), 'Gift deve derivare RGX/HUMAN dall importo ROG');
  assert.ok(rogGift.includes('Number(completion.rgxMinted) !== units'), 'Gift deve verificare RGX = importo/2');
  assert.ok(rogGift.includes('count !== expected || list.length !== expected'), 'Gift deve verificare HUMAN = importo/2');
  assert.ok(verifiedEntry.includes("const ALLOWED_SOURCES = new Set(['GIFT'])"), 'Verified entry deve accettare solo Gift');
  assert.ok(verifiedEntry.includes('wallet: beneficiary'), 'Posizione Gift deve essere del beneficiario');
  assert.ok(verifiedEntry.includes('donorWallet: payer'), 'Donazione Gift deve conservare il pagatore');
  assert.ok(verifiedEntry.includes('beneficiaryWallet: beneficiary'), 'Donazione Gift deve conservare il beneficiario');

  const paymentSegment = gift.slice(gift.indexOf('async function processPharaohPayment'), gift.indexOf('async function getCommunityAccess'));
  assert.ok(!paymentSegment.includes('rogCommunity.'), 'Community beneficiario non deve essere gate per la posizione Gift');
  assert.ok(paymentSegment.includes('requireCompleted: true'), 'Gift deve fare read-back ROG COMPLETED prima di creare valore');

  for (const unique of [
    'uq_gift_sessions_rog_usdc_tx_lower', 'uq_gift_sessions_rog_register_tx_lower',
    'uq_gift_sessions_rog_donation_id', 'uq_gift_sessions_pharaoh_tx_lower',
    'uq_donazioni_source_event'
  ]) assert.ok(giftMigration.includes(unique), `Gift anti-replay mancante: ${unique}`);

  assert.ok(env.includes('USDC_CONTRACT_ADDRESS=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'), 'Deve essere configurato Circle USDC nativo Polygon');
  assert.ok(env.includes('PHARAOH_MAX_DIRECT_POSITIONS=1'), 'Env DIRECT max positions deve essere 1');

  console.log('PASS DIRECT: 2 USDC verificati non bastano; PHARAOH si sblocca solo dopo ROG COMPLETED + posizione HUMAN verificata');
  console.log('PASS GIFT: payer/beneficiary separati + ROG dinamico multiplo di 2 + PHARAOH 100 + Treasury Registry + beneficiary active');
}

main();

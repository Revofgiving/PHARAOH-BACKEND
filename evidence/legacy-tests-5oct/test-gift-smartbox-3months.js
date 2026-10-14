
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT,p),'utf8');
function main(){
  const flow=read('gift-flow-manager.js');
  const session=read('gift-session-manager.js');
  const api=read('api-server.js');
  const rog=read('rog-gift-manager.js');
  const mig=read('database/0024_gift_smartbox_activation.sql');
  const env=read('.env.example');
  for (const route of [
    "app.post('/api/gift/smartbox/create'",
    "app.post('/api/gift/smartbox/:giftId/rog/payment'",
    "app.post('/api/gift/smartbox/:giftId/rog/register'",
    "app.post('/api/gift/smartbox/:giftId/pharaoh/payment'",
    "app.post('/api/gift/smartbox/redeem'",
    "app.post('/api/gift/smartbox/status'"
  ]) assert.ok(api.includes(route), `Smartbox endpoint mancante: ${route}`);
  assert.ok(flow.includes('purchaseTotalUsdc: 102'), 'Totale Carta Regalo deve essere 102 USDC');
  assert.ok(session.includes("crypto.createHash('sha256')"), 'Il codice regalo deve essere persistito solo come hash SHA-256');
  assert.ok(mig.includes("INTERVAL '3 months'"), 'Scadenza deve essere di 3 mesi di calendario');
  assert.ok(flow.includes('GIFT_BENEFICIARY_COMMUNITY_REQUIRED'), 'Community beneficiario deve essere obbligatoria prima del riscatto');
  assert.ok(flow.includes("activationSource: 'PURCHASER_FALLBACK'"), 'Fallback al regalante mancante');
  assert.ok(flow.includes('processExpiredSmartboxGifts'), 'Reconciler scadenze mancante');
  assert.ok(flow.includes('startSmartboxExpiryReconciler'), 'Avvio reconciler scadenze mancante');
  assert.ok(rog.includes('X-Pharaoh-Gift-Key'), 'Attivazione ROG deve essere server-to-server autenticata');
  assert.ok(env.includes('PHARAOH_GIFT_INTERNAL_KEY='), 'Chiave interna Gift mancante da env example');
  assert.ok(mig.includes('DROP CONSTRAINT IF EXISTS gift_distinct_wallets_check'), 'Fallback al regalante deve poter assegnare beneficiary=paymentWallet');
  console.log('PASS GIFT SMARTBOX: 102 USDC prepagati + codice hash + Community entro 3 mesi + fallback automatico al regalante');
}
main();

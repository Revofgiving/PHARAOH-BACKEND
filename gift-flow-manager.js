'use strict';

const giftSessions = require('./gift-session-manager');
const rogGift = require('./rog-gift-manager');
const rogCommunity = require('./rog-community-manager');
const verifier = require('./blockchain-verifier');
const verifiedEntry = require('./verified-entry-manager');
const pharaohRegistry = require('./pharaoh-registry-manager');

const GIFT_ROG_AMOUNT_USDC = 2;
const GIFT_PHARAOH_AMOUNT_USDC = 100;
function makeError(message, code, retryable = false) { const error = new Error(message); error.code = code; error.retryable = retryable; return error; }
function isAtLeast(row, status) { return giftSessions.statusAtLeast(row, status); }
function parseProofField(value, label) { if (value && typeof value === 'object') return value; if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch (_) {} } throw makeError(`Prova ${label} mancante o non valida`, 'GIFT_PROOF_INCOMPLETE'); }
function assertBlockchainOrder(row, pharaohProof) { const rogTransfer = parseProofField(row.rog_transfer_proof, 'ROG Transfer'); const transferBlock = Number(rogTransfer.blockNumber); const pharaohBlock = Number(pharaohProof?.blockNumber); if (![transferBlock, pharaohBlock].every(n => Number.isInteger(n) && n > 0)) throw makeError('Prove blockchain prive di blockNumber verificabile', 'GIFT_PROOF_INCOMPLETE'); if (pharaohBlock <= transferBlock) throw makeError('La transazione PHARAOH della Carta Regalo deve essere successiva al pagamento ROG', 'GIFT_BLOCK_ORDER_INVALID'); return { transferBlock, pharaohBlock }; }
function publicGift(row, extra = {}) { return { success: true, gift: giftSessions.publicSession(row), ...extra }; }

async function createGift({ giftId = null, paymentWallet, beneficiaryWallet = null, giftMessage = null }) {
  const payer = giftSessions.normalizeWallet(paymentWallet, 'paymentWallet');
  const beneficiary = beneficiaryWallet == null || String(beneficiaryWallet).trim() === '' ? null : giftSessions.normalizeWallet(beneficiaryWallet, 'beneficiaryWallet');
  if (beneficiary && payer === beneficiary) throw makeError('Carta Regalo richiede pagatore e beneficiario distinti', 'GIFT_WALLETS_MUST_DIFFER');
  const row = await giftSessions.createSession({ giftId, paymentWallet: payer, beneficiaryWallet: beneficiary, giftMessage });
  giftSessions.assertActive(row);
  return publicGift(row, { created: true });
}

async function getGift(giftId) { const row = await giftSessions.requireSession(giftId); return publicGift(row); }
async function requireBoundRogIdentity(row) {
  if (!row.beneficiary_wallet) throw makeError('Beneficiario ROG non ancora verificato', 'GIFT_ROG_IDENTITY_REQUIRED');
  if (row.rog_amount_usdc == null) throw makeError('Importo ROG non ancora verificato', 'GIFT_ROG_IDENTITY_REQUIRED');
  return {
    payer: String(row.payment_wallet).toLowerCase(),
    beneficiary: String(row.beneficiary_wallet).toLowerCase(),
    amount: giftSessions.normalizeGiftAmount(row.rog_amount_usdc)
  };
}

async function confirmRogPayment({ giftId, paymentWallet, rogUsdcTxHash }) {
  const id = giftSessions.normalizeGiftId(giftId);
  return giftSessions.withGiftLock(id, async () => {
    let row = giftSessions.assertActive(await giftSessions.requireSession(id, paymentWallet));
    const payer = String(row.payment_wallet).toLowerCase();

    // Il beneficiario viene scelto su ROG. PHARAOH lo legge e lo congela nella
    // sessione, senza richiedere che sia gia' registrato nella Community.
    if (!row.beneficiary_wallet || row.rog_amount_usdc == null) {
      const identity = await rogGift.readGiftIdentity({ giftId: id, paymentWallet: payer });
      if (Number(identity.rogAmountUsdc) !== GIFT_ROG_AMOUNT_USDC) {
        throw makeError('La Carta Regalo PHARAOH richiede esattamente 2 USDC su ROG', 'GIFT_ROG_AMOUNT_INVALID');
      }
      row = await giftSessions.bindRogIdentity({
        giftId: id,
        paymentWallet: payer,
        beneficiaryWallet: identity.beneficiaryWallet,
        rogAmountUsdc: GIFT_ROG_AMOUNT_USDC
      });
    }

    const { beneficiary, amount } = await requireBoundRogIdentity(row);
    if (amount !== GIFT_ROG_AMOUNT_USDC) {
      throw makeError('La Carta Regalo PHARAOH richiede esattamente 2 USDC su ROG', 'GIFT_ROG_AMOUNT_INVALID');
    }
    const tx = giftSessions.normalizeHash(rogUsdcTxHash, 'rogUsdcTxHash');
    if (row.rog_usdc_tx_hash && String(row.rog_usdc_tx_hash).toLowerCase() !== tx) throw makeError('Carta Regalo gia associata a un pagamento ROG differente', 'GIFT_PROOF_CONFLICT');
    if (isAtLeast(row, 'ROG_PAYMENT_CONFIRMED')) {
      return publicGift(row, { idempotent: true, paymentConfirmed: true, canProceedToPharaoh: true });
    }
    try {
      const result = await rogGift.confirmRogPayment({ giftId: id, paymentWallet: payer, beneficiaryWallet: beneficiary, rogAmountUsdc: amount, rogUsdcTxHash: tx });
      row = await giftSessions.recordRogPayment({ giftId: id, paymentWallet: payer, txHash: tx, transferProof: result.transferProof });
      return publicGift(row, { paymentConfirmed: true, canProceedToPharaoh: true, rogGift: result.gift });
    } catch (error) { await giftSessions.recordError(id, error); throw error; }
  });
}

async function confirmRogRegistration({ giftId, paymentWallet, rogRegisterTxHash, rogDonationId }) {
  const id = giftSessions.normalizeGiftId(giftId);
  const result = await giftSessions.withGiftLock(id, async () => {
    let row = giftSessions.assertActive(await giftSessions.requireSession(id, paymentWallet));
    const { payer, beneficiary, amount } = await requireBoundRogIdentity(row);
    if (!row.rog_usdc_tx_hash || !isAtLeast(row, 'ROG_PAYMENT_CONFIRMED')) {
      throw makeError('Prima confermare il pagamento ROG', 'GIFT_ROG_PAYMENT_REQUIRED');
    }
    const registerTx = giftSessions.normalizeHash(rogRegisterTxHash, 'rogRegisterTxHash');
    const donationId = String(rogDonationId || '').trim();
    if (!/^\d+$/.test(donationId) || BigInt(donationId) <= 0n) {
      throw makeError('rogDonationId numerico obbligatorio', 'GIFT_ROG_DONATION_ID_INVALID');
    }
    if (row.rog_register_tx_hash && String(row.rog_register_tx_hash).toLowerCase() !== registerTx) {
      throw makeError('Carta Regalo gia associata a registerDonation ROG differente', 'GIFT_PROOF_CONFLICT');
    }
    if (row.rog_donation_id && String(row.rog_donation_id) !== donationId) {
      throw makeError('Carta Regalo gia associata a donationId ROG differente', 'GIFT_PROOF_CONFLICT');
    }
    try {
      if (!isAtLeast(row, 'ROG_REGISTERED')) {
        const registration = await rogGift.confirmRogRegistration({
          giftId: id,
          paymentWallet: payer,
          beneficiaryWallet: beneficiary,
          rogAmountUsdc: amount,
          rogUsdcTxHash: row.rog_usdc_tx_hash,
          rogRegisterTxHash: registerTx,
          rogDonationId: donationId
        });
        row = await giftSessions.recordRogRegistration({
          giftId: id,
          paymentWallet: payer,
          registerTxHash: registerTx,
          donationId,
          registrationProof: registration.registrationProof
        });
      }
      return publicGift(row, {
        idempotent: isAtLeast(row, 'ROG_COMPLETED'),
        rogFulfillmentQueued: !isAtLeast(row, 'ROG_COMPLETED')
      });
    } catch (error) {
      await giftSessions.recordError(id, error);
      throw error;
    }
  });

  // Il completamento HUMAN/PILETTA resta sempre asincrono rispetto al donatore.
  if (result.rogFulfillmentQueued) {
    setImmediate(() => { processRogGiftFulfillment(id).catch(() => null); });
  }
  return result;
}

async function processRogGiftFulfillment(giftId) {
  const id = giftSessions.normalizeGiftId(giftId);
  return giftSessions.withGiftLock(id, async () => {
    let row = giftSessions.assertActive(await giftSessions.requireSession(id));
    if (!isAtLeast(row, 'ROG_REGISTERED') || !row.rog_register_tx_hash || !row.rog_donation_id) {
      return { success: false, deferred: true, reason: 'GIFT_ROG_REGISTRATION_NOT_AVAILABLE' };
    }
    if (row.rog_result || row.rog_completed_at) return { success: true, idempotent: true, gift: giftSessions.publicSession(row) };
    const { payer, beneficiary, amount } = await requireBoundRogIdentity(row);
    try {
      const completion = await rogGift.completeRogGift({ giftId: id, paymentWallet: payer, beneficiaryWallet: beneficiary, rogAmountUsdc: amount, rogUsdcTxHash: row.rog_usdc_tx_hash, rogRegisterTxHash: row.rog_register_tx_hash, rogDonationId: row.rog_donation_id });
      row = await giftSessions.recordRogCompleted({ giftId: id, paymentWallet: payer, rogResult: completion, beneficiaryWasCommunityMember: typeof completion.gift?.beneficiaryWasCommunityMember === 'boolean' ? completion.gift.beneficiaryWasCommunityMember : null });
      return { success: true, gift: giftSessions.publicSession(row), rogCompletion: completion.completion };
    } catch (error) {
      await giftSessions.recordError(id, error);
      return { success: false, retryable: true, code: error.code || 'GIFT_ROG_COMPLETION_PENDING', error: String(error.message || error) };
    }
  });
}

async function verifyExternalRogGift({ giftId, paymentWallet, rogUsdcTxHash, rogRegisterTxHash = null, rogDonationId = null }) {
  const id = giftSessions.normalizeGiftId(giftId);

  // Il solo gate economico e' il pagamento ROG verificato. Il beneficiario
  // viene letto da ROG, ma la sua iscrizione Community NON e' richiesta qui.
  const payment = await confirmRogPayment({ giftId: id, paymentWallet, rogUsdcTxHash });

  // Se il frontend ROG restituisce anche registerDonation, la verifichiamo e
  // avviamo il completamento asincrono senza bloccare i 100 USDC PHARAOH.
  if (rogRegisterTxHash && rogDonationId) {
    await confirmRogRegistration({ giftId: id, paymentWallet, rogRegisterTxHash, rogDonationId });
    setImmediate(() => { processRogGiftFulfillment(id).catch(() => null); });
  }

  const row = await giftSessions.requireSession(id, paymentWallet);
  return publicGift(row, {
    verified: true,
    paymentConfirmed: true,
    canProceedToPharaoh: true,
    rogFulfillmentPending: !row.rog_result,
    payment
  });
}

async function processPharaohPayment({ giftId, paymentWallet, pharaohTxHash, beneficiaryName = null }) {
  const id = giftSessions.normalizeGiftId(giftId);
  return giftSessions.withGiftLock(id, async () => {
    let row = giftSessions.assertActive(await giftSessions.requireSession(id, paymentWallet));
    const payer = String(row.payment_wallet).toLowerCase();
    if (!row.beneficiary_wallet || row.rog_amount_usdc == null) throw makeError('Identita ROG della Carta Regalo non ancora verificata', 'GIFT_ROG_IDENTITY_REQUIRED');
    const beneficiary = String(row.beneficiary_wallet).toLowerCase();
    const rogAmountUsdc = giftSessions.normalizeGiftAmount(row.rog_amount_usdc);
    if (rogAmountUsdc !== GIFT_ROG_AMOUNT_USDC) throw makeError('La Carta Regalo PHARAOH richiede esattamente 2 USDC su ROG', 'GIFT_ROG_AMOUNT_INVALID');
    if (row.status === 'POSITION_ASSIGNED') {
      return publicGift(row, { idempotent: true, result: row.position_result || null });
    }
    if (!isAtLeast(row, 'ROG_COMPLETED') || !row.rog_usdc_tx_hash || !row.rog_transfer_proof || !row.rog_result) {
      throw makeError('Prima dei 100 USDC PHARAOH ROG deve risultare COMPLETED con HUMAN verificata', 'GIFT_ROG_COMPLETION_REQUIRED', true);
    }
    const tx = giftSessions.normalizeHash(pharaohTxHash, 'pharaohTxHash');
    if (row.pharaoh_tx_hash && String(row.pharaoh_tx_hash).toLowerCase() !== tx) {
      throw makeError('Carta Regalo gia associata a una transazione PHARAOH differente', 'GIFT_PROOF_CONFLICT');
    }
    try {
      let proof = row.pharaoh_proof || null;
      if (!isAtLeast(row, 'PHARAOH_VERIFIED')) {
        const check = await verifier.verificaDonazione({
          txHash: tx,
          walletMittente: payer,
          importoMinimo: GIFT_PHARAOH_AMOUNT_USDC,
          maxPosizioni: 1
        });
        if (check.numeroPosizioni !== 1 || Number(check.importoEffettivo) !== GIFT_PHARAOH_AMOUNT_USDC) {
          throw makeError('Carta Regalo PHARAOH richiede esattamente 100 USDC', 'GIFT_PHARAOH_AMOUNT_INVALID');
        }
        proof = check.proof;
        assertBlockchainOrder(row, proof);
        row = await giftSessions.recordPharaohVerified({
          giftId: id,
          paymentWallet: payer,
          txHash: check.txHash,
          amountUsdc: check.importoEffettivo,
          proof
        });
      } else {
        if (String(row.pharaoh_tx_hash).toLowerCase() !== tx) {
          throw makeError('Carta Regalo gia associata a una transazione PHARAOH differente', 'GIFT_PROOF_CONFLICT');
        }
        proof = parseProofField(row.pharaoh_proof, 'PHARAOH');
        assertBlockchainOrder(row, proof);
      }

      // La posizione PHARAOH appartiene al beneficiario, mentre il wallet
      // collegato/pagatore resta il donatore. Nessun gate Community sul beneficiario.
      if (!row.registry_confirmed_at || row.registry_session_id == null) {
        const registryResult = await pharaohRegistry.registerGiftIncoming({
          gift: row,
          onSubmitted: async (registryTxHash) => {
            row = await giftSessions.recordRegistrySubmitted({ giftId: id, txHash: registryTxHash });
          }
        });
        row = await giftSessions.recordRegistryConfirmed({
          giftId: id,
          txHash: registryResult.txHash,
          txId: registryResult.txId,
          blockNumber: registryResult.blockNumber
        });
      }

      const result = await verifiedEntry.assignOneVerifiedEntry({
        paymentWallet: payer,
        beneficiaryWallet: beneficiary,
        txHash: tx,
        amountUsdc: GIFT_PHARAOH_AMOUNT_USDC,
        blockchainProof: proof,
        sourcePlatform: 'GIFT',
        sourceEventKey: id,
        beneficiaryName,
        atomicComplete: async (client, coreResult) => {
          await giftSessions.markPositionAssigned({ giftId: id, result: coreResult }, client);
        }
      });
      const completed = await giftSessions.requireSession(id, payer);

      // Best effort: ROG continua in parallelo anche se PHARAOH e' gia' concluso.
      setImmediate(() => { processRogGiftFulfillment(id).catch(() => null); });
      return publicGift(completed, { result, rogFulfillmentPending: !completed.rog_result });
    } catch (error) {
      await giftSessions.recordError(id, error);
      throw error;
    }
  });
}



// ================================================================
// CARTA REGALO SMARTBOX - 102 USDC prepagati, Community entro 3 mesi
// ================================================================
async function createSmartboxGift({ paymentWallet, giftMessage = null }) {
  const payer = giftSessions.normalizeWallet(paymentWallet, 'paymentWallet');
  const code = giftSessions.generateGiftCode();
  const row = await giftSessions.createSession({ paymentWallet: payer, beneficiaryWallet: null, giftMessage });
  await giftSessions.setGiftCode({ giftId: row.gift_id, code });
  try { await rogGift.createSmartboxIntent({ giftId: row.gift_id, paymentWallet: payer, rogAmountUsdc: GIFT_ROG_AMOUNT_USDC, giftMessage }); }
  catch (error) { await giftSessions.recordError(row.gift_id, error); throw error; }
  const current = await giftSessions.requireSession(row.gift_id, payer);
  const response = publicGift(current, { created: true, giftCode: code, purchaseTotalUsdc: 102 });
  response.gift.giftCode = code; // mostrato al regalante; nel DB resta solo SHA-256
  return response;
}

async function confirmSmartboxRogPayment({ giftId, paymentWallet, rogUsdcTxHash }) {
  const id = giftSessions.normalizeGiftId(giftId);
  return giftSessions.withGiftLock(id, async () => {
    let row = giftSessions.assertActive(await giftSessions.requireSession(id, paymentWallet));
    const payer = String(row.payment_wallet).toLowerCase();
    if (row.beneficiary_wallet) throw makeError('Smartbox gia associata a un beneficiario', 'GIFT_ALREADY_ACTIVATED');
    if (isAtLeast(row, 'ROG_PAYMENT_CONFIRMED')) return publicGift(row, { idempotent: true });
    const tx = giftSessions.normalizeHash(rogUsdcTxHash, 'rogUsdcTxHash');
    const result = await rogGift.confirmSmartboxRogPayment({ giftId: id, paymentWallet: payer, rogAmountUsdc: 2, rogUsdcTxHash: tx });
    row = await giftSessions.recordRogPayment({ giftId: id, paymentWallet: payer, txHash: tx, transferProof: result.transferProof });
    return publicGift(row, { paymentConfirmed: true });
  });
}

async function confirmSmartboxRogRegistration({ giftId, paymentWallet, rogRegisterTxHash, rogDonationId }) {
  const id = giftSessions.normalizeGiftId(giftId);
  return giftSessions.withGiftLock(id, async () => {
    let row = giftSessions.assertActive(await giftSessions.requireSession(id, paymentWallet));
    const payer = String(row.payment_wallet).toLowerCase();
    if (!isAtLeast(row, 'ROG_PAYMENT_CONFIRMED') || !row.rog_usdc_tx_hash) throw makeError('Prima confermare i 2 USDC ROG', 'GIFT_ROG_PAYMENT_REQUIRED');
    const result = await rogGift.confirmSmartboxRogRegistration({ giftId: id, paymentWallet: payer, rogAmountUsdc: 2, rogUsdcTxHash: row.rog_usdc_tx_hash, rogRegisterTxHash, rogDonationId });
    row = await giftSessions.recordRogRegistration({ giftId: id, paymentWallet: payer, registerTxHash: rogRegisterTxHash, donationId: String(rogDonationId), registrationProof: result.registrationProof });
    return publicGift(row, { rogRegistered: true });
  });
}

async function confirmSmartboxPharaohPayment({ giftId, paymentWallet, pharaohTxHash }) {
  const id = giftSessions.normalizeGiftId(giftId);
  return giftSessions.withGiftLock(id, async () => {
    let row = giftSessions.assertActive(await giftSessions.requireSession(id, paymentWallet));
    const payer = String(row.payment_wallet).toLowerCase();
    if (!isAtLeast(row, 'ROG_REGISTERED') || !row.rog_donation_id || !row.rog_register_tx_hash) throw makeError('Prima completare la registrazione on-chain ROG del regalo', 'GIFT_ROG_REGISTRATION_REQUIRED');
    if (row.beneficiary_wallet) throw makeError('Smartbox gia attivata', 'GIFT_ALREADY_ACTIVATED');
    const tx = giftSessions.normalizeHash(pharaohTxHash, 'pharaohTxHash');
    if (!isAtLeast(row, 'PHARAOH_VERIFIED')) {
      const check = await verifier.verificaDonazione({ txHash: tx, walletMittente: payer, importoMinimo: 100, maxPosizioni: 1 });
      if (check.numeroPosizioni !== 1 || Number(check.importoEffettivo) !== 100) throw makeError('Carta Regalo PHARAOH richiede esattamente 100 USDC', 'GIFT_PHARAOH_AMOUNT_INVALID');
      assertBlockchainOrder(row, check.proof);
      row = await giftSessions.recordPharaohVerified({ giftId: id, paymentWallet: payer, txHash: check.txHash, amountUsdc: 100, proof: check.proof });
    }
    row = await giftSessions.markSmartboxPaid(id);
    let activationWindowSynced = false;
    try { await rogGift.setSmartboxActivationWindow({ giftId: id, expiresAt: row.activation_expires_at }); activationWindowSynced = true; }
    catch (error) { await giftSessions.recordError(id, error); }
    row = await giftSessions.requireSession(id, payer);
    return publicGift(row, { paid: true, activationReady: true, activationWindowSynced, purchaseTotalUsdc: 102, expiresAt: row.activation_expires_at });
  });
}

function assertNotExpired(row) {
  const expiresAt = row?.activation_expires_at ? new Date(row.activation_expires_at).getTime() : 0;
  if (!expiresAt) throw makeError('Scadenza Carta Regalo non disponibile', 'GIFT_EXPIRY_NOT_READY', true);
  if (Date.now() >= expiresAt) throw makeError('Carta Regalo scaduta: la posizione viene assegnata automaticamente al regalante', 'GIFT_EXPIRED');
  return expiresAt;
}

async function getSmartboxByCode({ giftCode }) {
  const row = await giftSessions.getSessionByGiftCode(giftCode);
  if (!row) throw makeError('Codice Carta Regalo non trovato', 'GIFT_CODE_NOT_FOUND');
  const expiresAtMs = row.activation_expires_at ? new Date(row.activation_expires_at).getTime() : 0;
  return publicGift(row, {
    activationReady: row.status === 'PAID_AWAITING_ACTIVATION' && (!expiresAtMs || Date.now() < expiresAtMs),
    expired: Boolean(expiresAtMs && Date.now() >= expiresAtMs && row.status !== 'POSITION_ASSIGNED'),
    redeemed: row.status === 'POSITION_ASSIGNED'
  });
}

async function completeSmartboxAssignment({ giftId, beneficiaryWallet, beneficiaryName = null, activationSource }) {
  const id = giftSessions.normalizeGiftId(giftId);
  const beneficiary = giftSessions.normalizeWallet(beneficiaryWallet, 'beneficiaryWallet');
  const mode = String(activationSource || '').toUpperCase();
  if (!['BENEFICIARY','PURCHASER_FALLBACK'].includes(mode)) throw makeError('Modalita attivazione non valida', 'GIFT_ACTIVATION_MODE_INVALID');
  return giftSessions.withGiftLock(id, async () => {
    let row = giftSessions.assertActive(await giftSessions.requireSession(id));
    const payer = String(row.payment_wallet).toLowerCase();
    if (row.status === 'POSITION_ASSIGNED') {
      if (String(row.beneficiary_wallet || '').toLowerCase() !== beneficiary) throw makeError('Carta Regalo gia assegnata', 'GIFT_ALREADY_REDEEMED');
      return publicGift(row, { idempotent: true, redeemed: true, result: row.position_result || null });
    }
    if (!['PAID_AWAITING_ACTIVATION','ACTIVATING','ROG_COMPLETED'].includes(row.status)) throw makeError('Carta Regalo non pronta per l attivazione', 'GIFT_NOT_READY_FOR_ACTIVATION');
    if (mode === 'BENEFICIARY') {
      if (payer === beneficiary) throw makeError('Il regalante non puo riscattare anticipatamente la propria Carta Regalo', 'GIFT_SELF_REDEEM_BLOCKED');
      assertNotExpired(row);
      const community = await rogCommunity.getCommunityStatus(beneficiary);
      if (community?.registered !== true) throw makeError('Il beneficiario deve registrare personalmente il proprio wallet nella Community ROG prima di attivare il regalo', 'GIFT_BENEFICIARY_COMMUNITY_REQUIRED');
    } else {
      if (beneficiary !== payer) throw makeError('Il fallback scaduto puo essere assegnato solo al regalante', 'GIFT_FALLBACK_OWNER_MISMATCH');
      const expiresAt = row.activation_expires_at ? new Date(row.activation_expires_at).getTime() : 0;
      if (!expiresAt || Date.now() < expiresAt) throw makeError('Carta Regalo non ancora scaduta', 'GIFT_NOT_EXPIRED');
    }
    if (row.beneficiary_wallet && String(row.beneficiary_wallet).toLowerCase() !== beneficiary) throw makeError('Carta Regalo gia riservata a un altro beneficiario', 'GIFT_ALREADY_REDEEMED');

    try { await rogGift.setSmartboxActivationWindow({ giftId: id, expiresAt: row.activation_expires_at }); }
    catch (error) { throw makeError('Sincronizzazione scadenza Carta Regalo con ROG non riuscita', 'GIFT_ROG_EXPIRY_SYNC_FAILED', true); }

    row = await giftSessions.updateSession(id, {
      status: 'ACTIVATING', beneficiary_wallet: beneficiary,
      beneficiary_was_community_member: mode === 'BENEFICIARY' ? true : row.beneficiary_was_community_member,
      beneficiary_community_checked_at: mode === 'BENEFICIARY' ? new Date().toISOString() : row.beneficiary_community_checked_at,
      activated_at: row.activated_at || new Date().toISOString(), activation_source: mode,
      expired_at: mode === 'PURCHASER_FALLBACK' ? (row.expired_at || new Date().toISOString()) : row.expired_at
    });

    const rogCompletion = await rogGift.activateSmartboxRog({ giftId: id, beneficiaryWallet: beneficiary, activationMode: mode });
    row = await giftSessions.recordRogCompleted({ giftId: id, paymentWallet: payer, rogResult: rogCompletion, beneficiaryWasCommunityMember: mode === 'BENEFICIARY' ? true : null });
    const proof = parseProofField(row.pharaoh_proof, 'PHARAOH');
    if (!row.registry_confirmed_at || row.registry_session_id == null) {
      const registryResult = await pharaohRegistry.registerGiftIncoming({ gift: row, onSubmitted: async (registryTxHash) => { row = await giftSessions.recordRegistrySubmitted({ giftId: id, txHash: registryTxHash }); } });
      row = await giftSessions.recordRegistryConfirmed({ giftId: id, txHash: registryResult.txHash, txId: registryResult.txId, blockNumber: registryResult.blockNumber });
    }
    const result = await verifiedEntry.assignOneVerifiedEntry({
      paymentWallet: payer, beneficiaryWallet: beneficiary, txHash: row.pharaoh_tx_hash, amountUsdc: 100, blockchainProof: proof,
      sourcePlatform: 'GIFT', sourceEventKey: id, beneficiaryName,
      atomicComplete: async (client, coreResult) => {
        await giftSessions.markPositionAssigned({ giftId: id, result: coreResult }, client);
        if (mode === 'PURCHASER_FALLBACK') await giftSessions.updateSession(id, { fallback_assigned_at: new Date().toISOString() }, client);
      }
    });
    const completed = await giftSessions.requireSession(id);
    return publicGift(completed, { redeemed: true, fallback: mode === 'PURCHASER_FALLBACK', result, rogCompletion });
  });
}

async function redeemSmartboxGift({ giftCode, beneficiaryWallet, beneficiaryName = null }) {
  const beneficiary = giftSessions.normalizeWallet(beneficiaryWallet, 'beneficiaryWallet');
  const found = await giftSessions.getSessionByGiftCode(giftCode);
  if (!found) throw makeError('Codice Carta Regalo non trovato', 'GIFT_CODE_NOT_FOUND');
  if (found.status === 'POSITION_ASSIGNED') {
    if (String(found.beneficiary_wallet || '').toLowerCase() !== beneficiary) throw makeError('Carta Regalo gia utilizzata', 'GIFT_ALREADY_REDEEMED');
    return publicGift(found, { idempotent: true, redeemed: true, result: found.position_result || null });
  }
  assertNotExpired(found);
  return completeSmartboxAssignment({ giftId: found.gift_id, beneficiaryWallet: beneficiary, beneficiaryName, activationSource: 'BENEFICIARY' });
}

async function processExpiredSmartboxGifts(limit = 25) {
  const rows = await giftSessions.findExpiredSmartboxes(limit);
  const results = [];
  for (const row of rows) {
    try {
      const result = await completeSmartboxAssignment({ giftId: row.gift_id, beneficiaryWallet: row.payment_wallet, beneficiaryName: null, activationSource: 'PURCHASER_FALLBACK' });
      results.push({ giftId: row.gift_id, success: true, result });
    } catch (error) {
      await giftSessions.recordError(row.gift_id, error);
      results.push({ giftId: row.gift_id, success: false, code: error.code || 'GIFT_FALLBACK_FAILED', error: String(error.message || error) });
    }
  }
  return { success: true, checked: rows.length, results };
}

let smartboxExpiryTimer = null;
function startSmartboxExpiryReconciler() {
  if (String(process.env.GIFT_EXPIRY_RECONCILER_ENABLED || 'true').toLowerCase() !== 'true' || smartboxExpiryTimer) return;
  const intervalMs = Math.max(60000, Number(process.env.GIFT_EXPIRY_RECONCILER_INTERVAL_MS || 300000));
  const run = () => processExpiredSmartboxGifts(Number(process.env.GIFT_EXPIRY_RECONCILER_BATCH_LIMIT || 25)).catch((error) => console.error('[GIFT_EXPIRY_RECONCILER]', error.message || error));
  setTimeout(run, 15000);
  smartboxExpiryTimer = setInterval(run, intervalMs);
  if (typeof smartboxExpiryTimer.unref === 'function') smartboxExpiryTimer.unref();
}

async function getCommunityAccess(wallet) { const beneficiary = giftSessions.normalizeWallet(wallet, 'wallet'); const status = await rogCommunity.getCommunityStatus(beneficiary); return { success: true, wallet: beneficiary, accessAllowed: status?.registered === true, communityRegistered: status?.registered === true }; }
async function registerGiftCommunityAccess({ giftId, beneficiaryWallet }) { const row = await giftSessions.requireSession(giftId); const beneficiary = giftSessions.normalizeWallet(beneficiaryWallet, 'beneficiaryWallet'); if (!row.beneficiary_wallet || String(row.beneficiary_wallet).toLowerCase() !== beneficiary) throw makeError('Il wallet non e il beneficiario della Carta Regalo', 'GIFT_BENEFICIARY_MISMATCH'); const before = await rogCommunity.getCommunityStatus(beneficiary); if (before?.registered === true) return { success: true, wallet: beneficiary, accessAllowed: true, communityRegistered: true, idempotent: true }; const registered = await rogCommunity.registerCommunityWallet(beneficiary); if (registered?.registered !== true) throw makeError('Iscrizione Community ROG del beneficiario non verificata', 'GIFT_COMMUNITY_REGISTRATION_UNVERIFIED', true); const after = await rogCommunity.getCommunityStatus(beneficiary); if (after?.registered !== true) throw makeError('Read-back Community ROG del beneficiario non verificato', 'GIFT_COMMUNITY_REGISTRATION_UNVERIFIED', true); return { success: true, wallet: beneficiary, accessAllowed: true, communityRegistered: true }; }
module.exports = { createSmartboxGift, confirmSmartboxRogPayment, confirmSmartboxRogRegistration, confirmSmartboxPharaohPayment, getSmartboxByCode, redeemSmartboxGift, processExpiredSmartboxGifts, startSmartboxExpiryReconciler, GIFT_ROG_AMOUNT_USDC, GIFT_PHARAOH_AMOUNT_USDC, createGift, getGift, confirmRogPayment, confirmRogRegistration, verifyExternalRogGift, processRogGiftFulfillment, processPharaohPayment, getCommunityAccess, registerGiftCommunityAccess, _publicGift: publicGift, _assertBlockchainOrder: assertBlockchainOrder, _makeError: makeError };

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
    if (!isAtLeast(row, 'ROG_PAYMENT_CONFIRMED') || !row.rog_usdc_tx_hash || !row.rog_transfer_proof) {
      throw makeError('Prima dei 100 USDC PHARAOH deve essere verificato il pagamento di 2 USDC a ROG', 'GIFT_ROG_PAYMENT_REQUIRED', true);
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

async function getCommunityAccess(wallet) { const beneficiary = giftSessions.normalizeWallet(wallet, 'wallet'); const status = await rogCommunity.getCommunityStatus(beneficiary); return { success: true, wallet: beneficiary, accessAllowed: status?.registered === true, communityRegistered: status?.registered === true }; }
async function registerGiftCommunityAccess({ giftId, beneficiaryWallet }) { const row = await giftSessions.requireSession(giftId); const beneficiary = giftSessions.normalizeWallet(beneficiaryWallet, 'beneficiaryWallet'); if (!row.beneficiary_wallet || String(row.beneficiary_wallet).toLowerCase() !== beneficiary) throw makeError('Il wallet non e il beneficiario della Carta Regalo', 'GIFT_BENEFICIARY_MISMATCH'); const before = await rogCommunity.getCommunityStatus(beneficiary); if (before?.registered === true) return { success: true, wallet: beneficiary, accessAllowed: true, communityRegistered: true, idempotent: true }; const registered = await rogCommunity.registerCommunityWallet(beneficiary); if (registered?.registered !== true) throw makeError('Iscrizione Community ROG del beneficiario non verificata', 'GIFT_COMMUNITY_REGISTRATION_UNVERIFIED', true); const after = await rogCommunity.getCommunityStatus(beneficiary); if (after?.registered !== true) throw makeError('Read-back Community ROG del beneficiario non verificato', 'GIFT_COMMUNITY_REGISTRATION_UNVERIFIED', true); return { success: true, wallet: beneficiary, accessAllowed: true, communityRegistered: true }; }
module.exports = { GIFT_ROG_AMOUNT_USDC, GIFT_PHARAOH_AMOUNT_USDC, createGift, getGift, confirmRogPayment, confirmRogRegistration, verifyExternalRogGift, processRogGiftFulfillment, processPharaohPayment, getCommunityAccess, registerGiftCommunityAccess, _publicGift: publicGift, _assertBlockchainOrder: assertBlockchainOrder, _makeError: makeError };

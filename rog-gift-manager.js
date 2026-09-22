'use strict';

const giftSessions = require('./gift-session-manager');
const rogApi = require('./rog-donation-manager');
const rogDonation = require('./rog-donation-manager');

const GIFT_ROG_MIN_AMOUNT_USDC = 2;
function makeError(message, code, retryable = false, payload = null) { const error = new Error(message); error.code = code; error.retryable = retryable; if (payload) error.payload = payload; return error; }
function normalizeWallet(value, label) { return giftSessions.normalizeWallet(value, label); }
function normalizeGiftAmount(value) { return giftSessions.normalizeGiftAmount(value); }
function expectedGiftUnits(amountUsdc) { return normalizeGiftAmount(amountUsdc) / 2; }

async function giftRogRequest(path, options = {}) {
  try { return await rogApi._rogRequest(path, options); }
  catch (error) {
    const status = Number(error?.status);
    const payload = error?.payload && typeof error.payload === 'object' ? error.payload : null;
    if (payload && Number.isInteger(status) && status >= 400 && status <= 499) {
      const upstreamCode = String(payload.code || '').trim();
      const code = upstreamCode || `GIFT_ROG_UPSTREAM_${status}`;
      const message = String(payload.message || payload.error || error.message || 'ROG ha rifiutato la Carta Regalo').slice(0, 500);
      const wrapped = makeError(message, code, payload.retryable === true || status === 425, payload);
      wrapped.httpStatus = status;
      throw wrapped;
    }
    throw error;
  }
}

function assertGiftIdentity(gift, { giftId, paymentWallet }) {
  if (!gift || typeof gift !== 'object') throw makeError('ROG non ha restituito la Carta Regalo', 'GIFT_ROG_READBACK_INVALID', true);
  const id = giftSessions.normalizeGiftId(gift.giftId);
  const donor = normalizeWallet(gift.donorWallet, 'ROG donorWallet');
  const beneficiary = normalizeWallet(gift.beneficiaryWallet, 'ROG beneficiaryWallet');
  const rgxOwner = normalizeWallet(gift.rgxOwnerWallet || gift.donorWallet, 'ROG rgxOwnerWallet');
  const positionsOwner = normalizeWallet(gift.positionsOwnerWallet || gift.beneficiaryWallet, 'ROG positionsOwnerWallet');
  const amount = normalizeGiftAmount(gift.amountUSDC);
  if (id !== giftId) throw makeError('giftId ROG non corrispondente', 'GIFT_ROG_READBACK_MISMATCH');
  if (donor !== paymentWallet || rgxOwner !== paymentWallet) throw makeError('ROG non attribuisce il pagamento/RGX al pagatore atteso', 'GIFT_ROG_PAYER_MISMATCH');
  if (beneficiary === paymentWallet) throw makeError('Pagatore e beneficiario ROG devono essere distinti', 'GIFT_WALLETS_MUST_DIFFER');
  if (positionsOwner !== beneficiary) throw makeError('ROG non attribuisce le posizioni al beneficiario atteso', 'GIFT_ROG_BENEFICIARY_MISMATCH');
  return { giftId: id, paymentWallet: donor, beneficiaryWallet: beneficiary, rogAmountUsdc: amount };
}

function assertGiftShape(gift, expected, { requireCompleted = false } = {}) {
  const identity = assertGiftIdentity(gift, { giftId: expected.giftId, paymentWallet: expected.paymentWallet });
  if (expected.beneficiaryWallet && identity.beneficiaryWallet !== expected.beneficiaryWallet) throw makeError('ROG non attribuisce le posizioni al beneficiario atteso', 'GIFT_ROG_BENEFICIARY_MISMATCH');
  if (expected.rogAmountUsdc != null && identity.rogAmountUsdc !== normalizeGiftAmount(expected.rogAmountUsdc)) throw makeError('Importo Carta Regalo ROG non corrispondente', 'GIFT_ROG_AMOUNT_MISMATCH');
  if (expected.rogUsdcTxHash && String(gift.paymentTxHash || '').toLowerCase() !== expected.rogUsdcTxHash) throw makeError('ROG paymentTxHash non corrispondente', 'GIFT_ROG_READBACK_MISMATCH');
  if (expected.rogDonationId && String(gift.onchainDonationId || '') !== String(expected.rogDonationId)) throw makeError('ROG donationId non corrispondente', 'GIFT_ROG_READBACK_MISMATCH');
  if (expected.rogRegisterTxHash && String(gift.onchainRegisterTxHash || '').toLowerCase() !== expected.rogRegisterTxHash) throw makeError('ROG registerTxHash non corrispondente', 'GIFT_ROG_READBACK_MISMATCH');
  if (requireCompleted && gift.completed !== true && String(gift.status || '').toUpperCase() !== 'COMPLETED') throw makeError('ROG Carta Regalo non ancora COMPLETED', 'GIFT_ROG_COMPLETION_PENDING', true);
  return gift;
}

async function readRawGift(giftId) {
  const id = giftSessions.normalizeGiftId(giftId);
  const response = await giftRogRequest(`/api/gift/${encodeURIComponent(id)}`, { timeoutMs: 10000 });
  if (response?.success !== true) throw makeError('Read-back Carta Regalo ROG fallito', 'GIFT_ROG_READBACK_FAILED', true, response);
  return response.gift;
}

async function readGiftIdentity({ giftId, paymentWallet }) {
  const id = giftSessions.normalizeGiftId(giftId);
  const payer = normalizeWallet(paymentWallet, 'paymentWallet');
  const gift = await readRawGift(id);
  const identity = assertGiftIdentity(gift, { giftId: id, paymentWallet: payer });
  return { ...identity, gift };
}

async function readGift({ giftId, paymentWallet, beneficiaryWallet, rogAmountUsdc, rogUsdcTxHash = null, rogDonationId = null, rogRegisterTxHash = null, requireCompleted = false }) {
  const id = giftSessions.normalizeGiftId(giftId);
  const expected = {
    giftId: id,
    paymentWallet: normalizeWallet(paymentWallet, 'paymentWallet'),
    beneficiaryWallet: normalizeWallet(beneficiaryWallet, 'beneficiaryWallet'),
    rogAmountUsdc: normalizeGiftAmount(rogAmountUsdc),
    rogUsdcTxHash: rogUsdcTxHash ? giftSessions.normalizeHash(rogUsdcTxHash, 'rogUsdcTxHash') : null,
    rogDonationId: rogDonationId == null ? null : String(rogDonationId),
    rogRegisterTxHash: rogRegisterTxHash ? giftSessions.normalizeHash(rogRegisterTxHash, 'rogRegisterTxHash') : null
  };
  const gift = await readRawGift(id);
  return assertGiftShape(gift, expected, { requireCompleted });
}

async function createGiftIntent({ giftId, paymentWallet, beneficiaryWallet, rogAmountUsdc, giftMessage = null }) {
  const id = giftSessions.normalizeGiftId(giftId);
  const payer = normalizeWallet(paymentWallet, 'paymentWallet');
  const beneficiary = normalizeWallet(beneficiaryWallet, 'beneficiaryWallet');
  const amount = normalizeGiftAmount(rogAmountUsdc);
  if (payer === beneficiary) throw makeError('Pagatore e beneficiario devono essere distinti', 'GIFT_WALLETS_MUST_DIFFER');
  const response = await giftRogRequest('/api/gift/create', { method: 'POST', timeoutMs: 10000, body: { giftId: id, donor: payer, beneficiaryWallet: beneficiary, amount, giftMessage: giftMessage || null } });
  if (response?.success !== true) throw makeError(response?.message || 'ROG ha rifiutato la Carta Regalo', response?.code || 'GIFT_ROG_CREATE_FAILED', false, response);
  const gift = assertGiftShape(response.gift, { giftId: id, paymentWallet: payer, beneficiaryWallet: beneficiary, rogAmountUsdc: amount });
  return { success: true, payerPositions: Number(response.payerPositions || 0), gift };
}

async function confirmRogPayment({ giftId, paymentWallet, beneficiaryWallet, rogAmountUsdc, rogUsdcTxHash }) {
  const id = giftSessions.normalizeGiftId(giftId);
  const payer = normalizeWallet(paymentWallet, 'paymentWallet');
  const beneficiary = normalizeWallet(beneficiaryWallet, 'beneficiaryWallet');
  const amount = normalizeGiftAmount(rogAmountUsdc);
  const tx = giftSessions.normalizeHash(rogUsdcTxHash, 'rogUsdcTxHash');
  const transferProof = await rogDonation.verifyRogUsdcTransfer({ txHash: tx, wallet: payer, amountUsdc: amount });
  const response = await giftRogRequest(`/api/gift/${encodeURIComponent(id)}/payment`, { method: 'POST', timeoutMs: 10000, body: { donor: payer, txHash: tx } });
  if (response?.success !== true) throw makeError(response?.message || 'ROG non ha confermato il pagamento Carta Regalo', response?.code || 'GIFT_ROG_PAYMENT_FAILED', false, response);
  const gift = assertGiftShape(response.gift, { giftId: id, paymentWallet: payer, beneficiaryWallet: beneficiary, rogAmountUsdc: amount, rogUsdcTxHash: tx });
  return { success: true, transferProof, gift };
}

function assertCompletionPositions(completion, beneficiaryWallet, rogAmountUsdc) {
  const expected = expectedGiftUnits(rogAmountUsdc);
  const positions = completion?.positions;
  const count = Number(positions?.posizioniCreate ?? positions?.positionsCreated ?? 0);
  const list = Array.isArray(positions?.posizioni) ? positions.posizioni : [];
  if (!Number.isFinite(count) || count !== expected || list.length !== expected) throw makeError(`ROG deve confermare esattamente ${expected} posizioni HUMAN per la Carta Regalo da ${rogAmountUsdc} USDC`, 'GIFT_ROG_POSITION_NOT_VERIFIED', true);
  for (const item of list) {
    if (String(item?.wallet || '').toLowerCase() !== beneficiaryWallet) throw makeError('ROG ha restituito una posizione HUMAN su wallet differente dal beneficiario', 'GIFT_ROG_POSITION_OWNER_MISMATCH');
    if (item?.tipo && String(item.tipo).toUpperCase() !== 'HUMAN') throw makeError('ROG non ha restituito una posizione HUMAN per il beneficiario', 'GIFT_ROG_POSITION_TYPE_MISMATCH');
  }
}

async function confirmRogRegistration({ giftId, paymentWallet, beneficiaryWallet, rogAmountUsdc, rogUsdcTxHash, rogRegisterTxHash, rogDonationId }) {
  const id = giftSessions.normalizeGiftId(giftId);
  const payer = normalizeWallet(paymentWallet, 'paymentWallet');
  const beneficiary = normalizeWallet(beneficiaryWallet, 'beneficiaryWallet');
  const amount = normalizeGiftAmount(rogAmountUsdc);
  const paymentTx = giftSessions.normalizeHash(rogUsdcTxHash, 'rogUsdcTxHash');
  const registerTx = giftSessions.normalizeHash(rogRegisterTxHash, 'rogRegisterTxHash');
  const donationId = String(rogDonationId || '').trim();
  if (!/^\d+$/.test(donationId) || BigInt(donationId) <= 0n) throw makeError('rogDonationId numerico obbligatorio', 'GIFT_ROG_DONATION_ID_INVALID');
  const transferProof = await rogDonation.verifyRogUsdcTransfer({ txHash: paymentTx, wallet: payer, amountUsdc: amount });
  const registrationProof = await rogDonation.verifyRogRegistration({ registerTxHash: registerTx, wallet: payer, amountUsdc: amount, donationId });
  const registerResponse = await giftRogRequest(`/api/gift/${encodeURIComponent(id)}/register-payer`, { method: 'POST', timeoutMs: 10000, body: { donor: payer, donationId, registerTxHash: registerTx } });
  if (registerResponse?.success !== true) throw makeError(registerResponse?.message || 'ROG non ha accettato registerDonation Carta Regalo', registerResponse?.code || 'GIFT_ROG_REGISTER_FAILED', false, registerResponse);
  const gift = assertGiftShape(registerResponse.gift, { giftId: id, paymentWallet: payer, beneficiaryWallet: beneficiary, rogAmountUsdc: amount, rogUsdcTxHash: paymentTx, rogDonationId: donationId, rogRegisterTxHash: registerTx });
  return { success: true, transferProof, registrationProof, gift };
}

async function completeRogGift({ giftId, paymentWallet, beneficiaryWallet, rogAmountUsdc, rogUsdcTxHash, rogRegisterTxHash, rogDonationId }) {
  const id = giftSessions.normalizeGiftId(giftId);
  const payer = normalizeWallet(paymentWallet, 'paymentWallet');
  const beneficiary = normalizeWallet(beneficiaryWallet, 'beneficiaryWallet');
  const amount = normalizeGiftAmount(rogAmountUsdc);
  const paymentTx = giftSessions.normalizeHash(rogUsdcTxHash, 'rogUsdcTxHash');
  const registerTx = giftSessions.normalizeHash(rogRegisterTxHash, 'rogRegisterTxHash');
  const donationId = String(rogDonationId || '').trim();
  if (!/^\d+$/.test(donationId) || BigInt(donationId) <= 0n) throw makeError('rogDonationId numerico obbligatorio', 'GIFT_ROG_DONATION_ID_INVALID');
  let completion;
  try { completion = await giftRogRequest('/api/donation/verify', { method: 'POST', timeoutMs: Number(process.env.ROG_COMPLETION_API_TIMEOUT_MS || 25000), body: { donationId } }); }
  catch (error) {
    const payload = error?.payload || null;
    if (payload?.status === 'ONCHAIN_COMPLETION_PENDING' || payload?.retryable === true || error?.retryable === true) throw makeError('Completamento ROG Carta Regalo ancora in conferma on-chain', 'GIFT_ROG_COMPLETION_PENDING', true, payload);
    throw error;
  }
  if (completion?.success !== true || completion?.status !== 'COMPLETED') {
    const retryable = completion?.status === 'ONCHAIN_COMPLETION_PENDING' || completion?.retryable === true;
    throw makeError(completion?.message || 'ROG non ha confermato la Carta Regalo come COMPLETED', retryable ? 'GIFT_ROG_COMPLETION_PENDING' : 'GIFT_ROG_NOT_COMPLETED', retryable, completion);
  }
  if (String(completion.rgxOwnerWallet || '').toLowerCase() !== payer) throw makeError('ROG ha attribuito RGX a un wallet differente dal pagatore', 'GIFT_ROG_RGX_OWNER_MISMATCH');
  const units = expectedGiftUnits(amount);
  if (!Number.isFinite(Number(completion.rgxMinted)) || Number(completion.rgxMinted) !== units) throw makeError(`ROG deve confermare esattamente ${units} RGX al pagatore per la Carta Regalo da ${amount} USDC`, 'GIFT_ROG_RGX_NOT_VERIFIED');
  assertCompletionPositions(completion, beneficiary, amount);
  const gift = await readGift({ giftId: id, paymentWallet: payer, beneficiaryWallet: beneficiary, rogAmountUsdc: amount, rogUsdcTxHash: paymentTx, rogDonationId: donationId, rogRegisterTxHash: registerTx, requireCompleted: true });
  return { success: true, completion, gift };
}

module.exports = { GIFT_ROG_MIN_AMOUNT_USDC, normalizeGiftAmount, expectedGiftUnits, createGiftIntent, confirmRogPayment, confirmRogRegistration, completeRogGift, readGift, readGiftIdentity, assertGiftShape, _assertCompletionPositions: assertCompletionPositions, _makeError: makeError, _giftRogRequest: giftRogRequest };

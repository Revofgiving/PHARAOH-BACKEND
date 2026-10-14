'use strict';
/** Sender-side acknowledgement policy. A successful HTTP request is not proof
 * that the receiver finished its work. This module does NOT certify records in
 * the peer's database, nor define a new ROG/URANUS wire protocol.
 */
const A = require('./economic-amounts');
const OWN = (value, name) => Object.prototype.hasOwnProperty.call(value, name);
function failure(code, message, retryable = false, httpStatus = 409) {
  return Object.assign(new Error(message), { code, retryable, httpStatus });
}
function timeoutMs(value = process.env.CROSS_OUTBOUND_TIMEOUT_MS) {
  if (value == null || value === '') return 10000;
  if (!/^[0-9]+$/.test(String(value))) throw failure('CROSS_OUTBOUND_TIMEOUT_INVALID', 'Invalid cross notification timeout');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 100 || n > 120000) throw failure('CROSS_OUTBOUND_TIMEOUT_INVALID', 'Cross notification timeout must be 100..120000 ms');
  return n;
}
function strictInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value).toString();
  return null;
}
function assertCompletion(payload, row, cfg) {
  const state = typeof payload?.status === 'string' ? payload.status.toUpperCase() : '';
  if (['PENDING', 'PROCESSING', 'ACCEPTED', 'QUEUED', 'RECEIVED', 'NOTIFY_PENDING'].includes(state)) {
    throw failure('CROSS_OUTBOUND_REMOTE_PENDING', `${cfg.target} has not completed this event`, true, 425);
  }
  if (state !== 'COMPLETED') throw failure('CROSS_OUTBOUND_COMPLETION_UNPROVEN', `${cfg.target} did not provide a final completion acknowledgement`);
  // Existing peers need not echo these fields. When present they must match:
  // this rejects contradictory receipts without inventing mandatory peer fields.
  const equal = (names, expected, code, lower = false) => {
    for (const name of names) if (OWN(payload, name)) {
      const value = payload[name];
      const actual = typeof value === 'string' ? (lower ? value.toLowerCase() : value) : null;
      if (actual !== (lower ? String(expected).toLowerCase() : String(expected))) throw failure(code, `${cfg.target} acknowledgement mismatch: ${name}`);
    }
  };
  equal(['event_key', 'eventKey'], row.event_key, 'CROSS_OUTBOUND_REMOTE_IDENTITY_MISMATCH');
  equal(['payment_tx_hash', 'paymentTxHash'], row.payment_tx_hash, 'CROSS_OUTBOUND_REMOTE_IDENTITY_MISMATCH', true);
  for (const name of ['num_ingressi', 'positions_expected']) if (OWN(payload, name)) {
    if (strictInteger(payload[name]) !== strictInteger(row.positions_expected)) throw failure('CROSS_OUTBOUND_REMOTE_COUNT_MISMATCH', `${cfg.target} acknowledged a different number of dual units`);
  }
  for (const name of ['importo_totale', 'amount_usdc']) if (OWN(payload, name)) {
    const value = payload[name];
    try {
      if (!['string', 'number'].includes(typeof value) || A.usdc(String(value)) !== A.usdc(String(row.amount_usdc))) throw new Error('mismatch');
    } catch (_) { throw failure('CROSS_OUTBOUND_REMOTE_AMOUNT_MISMATCH', `${cfg.target} acknowledged a different amount`); }
  }
  // ROG ownership/donation/RGx requirements remain enforced by its existing
  // protocol-specific validator. URANUS echoes are checked if supplied.
  if (cfg.target === 'URANUS') {
    equal(['beneficiaryWallet', 'wallet_beneficiario', 'positionsOwnerWallet'], row.beneficiary_wallet, 'CROSS_OUTBOUND_REMOTE_OWNER_MISMATCH', true);
  }
}
function isRetryableTransport(error) {
  if (error?.name === 'AbortError') return true;
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
  return codes.has(error?.code) || codes.has(error?.cause?.code);
}
module.exports = { timeoutMs, strictInteger, assertCompletion, isRetryableTransport, failure };

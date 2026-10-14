'use strict';
/** Applicazione pre-chain delle regole DAO (non sostituisce settlement e riconciliazione). */
// Inherited per-transfer interpretation. Scope of the 50,000 cap is still unresolved.
const MAX_USDC = 50000n;
const DECIMALS = 1000000n;
const SAFE_NAMES = Object.freeze(['PHARAOH', 'GEMELLI', 'PROGETTI']);
function checkTransfer({source, destination, amountAtomic, settledBalanceAtomic, reservedAtomic = 0n}) {
  if (!SAFE_NAMES.includes(source)) throw new Error('INVALID_SOURCE_TREASURY');
  if (typeof destination !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(destination) || /^0x0{40}$/i.test(destination)) throw new Error('INVALID_DESTINATION');
  if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n || amountAtomic > MAX_USDC * DECIMALS) throw new Error('TRANSFER_LIMIT_50000_USDC');
  if (typeof settledBalanceAtomic !== 'bigint' || settledBalanceAtomic < 0n) throw new Error('INVALID_SETTLED_BALANCE');
  if (typeof reservedAtomic !== 'bigint' || reservedAtomic < 0n) throw new Error('INVALID_RESERVED_BALANCE');
  if (reservedAtomic > settledBalanceAtomic || settledBalanceAtomic - reservedAtomic < amountAtomic) throw new Error('INSUFFICIENT_UNRESERVED_BALANCE');
  return Object.freeze({source, destination: destination.toLowerCase(), amountAtomic: amountAtomic.toString()});
}
module.exports = {MAX_USDC, DECIMALS, SAFE_NAMES, checkTransfer};

'use strict';
/**
 * Written decisions, 8 October 2026. Pure rules, NOT payment or placement code.
 * Family class is independent of account type: an overflow FONDO_A root is
 * PRIMARIO; only the original founder remains the historical FONDO account.
 */
const {exactCount, UNIT_ATOMIC} = require('./s0-generated-batch-policy');
const SCALE = 1000000n;
const HUMAN_ORIGINS = Object.freeze(['DIRECT', 'GIFT', 'ROG_TO_PHARAOH', 'URANUS_TO_PHARAOH']);
/** Transport labels have one immutable accounting identity. This does not
 * authorize a receiver; network admission remains in cross-entry-manager. */
function normalizeHumanOrigin(origin) {
  if (origin === 'ROG') return 'ROG_TO_PHARAOH';
  if (origin === 'URANUS') return 'URANUS_TO_PHARAOH';
  if (HUMAN_ORIGINS.includes(origin)) return origin;
  throw new Error('HUMAN_ORIGIN_REQUIRES_RECONCILIATION');
}
const CLASSES = Object.freeze(['HUMAN', 'PILETTA', 'FONDO_A', 'CASSA_PROGETTI']);
const ACCOUNTS = Object.freeze(['PRIMARIO', 'FONDO', 'GEMELLO', 'PERPETUO']);
function wallet(value, name) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`INVALID_${name}`);
  }
  return value.toLowerCase();
}
/** Call ONLY for validated/materialized S0 entries; it does not enable a bridge. */
function humanCounterDelta({positionClass, origin, materializedPositions}) {
  if (!CLASSES.includes(positionClass)) throw new Error('UNCLASSIFIED_S0_POSITION');
  const n = exactCount(materializedPositions, 'MATERIALIZED_POSITION_COUNT');
  if (positionClass !== 'HUMAN') return 0n;
  normalizeHumanOrigin(origin);
  return n;
}
function generatedRootIdentity({positionClass, fundAWallet}) {
  if (positionClass === 'FONDO_A') {
    return Object.freeze({accountType:'PRIMARIO', familyClass:'FONDO_A',
      wallet:wallet(fundAWallet,'FUND_A_WALLET'), externalHumanDelta:0n,
      replayFounderBootstrap:false, reconvertToPiletta:false});
  }
  if (positionClass === 'PILETTA') {
    // No arbitrary public wallet is invented for the system-owned identity.
    return Object.freeze({accountType:'PRIMARIO', familyClass:'PILETTA', wallet:null,
      systemIdentityRequired:true, externalHumanDelta:0n, replayFounderBootstrap:false});
  }
  throw new Error('INVALID_GENERATED_ROOT_CLASS');
}
function netUsdc(accountType, level) {
  if (!ACCOUNTS.includes(accountType)) throw new Error('INVALID_ACCOUNT_TYPE');
  const primary = accountType === 'PRIMARIO' || accountType === 'FONDO';
  if (level === 'RHA') return primary ? 6000n : 1000n;
  if (primary) throw new Error('PRIMARY_PATH_ENDS_AT_RHA');
  if (level === 'THOT') return 4000n;
  if (level === 'ISIDE') return 25000n;
  throw new Error('INVALID_PAYOUT_LEVEL');
}
/** Separate receiver net from system quotas; never pay the whole table to A. */
function planExitNet({positionClass, accountType, level, ownerWallet, fundAWallet}) {
  if (!['HUMAN','FONDO_A','PILETTA'].includes(positionClass)) throw new Error('INVALID_RECEIVER_CLASS');
  const netAtomic = netUsdc(accountType, level) * SCALE;
  const lots = [];
  if (level === 'THOT') lots.push(Object.freeze({source:'THOT', amountAtomic:500n*SCALE, count:5n}));
  if (level === 'ISIDE') lots.push(Object.freeze({source:'ISIDE', amountAtomic:5000n*SCALE, count:50n}));
  let beneficiaryWallet = null;
  if (positionClass === 'PILETTA') {
    lots.push(Object.freeze({source:'PILETTA_REINVESTMENT', amountAtomic:netAtomic, count:netAtomic/UNIT_ATOMIC}));
  } else {
    beneficiaryWallet = wallet(ownerWallet,'OWNER_WALLET');
    if (positionClass === 'FONDO_A' && beneficiaryWallet !== wallet(fundAWallet,'FUND_A_WALLET')) {
      throw new Error('FONDO_A_OWNER_MISMATCH');
    }
  }
  return Object.freeze({status:'PLAN_ONLY_NOT_EXECUTED', level, accountType, positionClass,
    netAtomic, cashPayoutAtomic:positionClass === 'PILETTA' ? 0n : netAtomic,
    beneficiaryWallet, automaticReceiverReentries:0n,
    generatedLots:Object.freeze(lots), existingReservesAndCrossUnchanged:true});
}
module.exports = {HUMAN_ORIGINS, normalizeHumanOrigin, humanCounterDelta, generatedRootIdentity, planExitNet};

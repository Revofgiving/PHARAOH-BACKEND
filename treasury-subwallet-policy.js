'use strict';
/** V4 treasury movement policy. No transfer, signing or Registry write occurs here. */
const {exactCount} = require('./s0-generated-batch-policy');
const {MAX_USDC} = require('./treasury-v4-policy');
const DECIMALS = 1000000n;

const PURPOSES = Object.freeze({
  GEMELLI_RESERVE_OUT: Object.freeze({from:'PHARAOH',to:'GEMELLI',amount:500n*DECIMALS,direction:2}),
  GEMELLI_FUNDING_IN: Object.freeze({from:'GEMELLI',to:'PHARAOH',amount:500n*DECIMALS,direction:1}),
  CONTINUITY_IN: Object.freeze({from:'GEMELLI',to:'PHARAOH',amount:500n*DECIMALS,direction:1}),
  PROJECTS_BOOTSTRAP_OUT: Object.freeze({from:'PHARAOH',to:'PROGETTI',amount:100n*DECIMALS,direction:2}),
  THOT_PROJECTS_OUT: Object.freeze({from:'PHARAOH',to:'PROGETTI',amount:500n*DECIMALS,direction:2})
});

const PROJECTS_OUT_PURPOSES = Object.freeze([
  'PROJECTS_HUMANITARIAN_OUT',
  'PROJECTS_MAINTENANCE_OUT'
]);

function address(value, label) {
  if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`INVALID_${label}`);
  return value.toLowerCase();
}
function hash(value, label) {
  if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(value) || /^0x0{64}$/i.test(value)) throw new Error(`INVALID_${label}`);
  return value.toLowerCase();
}
function wallets(wallets) {
  const w = Object.fromEntries(['PHARAOH','GEMELLI','PROGETTI'].map(role => [role,address(wallets?.[role],role)]));
  if (new Set(Object.values(w)).size !== 3) throw new Error('TREASURY_WALLETS_MUST_BE_SEPARATE');
  return w;
}
function proofPlan({purpose,amountAtomic,externalTxHash,from,to,w,direction,tokenContract,chainId}) {
  const chain = exactCount(chainId,'CHAIN_ID');
  if (!chain) throw new Error('INVALID_CHAIN_ID');
  const txHash = hash(externalTxHash,'ERC20_TX_HASH');
  const token = address(tokenContract,'USDC_CONTRACT');
  return Object.freeze({
    purpose,amountAtomic,externalTxHash:txHash,from,to,
    pharaohWallet:w.PHARAOH,counterparty:direction===1?from:to,direction,
    tokenContract:token,chainId:chain.toString(),
    proofReference:`${chain}:${token}:${txHash}:${from}:${to}`
  });
}
function prepareProjectsOutgoing({purpose,amountAtomic,externalTxHash,wallets:walletInput,destinationWallet,tokenContract,chainId}) {
  if (!PROJECTS_OUT_PURPOSES.includes(purpose)) throw new Error('PROJECTS_OUT_PURPOSE_INVALID');
  if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n || amountAtomic > MAX_USDC*DECIMALS) throw new Error('TRANSFER_LIMIT_50000_USDC');
  const w = wallets(walletInput);
  const from = w.PROGETTI;
  const to = address(destinationWallet,'PROJECTS_DESTINATION');
  if (Object.values(w).includes(to)) throw new Error('PROJECTS_DESTINATION_MUST_BE_EXTERNAL');
  return proofPlan({purpose,amountAtomic,externalTxHash,from,to,w,direction:2,tokenContract,chainId});
}
function prepareSubwalletMovement(args) {
  const {purpose,amountAtomic,externalTxHash,tokenContract,chainId} = args;
  if (PROJECTS_OUT_PURPOSES.includes(purpose)) return prepareProjectsOutgoing(args);
  if (!Object.hasOwn(PURPOSES,purpose)) throw new Error('MOVEMENT_OUTSIDE_REGISTRY_V4_SUBWALLET_SCOPE');
  const spec = PURPOSES[purpose];
  if (typeof amountAtomic !== 'bigint' || amountAtomic !== spec.amount) throw new Error('SUBWALLET_AMOUNT_MISMATCH');
  const w = wallets(args.wallets);
  const from = w[spec.from], to = w[spec.to];
  return proofPlan({purpose,amountAtomic,externalTxHash,from,to,w,direction:spec.direction,tokenContract,chainId});
}
function requireMatchingProof(plan, verification, requiredConfirmations) {
  const required = exactCount(requiredConfirmations,'REQUIRED_CONFIRMATIONS');
  if (!required) throw new Error('INVALID_REQUIRED_CONFIRMATIONS');
  const proof = verification?.proof;
  if (verification?.valida !== true || !proof) throw new Error('SUBWALLET_TRANSFER_NOT_VERIFIED');
  if (hash(proof.txHash,'PROOF_TX_HASH') !== plan.externalTxHash ||
      address(proof.from,'PROOF_FROM') !== plan.from || address(proof.to,'PROOF_TO') !== plan.to ||
      address(proof.tokenContract,'PROOF_TOKEN') !== plan.tokenContract ||
      exactCount(proof.chainId,'PROOF_CHAIN_ID').toString() !== plan.chainId ||
      exactCount(proof.amountBaseUnits,'PROOF_AMOUNT') !== plan.amountAtomic) throw new Error('SUBWALLET_TRANSFER_PROOF_MISMATCH');
  const block = exactCount(proof.blockNumber,'PROOF_BLOCK');
  if (block < 1n || block > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_PROOF_BLOCK');
  hash(proof.blockHash,'PROOF_BLOCK_HASH');
  if (exactCount(proof.confirmations,'PROOF_CONFIRMATIONS') < required) throw new Error('SUBWALLET_CONFIRMATIONS_PENDING');
  if (!Array.isArray(proof.transferLogIndexes) || !proof.transferLogIndexes.length ||
      proof.transferLogIndexes.some(i=>!Number.isSafeInteger(i)||i<0) ||
      new Set(proof.transferLogIndexes).size!==proof.transferLogIndexes.length) throw new Error('INVALID_TRANSFER_LOG_EVIDENCE');
  return proof;
}
function freeSettledBalance({settledAtomic,reservations}) {
  if (typeof settledAtomic !== 'bigint' || settledAtomic < 0n || !Array.isArray(reservations)) throw new Error('INVALID_SETTLED_RESERVATION_STATE');
  const seen=new Set(); let committed=0n;
  for (const hold of reservations) {
    if (!hold || typeof hold.id!=='string' || !hold.id || seen.has(hold.id) || typeof hold.amountAtomic!=='bigint' || hold.amountAtomic<0n) throw new Error('INVALID_OR_DUPLICATE_RESERVATION');
    seen.add(hold.id); committed+=hold.amountAtomic;
  }
  if (committed>settledAtomic) throw new Error('RESERVATIONS_EXCEED_SETTLED_BALANCE');
  return settledAtomic-committed;
}
function requireGemelliBalance(balanceAtomic,operation) {
  if (typeof balanceAtomic!=='bigint' || ![0n,500n*DECIMALS].includes(balanceAtomic)) throw new Error('GEMELLI_RECONCILIATION_REQUIRED');
  if (operation==='DEPOSIT_NEXT' && balanceAtomic!==0n) throw new Error('GEMELLI_DOUBLE_FUNDING_FORBIDDEN');
  if (operation==='RELEASE_CURRENT' && balanceAtomic!==500n*DECIMALS) throw new Error('GEMELLI_PREFUNDING_MISSING');
  if (!['DEPOSIT_NEXT','RELEASE_CURRENT'].includes(operation)) throw new Error('INVALID_GEMELLI_OPERATION');
  return true;
}
function requireProjectsFloorAfterSpend({settledAtomic,otherReservedAtomic,amountAtomic}) {
  for (const n of [settledAtomic,otherReservedAtomic,amountAtomic]) if (typeof n!=='bigint' || n<0n) throw new Error('INVALID_PROJECTS_BALANCE');
  if (amountAtomic===0n || settledAtomic-otherReservedAtomic-amountAtomic<100n*DECIMALS) throw new Error('PROJECTS_STRUCTURAL_100_MUST_REMAIN');
  return true;
}
module.exports={
  PURPOSES,PROJECTS_OUT_PURPOSES,DECIMALS,address,hash,
  prepareSubwalletMovement,prepareProjectsOutgoing,requireMatchingProof,
  freeSettledBalance,requireGemelliBalance,requireProjectsFloorAfterSpend
};

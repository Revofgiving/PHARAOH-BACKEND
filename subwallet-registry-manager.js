'use strict';
/**
 * Registers an ALREADY transferred, verified amount with Registry V4.
 * Does not sign/broadcast ERC20 transfers or create/spend a reserve.
 * Called by economic-worker only after the durable transfer ledger is settled.
 * Cutover, release and Registry verification remain separate enforced gates.
 */
const policy=require('./treasury-subwallet-policy');
function config(){
  return {wallets:{PHARAOH:process.env.PHARAOH_TREASURY_WALLET,GEMELLI:process.env.PHARAOH_GEMELLI_WALLET,PROGETTI:process.env.PHARAOH_PROJECTS_WALLET},
    tokenContract:process.env.USDC_CONTRACT_ADDRESS,chainId:process.env.POLYGON_CHAIN_ID||'137',requiredConfirmations:process.env.POLYGON_MIN_CONFIRMATIONS||'1'};
}
async function registerConfirmedSubwalletMovement({eventKey,purpose,amountAtomic,externalTxHash,destinationWallet=null,existingRegistryTxHash=null,onSubmitted}, dependencies={}){
  if(typeof eventKey!=='string'||!eventKey.trim()||eventKey.length>512)throw new Error('SUBWALLET_EVENT_KEY_REQUIRED');
  if(typeof onSubmitted!=='function')throw new Error('DURABLE_REGISTRY_SUBMISSION_CALLBACK_REQUIRED');
  if(existingRegistryTxHash!==null)policy.hash(existingRegistryTxHash,'STORED_REGISTRY_TX_HASH');
  const cfg=dependencies.config||config();
  const plan=policy.prepareSubwalletMovement({purpose,amountAtomic,externalTxHash,destinationWallet,...cfg});
  const verifier=dependencies.verifier||require('./blockchain-verifier');
  const verification=await verifier.verificaDonazione({txHash:plan.externalTxHash,walletMittente:plan.from,destinatarioWallet:plan.to,
    importoMinimo:Number(plan.amountAtomic/policy.DECIMALS),maxPosizioni:1,skipDonationReplayCheck:true},dependencies.verifierDependencies||{});
  policy.requireMatchingProof(plan,verification,cfg.requiredConfirmations);
  const registry=dependencies.registry||require('./pharaoh-registry-manager');
  return registry.registerSubwalletMovement({plan,verification,requiredConfirmations:cfg.requiredConfirmations,
    eventKey,existingRegistryTxHash,onSubmitted},{...(dependencies.registryDependencies||{}),subwalletConfig:cfg});
}
module.exports={registerConfirmedSubwalletMovement};

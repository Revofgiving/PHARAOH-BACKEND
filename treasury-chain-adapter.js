'use strict';
/** Ethers boundary. Manual proofs use the ERC20 Transfer sender, not the outer
 * transaction submitter. Automatic signing requires the exact custody EOA.
 */
const A=require('./economic-amounts');
function createTreasuryChain(config, dependencies={}) {
  const ethers=dependencies.ethers || require('ethers').ethers;
  const url=process.env.POLYGON_RPC_URL;
  if(!url && !dependencies.provider)throw A.error('POLYGON_RPC_URL_REQUIRED');
  const provider=dependencies.provider || new ethers.JsonRpcProvider(url);
  const token=A.address(config.token),chainId=A.positive(config.chainId),minimum=A.positive(config.minConfirmations);
  const iface=new ethers.Interface(['function transfer(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)','event Transfer(address indexed from,address indexed to,uint256 value)']);
  const contract=new ethers.Contract(token,iface,provider);
  async function network(){if(BigInt((await provider.getNetwork()).chainId)!==chainId)throw A.error('TRANSFER_WRONG_CHAIN');}
  async function balance(wallet,blockTag){return BigInt(await contract.balanceOf(wallet,{blockTag}));}
  async function verify(m) {
    await network();
    const receipt=await provider.getTransactionReceipt(A.hash(m.tx_hash));if(!receipt)return null;
    if(Number(receipt.status)!==1)throw A.error('TRANSFER_REVERTED_RECONCILIATION_REQUIRED');
    if(A.hash(receipt.hash || receipt.transactionHash)!==m.tx_hash)throw A.error('TRANSFER_RECEIPT_HASH_MISMATCH');
    const head=BigInt(await provider.getBlockNumber()),height=BigInt(receipt.blockNumber),confirmations=head-height+1n;
    if(confirmations<minimum)return null;
    const block=await provider.getBlock(receipt.blockNumber);
    if(!block || A.hash(block.hash)!==A.hash(receipt.blockHash))throw A.error('TRANSFER_REORG_RECONCILIATION_REQUIRED');
    if(m.created_at && !m.signed_raw_tx) {
      const prepared=Math.floor(new Date(m.created_at).getTime()/1000);
      if(!Number.isSafeInteger(prepared)||!Number.isSafeInteger(Number(block.timestamp))||Number(block.timestamp)<prepared)throw A.error('MANUAL_TRANSFER_PREDATES_RESERVATION');
    }
    let amount=0n;const indexes=[];
    for(const log of receipt.logs||[]) {
      if(String(log.address).toLowerCase()!==token)continue;
      let parsed;try{parsed=iface.parseLog(log);}catch(_){continue;}
      if(parsed?.name==='Transfer' && String(parsed.args.from).toLowerCase()===m.source_wallet && String(parsed.args.to).toLowerCase()===m.destination_wallet) {
        amount+=BigInt(parsed.args.value);indexes.push(log.index);
      }
    }
    if(amount!==A.positive(m.amount_atomic)||!indexes.length)throw A.error('TRANSFER_ERC20_LOG_MISMATCH');
    return {valida:true,proof:{txHash:m.tx_hash,from:m.source_wallet,to:m.destination_wallet,tokenContract:token,chainId:chainId.toString(),
      amountBaseUnits:amount.toString(),amountUsdc:Number(A.decimal(amount)),blockNumber:height.toString(),blockHash:A.hash(receipt.blockHash),confirmations:confirmations.toString(),transferLogIndexes:indexes}};
  }
  return {
    verify,
    async preflightSigned(m) {
      await network();
      const tx=ethers.Transaction.from(m.signed_raw_tx);
      const data=iface.encodeFunctionData('transfer',[m.destination_wallet,A.positive(m.amount_atomic)]);
      if(ethers.keccak256(m.signed_raw_tx).toLowerCase()!==m.tx_hash||A.address(tx.from)!==m.source_wallet||A.address(tx.to)!==token||tx.data!==data||tx.value!==0n||tx.chainId!==chainId||String(tx.nonce)!==String(m.sender_nonce))throw A.error('STORED_SIGNED_TRANSFER_MISMATCH');
      const [pending,latest]=await Promise.all([provider.getTransactionCount(m.source_wallet,'pending'),provider.getTransactionCount(m.source_wallet,'latest')]);
      if(pending!==latest || latest!==tx.nonce)throw A.error('SIGNED_NONCE_RECONCILIATION_REQUIRED');
    },
    async knownTransaction(hash){return Boolean(await provider.getTransaction(A.hash(hash)));},
    async balances(m) {
      await network();const head=BigInt(await provider.getBlockNumber()),height=head-minimum+1n;if(height<0n)throw A.error('SETTLED_CHAIN_HEAD_UNAVAILABLE');
      const tag=Number(height);if(!Number.isSafeInteger(tag))throw A.error('UNSAFE_BLOCK_HEIGHT');
      const [sourceAtomic,destinationAtomic]=await Promise.all([balance(m.source_wallet,tag),balance(m.destination_wallet,tag)]);
      return {sourceAtomic,destinationAtomic,blockNumber:height};
    },
    async sign(m) {
      await network();
      const gemelli=Boolean(config.gemelliWallet) && m.source_wallet===A.address(config.gemelliWallet);
      const projects=Boolean(config.projectsWallet) && m.source_wallet===A.address(config.projectsWallet);
      if(gemelli && process.env.PHARAOH_GEMELLI_SIGNING_MODE!=='AUTOMATIC')throw A.error('GEMELLI_MANUAL_SIGNATURE_REQUIRED');
      if(projects && process.env.PHARAOH_PROJECTS_SIGNING_MODE!=='AUTOMATIC')throw A.error('PROJECTS_MANUAL_SIGNATURE_REQUIRED');
      const key=gemelli
        ? process.env.PHARAOH_GEMELLI_PRIVATE_KEY
        : projects
          ? process.env.PHARAOH_PROJECTS_PRIVATE_KEY
          : process.env.PHARAOH_PAYOUT_PRIVATE_KEY;
      if(!key)throw A.error('TREASURY_SIGNER_NOT_CONFIGURED');
      let wallet;try{wallet=new ethers.Wallet(key,provider);}catch(_){throw A.error('TREASURY_SIGNER_KEY_INVALID');}
      if(A.address(wallet.address)!==m.source_wallet)throw A.error('TREASURY_SIGNER_WALLET_MISMATCH');
      const [pending,latest]=await Promise.all([provider.getTransactionCount(wallet.address,'pending'),provider.getTransactionCount(wallet.address,'latest')]);
      if(!Number.isSafeInteger(pending)||pending<0||pending!==latest)throw A.error('TREASURY_SIGNER_PENDING_NONCE_REQUIRES_RECONCILIATION');
      const data=iface.encodeFunctionData('transfer',[m.destination_wallet,A.positive(m.amount_atomic)]);
      const request=await wallet.populateTransaction({to:token,data,value:0n,nonce:pending});
      if(BigInt(request.chainId)!==chainId)throw A.error('SIGNING_WRONG_CHAIN');
      const raw=await wallet.signTransaction(request),txHash=ethers.keccak256(raw).toLowerCase();
      const parsed=ethers.Transaction.from(raw);
      if(A.address(parsed.from)!==m.source_wallet||A.address(parsed.to)!==token||parsed.data!==data||parsed.value!==0n||parsed.chainId!==chainId||parsed.nonce!==pending)throw A.error('SIGNED_TRANSFER_PAYLOAD_MISMATCH');
      return {raw,txHash,nonce:pending,chainId:chainId.toString(),token};
    },
    async broadcast(raw){return provider.broadcastTransaction(raw);}
  };
}
module.exports={createTreasuryChain};

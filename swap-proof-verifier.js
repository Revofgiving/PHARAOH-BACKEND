'use strict';
// Read-only chain proof. Native POL requires an RPC exposing debug_traceTransaction(callTracer).
// A receipt alone cannot prove a native internal-value transfer.
const A=require('./economic-amounts');
const POLYGON_USDC='0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function fromTopic(value){return '0x'+String(value||'').slice(-40).toLowerCase();}
function traceNativeFlows(frame,destination){
 let received=0n,outgoing=0n;
 function walk(f){
  if(!f||typeof f!=='object')return;
  if(f.error||f.revertReason)return; // reverted subcalls do not settle native value
  if(['CALL','CREATE','CALLCODE'].includes(String(f.type||'').toUpperCase())) {
    const v=BigInt(f.value||'0x0');
    const from=String(f.from||'').toLowerCase(),to=String(f.to||'').toLowerCase(),dest=destination.toLowerCase();
    if(v>0n&&to===dest&&from!==dest)received+=v;
    if(v>0n&&from===dest&&to!==dest)outgoing+=v;
  }
  for(const c of (Array.isArray(f.calls)?f.calls:[]))walk(c);
 }
 walk(frame);return {received,outgoing};
}
function traceNativeTo(frame,destination){return traceNativeFlows(frame,destination).received;}
function assess({chainId,receipt,tx,trace,treasury,recipient,expectedUsdcAtomic,expectedPolWei,confirmations,canonicalBlockHash}){
 if(Number(chainId)!==137)throw A.error('SWAP_WRONG_CHAIN');
 const t=A.address(treasury),p=A.address(recipient);
 if(!receipt||Number(receipt.status)!==1||!tx||A.address(tx.from)!==t ||
    String(receipt.transactionHash||receipt.hash).toLowerCase()!==String(tx.hash).toLowerCase() ||
    !canonicalBlockHash || String(receipt.blockHash).toLowerCase()!==String(canonicalBlockHash).toLowerCase() ||
    Number(confirmations)<2)throw A.error('SWAP_UNCONFIRMED_TRANSACTION');
 let spent=0n;
 for(const log of receipt.logs||[]){
   if(String(log.address).toLowerCase()!==POLYGON_USDC || String(log.topics?.[0]).toLowerCase()!==TRANSFER_TOPIC || log.topics.length!==3)continue;
   if(fromTopic(log.topics[1])===t)spent+=BigInt(log.data);
 }
 const expected=A.positive(expectedUsdcAtomic,'SWAP_USDC');
 if(spent!==expected)throw A.error('SWAP_USDC_PROOF_MISMATCH',{actual:spent.toString()});
 if(!trace||trace.error)throw A.error('SWAP_NATIVE_POL_TRACE_UNAVAILABLE');
 const flows=traceNativeFlows(trace,p);
 // A USDC-to-native-POL conversion must not spend other native POL from the destination.
 if(flows.outgoing!==0n)throw A.error('SWAP_POL_OUTGOING_VALUE_DETECTED');
 const received=flows.received;
 if(received!==A.positive(expectedPolWei,'SWAP_POL'))throw A.error('SWAP_POL_PROOF_MISMATCH',{actual:received.toString()});
 return {spentAtomic:spent.toString(),polWei:received.toString(),txHash:A.hash(tx.hash),block:Number(receipt.blockNumber),blockHash:String(receipt.blockHash).toLowerCase()};
}
async function verify({txHash,treasury,recipient,usdcAtomic,polWei},rpc){
 if(typeof rpc!=='string'||!/^https:\/\//.test(rpc))throw A.error('SWAP_RPC_NOT_CONFIGURED');
 const {JsonRpcProvider}=require('ethers');
 const provider=new JsonRpcProvider(rpc,137,{staticNetwork:true});
 const hash=A.hash(txHash);
 const [network,receipt,tx,head]=await Promise.all([provider.getNetwork(),provider.getTransactionReceipt(hash),provider.getTransaction(hash),provider.getBlockNumber()]);
 if(!receipt||!tx)throw A.error('SWAP_TX_NOT_FOUND');
 const block=await provider.getBlock(receipt.blockNumber);
 if(!block)throw A.error('SWAP_BLOCK_NOT_FOUND');
 let trace;
 try{trace=await provider.send('debug_traceTransaction',[hash,{tracer:'callTracer',timeout:'10s'}]);}
 catch(err){throw A.error('SWAP_NATIVE_POL_TRACE_UNAVAILABLE');}
 return assess({chainId:Number(network.chainId),receipt,tx,trace,treasury,recipient,expectedUsdcAtomic:usdcAtomic,expectedPolWei:polWei,confirmations:head-receipt.blockNumber+1,canonicalBlockHash:block.hash});
}
module.exports={assess,traceNativeTo,traceNativeFlows,verify};

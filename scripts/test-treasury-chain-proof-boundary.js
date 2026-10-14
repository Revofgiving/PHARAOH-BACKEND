'use strict';
const assert=require('node:assert/strict'),A=require('../economic-amounts');
const {createTreasuryChain}=require('../treasury-chain-adapter');
const {normalizeProof}=require('../economic-ledger');
const T='0x'+'1'.repeat(40),U='0x'+'2'.repeat(40),TOKEN='0x'+'3'.repeat(40),G='0x'+'4'.repeat(40),ZERO='0x'+'0'.repeat(40),H='0x'+'5'.repeat(64),B='0x'+'6'.repeat(64);
const cfg={token:TOKEN,chainId:'137',minConfirmations:'2',gemelliWallet:G};
function fixture(){
 const s={chainId:137n,head:101,block:{hash:B,timestamp:1000},receipt:{hash:H,status:1,blockNumber:100,blockHash:B,logs:[{address:TOKEN,index:7,parsed:{name:'Transfer',args:{from:T,to:U,value:100000000n}}}]},balances:new Map([[T,500000000n],[U,100000000n]])};
 const provider={getNetwork:async()=>({chainId:s.chainId}),getBlockNumber:async()=>s.head,getBlock:async()=>s.block,getTransactionReceipt:async()=>s.receipt,getTransaction:async()=>null};
 const ethers={Interface:class{parseLog(l){if(!l.parsed)throw Error('unrecognized');return l.parsed;}},Contract:class{async balanceOf(w){return s.balances.get(w)||0n;}}};
 const chain=createTreasuryChain(cfg,{provider,ethers});
 const m={tx_hash:H,source_wallet:T,destination_wallet:U,amount_atomic:'100000000',created_at:new Date(900000).toISOString(),signed_raw_tx:null};
 return {s,chain,m};
}
async function main(){let cases=0,f=fixture();
 let v=await f.chain.verify(f.m);assert.equal(v.valida,true);assert.deepEqual(v.proof.transferLogIndexes,[7]);assert.equal(v.proof.confirmations,'2');normalizeProof(v,{from:T,to:U,amountAtomic:100000000n,txHash:H},cfg);cases++;
 f=fixture();f.s.receipt=null;assert.equal(await f.chain.verify(f.m),null);cases++;
 f=fixture();f.s.chainId=1n;await assert.rejects(f.chain.verify(f.m),/WRONG_CHAIN/);cases++;
 f=fixture();f.s.receipt.status=0;await assert.rejects(f.chain.verify(f.m),/REVERTED/);cases++;
 f=fixture();f.s.receipt.hash=B;await assert.rejects(f.chain.verify(f.m),/RECEIPT_HASH/);cases++;
 f=fixture();f.s.head=100;assert.equal(await f.chain.verify(f.m),null);cases++;
 f=fixture();f.s.block.hash=H;await assert.rejects(f.chain.verify(f.m),/REORG/);cases++;
 f=fixture();f.s.block.timestamp=899;await assert.rejects(f.chain.verify(f.m),/PREDATES_RESERVATION/);cases++;
 f=fixture();f.m.created_at='bad date';await assert.rejects(f.chain.verify(f.m),/PREDATES_RESERVATION/);cases++;
 f=fixture();f.s.receipt.logs[0].address=G;await assert.rejects(f.chain.verify(f.m),/LOG_MISMATCH/);cases++;
 f=fixture();f.s.receipt.logs[0].parsed.args.to=G;await assert.rejects(f.chain.verify(f.m),/LOG_MISMATCH/);cases++;
 f=fixture();f.s.receipt.logs[0].parsed.args.value=99000000n;await assert.rejects(f.chain.verify(f.m),/LOG_MISMATCH/);cases++;
 f=fixture();f.s.receipt.logs.push({address:TOKEN,index:8,parsed:{name:'Transfer',args:{from:ZERO,to:G,value:123n}}});assert.equal((await f.chain.verify(f.m)).valida,true);cases++;
 f=fixture();f.s.receipt.logs[0].parsed.args.value=40000000n;f.s.receipt.logs.push({address:TOKEN,index:9,parsed:{name:'Transfer',args:{from:T,to:U,value:60000000n}}});assert.deepEqual((await f.chain.verify(f.m)).proof.transferLogIndexes,[7,9]);cases++;
 f=fixture();f.s.receipt.logs[0].index=undefined;v=await f.chain.verify(f.m);assert.throws(()=>normalizeProof(v,{from:T,to:U,amountAtomic:100000000n,txHash:H},cfg),/LOGS_INVALID/);cases++;
 f=fixture();const b=await f.chain.balances(f.m);assert.equal(b.blockNumber,100n);assert.equal(b.sourceAtomic,500000000n);cases++;
 console.log(JSON.stringify({test:'treasury-chain-proof-boundary',status:'PASS',cases,scope:'real verification control flow with RPC/ethers parse doubles; NO ABI decoding, signing, cryptography or live chain certification'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
// Real notification function and HMAC, with transport-only test doubles.
// No PostgreSQL, ABI implementation or external receiver is substituted as proof.
const assert=require('node:assert/strict');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){
 if(parent?.filename?.endsWith('cross-outbound-manager.js')){
  if(request==='ethers')return {ethers:{}};
  if(request==='./pg-connection-manager')return {};
  if(request==='./pharaoh-registry-manager')return {};
 }
 return originalLoad.call(this,request,parent,isMain);
};
const outbound=require('../cross-outbound-manager');Module._load=originalLoad;
const T='0x'+'1'.repeat(40),R='0x'+'2'.repeat(40),U='0x'+'3'.repeat(40),B='0x'+'4'.repeat(40);
const H='0x'+'a'.repeat(64),E='PHARAOH:RHA:TEST:1';
process.env.NODE_ENV='test';process.env.CROSS_PLATFORM_SECRET='cross-test-secret-not-production-000000';
function input(target='URANUS'){
 return {cfg:{target,sourceWallet:T,destinationWallet:target==='ROG'?R:U,receiverUrl:'http://127.0.0.1/fixture'},row:{event_key:`${E}:PHARAOH_TO_${target}`,rha_event_key:E,beneficiary_wallet:B,payment_tx_hash:H,amount_usdc:target==='ROG'?300:200,positions_expected:target==='ROG'?150:10,rog_register_tx_hash:'0x'+'b'.repeat(64),rog_donation_id:'1'}};
}
function transport(body,status=200){return async()=>({ok:status>=200&&status<300,status,json:async()=>body});}
async function code(promise,expected){await assert.rejects(promise,e=>e.code===expected);}
async function run(){let cases=0;const {row,cfg}=input();
 await code(outbound._notifyTarget(row,cfg,transport({success:true,status:'PROCESSING'})),'CROSS_OUTBOUND_REMOTE_PENDING');cases++;
 await code(outbound._notifyTarget(row,cfg,transport({success:true})),'CROSS_OUTBOUND_COMPLETION_UNPROVEN');cases++;
 await code(outbound._notifyTarget(row,cfg,transport({success:true,status:'COMPLETED',event_key:'ANOTHER_EVENT'})),'CROSS_OUTBOUND_REMOTE_IDENTITY_MISMATCH');cases++;
 await code(outbound._notifyTarget(row,cfg,transport({success:true,status:'COMPLETED',payment_tx_hash:'0x'+'c'.repeat(64)})),'CROSS_OUTBOUND_REMOTE_IDENTITY_MISMATCH');cases++;
 await code(outbound._notifyTarget(row,cfg,transport({success:true,status:'COMPLETED',num_ingressi:20})),'CROSS_OUTBOUND_REMOTE_COUNT_MISMATCH');cases++;
 await code(outbound._notifyTarget(row,cfg,transport({success:true,status:'COMPLETED',importo_totale:201})),'CROSS_OUTBOUND_REMOTE_AMOUNT_MISMATCH');cases++;
 await code(outbound._notifyTarget(row,cfg,transport({success:true,status:'COMPLETED',beneficiaryWallet:T})),'CROSS_OUTBOUND_REMOTE_OWNER_MISMATCH');cases++;
 await code(outbound._notifyTarget(row,cfg,transport({success:true,status:'COMPLETED',positionsOwnerWallet:T})),'CROSS_OUTBOUND_REMOTE_OWNER_MISMATCH');cases++;
 await code(outbound._notifyTarget(row,cfg,transport({success:true,status:'COMPLETED',num_ingressi:[]})),'CROSS_OUTBOUND_REMOTE_COUNT_MISMATCH');cases++;
 let options;const accepted=await outbound._notifyTarget(row,cfg,async(_url,opt)=>{options=opt;return {ok:true,status:200,json:async()=>({success:true,status:'COMPLETED',event_key:row.event_key,payment_tx_hash:H,beneficiaryWallet:B,num_ingressi:10,importo_totale:200})};});
 assert.equal(accepted.status,'COMPLETED');assert.equal(options.redirect,'error');cases++;
 let network;try{await outbound._notifyTarget(row,cfg,async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}});});}catch(e){network=e;}
 assert.equal(network.code,'CROSS_OUTBOUND_NOTIFY_FAILED');assert.equal(network.retryable,true);cases++;
 await assert.rejects(outbound._notifyTarget(row,cfg,transport({success:false},503)),e=>e.retryable===true);cases++;
 await assert.rejects(outbound._notifyTarget(row,cfg,transport({success:false},409)),e=>e.retryable===false);cases++;
 await code(outbound._notifyTarget(row,cfg,async()=>({ok:true,status:200,redirected:true,json:async()=>({success:true,status:'COMPLETED'})})),'CROSS_OUTBOUND_REDIRECT_FORBIDDEN');cases++;
 for(const value of ['0','-1','NaN','999999999999']){process.env.CROSS_OUTBOUND_TIMEOUT_MS=value;await code(outbound._notifyTarget(row,cfg,transport({success:true,status:'COMPLETED'})),'CROSS_OUTBOUND_TIMEOUT_INVALID');cases++;}delete process.env.CROSS_OUTBOUND_TIMEOUT_MS;
 const rog=input('ROG');const receipt={success:true,status:'COMPLETED',donation_id:'1',beneficiaryWallet:B,positionsOwnerWallet:B,rgxOwnerWallet:T,rgxMinted:150};
 await outbound._notifyTarget(rog.row,rog.cfg,transport(receipt));cases++;
 for(const change of [{positionsOwnerWallet:T},{rgxOwnerWallet:B},{rgxMinted:149},{donation_id:'2'}]){await code(outbound._notifyTarget(rog.row,rog.cfg,transport({...receipt,...change})),'CROSS_OUTBOUND_ROG_POSTCONDITION_FAILED');cases++;}
 console.log(JSON.stringify({status:'PASS',test:'cross-notify-boundary',cases,scope:'real sender acknowledgement checks/HMAC, transport fixtures; NOT actual receiver materialization'}));
}
run().catch(e=>{console.error(e);process.exitCode=1;});

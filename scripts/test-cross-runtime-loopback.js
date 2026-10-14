'use strict';
/** Actual sender scheduling, reserves, dispatcher and HTTP/HMAC on loopback.
 * PostgreSQL, ABI decoding, chain settlement and BOTH RECEIVERS are explicit
 * test doubles. This is not certification of the deployed ROG/URANUS backends.
 */
const assert=require('node:assert/strict'),http=require('node:http'),Module=require('node:module');
const A=require('../economic-amounts'),{EconomicLedger}=require('../economic-ledger');
const {EconomicFlow}=require('../economic-flow'),{TransferDispatcher}=require('../treasury-transfer-manager');
const {MemoryHarness,MemoryEconomicStore}=require('./support/economic-memory-store');
const auth=require('../cross-platform-auth');
const addr=n=>'0x'+String(n).repeat(40),hash=n=>'0x'+String(n).padStart(64,'0');
const T=addr(1),R=addr(2),U=addr(3),B=addr(4),G=addr(5),P=addr(6),TOKEN=addr(7),RC=addr(8);
const cfg={treasuryWallet:T,gemelliWallet:G,projectsWallet:P,fundAWallet:B,token:TOKEN,chainId:'137',minConfirmations:2};
Object.assign(process.env,{NODE_ENV:'test',PHARAOH_TREASURY_WALLET:T,ROG_TREASURY_WALLET:R,URANUS_TREASURY_WALLET:U,USDC_CONTRACT_ADDRESS:TOKEN,ROG_CONTRACT_ADDRESS:RC,POLYGON_MIN_CONFIRMATIONS:'2',ROG_CROSS_PLATFORM_SECRET:'r'.repeat(40),URANUS_CROSS_PLATFORM_SECRET:'u'.repeat(40)});
const calls={registry:0,rogRegister:0,signs:0,broadcasts:0,http:0},h=new MemoryHarness();
const operations=new Map(),allocations=new Map(),remote=new Map(),signed=new Map(),rogReceipts=new Map(),settled=new Map();
let serial=100,rogId=0,mode='NORMAL';
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){
 if(parent?.filename?.endsWith('cross-outbound-manager.js')){
  if(request==='ethers')return {ethers:{parseUnits:s=>A.usdc(s),Interface:class{parseLog(log){return log.parsed;}}}};
  if(request==='./pg-connection-manager')return {};
  if(request==='./economic-ledger')return {configuredLedger:()=>new EconomicLedger(new MemoryEconomicStore(h),cfg)};
  if(request==='./pharaoh-registry-manager')return {async registerCrossOutgoing({onSubmitted}){calls.registry++;const txHash=hash(++serial);await onSubmitted(txHash);return {txHash,txId:serial,blockNumber:10};}};
 }
 return originalLoad.call(this,request,parent,isMain);
};
const outbound=require('../cross-outbound-manager');
const clone=x=>structuredClone(x);
const client={release(){},async query(sql,p=[]){const q=sql.replace(/\s+/g,' ').trim(),row=operations.get(p[0]);
 if(q.startsWith('SELECT pg_advisory_'))return {rows:[]};
 if(q.startsWith('INSERT INTO rha_exit_allocations')){if(!allocations.has(p[0]))allocations.set(p[0],{rha_event_key:p[0],beneficiary_wallet:p[1],account_id:p[2],account_sigla:p[3],turno:p[4],protocol_version:p[5],rog_usdc:300,uranus_usdc:200,repayable:false});return {rows:[]};}
 if(q.startsWith('SELECT * FROM rha_exit_allocations'))return {rows:allocations.has(p[0])?[clone(allocations.get(p[0]))]:[]};
 if(q.startsWith('INSERT INTO cross_outbound_operations')){if(!row)operations.set(p[0],{event_key:p[0],rha_event_key:p[1],target_platform:p[2],source_wallet:p[3],beneficiary_wallet:p[4],account_id:p[5],account_sigla:p[6],destination_wallet:p[7],amount_usdc:p[8],positions_expected:p[9],protocol_version:p[10],status:'PENDING'});return {rows:[]};}
 if(q.startsWith('SELECT * FROM cross_outbound_operations'))return {rows:row?[clone(row)]:[]};
 if(q.startsWith('UPDATE cross_outbound_operations')){
  assert(row,'fixture operation exists');
  if(q.includes('SET payment_tx_hash=$2'))Object.assign(row,{payment_tx_hash:p[1],status:p[2],blockchain_proof:JSON.parse(p[3])});
  else if(q.includes('SET registry_tx_hash=$2')){row.registry_tx_hash=p[1];if(q.includes('registry_tx_id=$3'))Object.assign(row,{registry_tx_id:p[2],registry_block_number:p[3],registry_confirmed_at:'fixture'});}
  else if(q.includes('SET rog_register_nonce=$2'))row.rog_register_nonce=p[1];
  else if(q.includes('SET rog_register_tx_hash=$2'))row.rog_register_tx_hash=p[1];
  else if(q.includes('SET rog_donation_id=$2'))Object.assign(row,{rog_donation_id:p[1],rog_register_proof:JSON.parse(p[2]),rog_register_confirmed_at:'fixture'});
  else if(q.includes("SET status='COMPLETED'"))Object.assign(row,{status:'COMPLETED',notify_response:JSON.parse(p[1]),last_error:null});
  else if(q.includes('SET status=$2'))Object.assign(row,{status:p[1],last_error:p[2]});
  else throw new Error('Unexpected UPDATE in fixture: '+q);
  return {rows:[clone(row)]};
 }
 throw new Error('Unexpected SQL in fixture: '+q);
}};
let tail=Promise.resolve();
const repo={transaction:fn=>h.transaction(async store=>clone(await fn({ledger:new EconomicLedger(store,cfg),store}))),async withSignerLock(fn){const old=tail;let done;tail=new Promise(r=>done=r);await old;try{return await fn();}finally{done();}}};
const chain={async balances(){return {sourceAtomic:A.usdc('1000000'),destinationAtomic:0n};},async sign(m){calls.signs++;const txHash=hash(++serial),raw='0x'+serial.toString(16).padStart(4,'0');signed.set(raw,{...clone(m),txHash});return {txHash,raw,nonce:serial,chainId:'137',token:TOKEN};},async preflightSigned(){},async knownTransaction(txHash){return settled.has(txHash);},async broadcast(raw){calls.broadcasts++;const m=signed.get(raw),saved=h.data.movements.get(m.movement_key);assert.equal(saved.status,'SUBMITTED');assert(saved.broadcast_attempted_at);assert.equal(saved.signed_raw_tx,raw);settled.set(m.txHash,m);return {hash:m.txHash};},async verify(m){return settled.has(m.tx_hash)?{valida:true,proof:{txHash:m.tx_hash,from:m.source_wallet,to:m.destination_wallet,amountBaseUnits:m.amount_atomic,chainId:'137',tokenContract:TOKEN,blockNumber:'10',blockHash:hash(999),confirmations:'10',transferLogIndexes:[0]}}:null;}};
const provider={async getNetwork(){return {chainId:137n};},async getTransactionCount(){return ++serial;},async getBlockNumber(){return 20;},async getTransactionReceipt(txHash){return rogReceipts.get(txHash)||null;}};
const rogContract={async registerDonation(amount){calls.rogRegister++;const txHash=hash(++serial);const receipt={status:1,from:T,blockNumber:10,blockHash:hash(998),logs:[{address:RC,parsed:{name:'DonationRegistered',args:{donor:T,amount,donationId:BigInt(++rogId)}}}]};rogReceipts.set(txHash,receipt);return {hash:txHash,async wait(){return receipt;}};}};
const dispatcher=new TransferDispatcher({repository:repo,chain,config:cfg});
const deps={pg:{async getClient(){return client;}},provider,dispatcher,signer:{async getAddress(){return T;}},rogContract};
function seed(key,wallet,purpose,amount){h.data.buckets.set(key,{bucket_key:key,wallet,purpose,balance_atomic:A.usdc(amount).toString(),metadata:{}});}
async function receiver(req,res){try{
 calls.http++;let data='';for await(const chunk of req){data+=chunk;if(data.length>10000)throw Error('fixture size limit');}const body=JSON.parse(data),target=req.url==='/rog'?'ROG':'URANUS';
 assert.equal(req.headers['x-platform-origin'],'PHARAOH');assert.equal(req.headers['x-platform-signature'],auth.signBody(body,target));
 assert.equal(body.wallet_origine,T);assert.equal(body.wallet_beneficiario,B);assert.equal(body.wallet_cassa,target==='ROG'?R:U);assert.equal(body.importo_totale,target==='ROG'?300:200);assert.equal(body.num_ingressi,target==='ROG'?150:10);
 // Deterministic peer MODEL, not the ROG/URANUS source. State keyed by event.
 const prior=remote.get(body.event_key);if(prior)assert.equal(prior.fingerprint,A.digest(body));
 else remote.set(body.event_key,{fingerprint:A.digest(body),human:body.num_ingressi,system:body.num_ingressi,rgx:target==='ROG'?150:0,beneficiary:B,rgxOwner:target==='ROG'?T:null});
 if(mode==='DROP_AFTER_COMMIT'){mode='NORMAL';req.socket.destroy();return;}
 let ack={success:true,status:mode==='PENDING'?'PROCESSING':'COMPLETED',event_key:body.event_key,payment_tx_hash:body.payment_tx_hash,importo_totale:body.importo_totale,num_ingressi:body.num_ingressi,beneficiaryWallet:B,positionsOwnerWallet:B};
 if(target==='ROG')Object.assign(ack,{donation_id:body.donation_id,rgxOwnerWallet:T,rgxMinted:150});
 if(mode==='WRONG_OWNER')ack.positionsOwnerWallet=T;
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(ack));
}catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,error:error.message}));}}
async function main(){let cases=0;const server=http.createServer(receiver);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;process.env.ROG_CROSS_INGRESS_URL=base+'/rog';process.env.URANUS_CROSS_INGRESS_URL=base+'/uranus';
 try{
 for(const [i,type] of ['PRIMARIO','GEMELLO','PERPETUO'].entries()){
  const turn=i+1,event=`LOOPBACK:RHA:${turn}`,account={id:String(9000+turn),tipo:type,wallet:B,sigla:`fixture-${turn}`};
  h.data.accounts.set(account.id,account);h.data.economics.set(account.id,{account_id:account.id,root_account_id:account.id,position_class:'HUMAN',owner_wallet:B,custody_wallet:B,origin:'FIXTURE',source_event_key:event});
  seed(`B1_TURN:${turn}`,T,'B1_TURN','9000');seed(`GEMELLI:RESERVE:${turn}`,G,'GEMELLI_RESERVE','500');
  await h.transaction(async store=>{const ledger=new EconomicLedger(store,cfg),flow=new EconomicFlow({ledger,config:cfg});await flow.planExit({level:'RHA',eventKey:event,account,turn:{id:turn,numero_turno:turn,sacerdoti_entrati:turn===1?18:13,sacerdoti_necessari:turn===1?18:13}});await outbound.scheduleRhaExit({rhaEventKey:event,beneficiaryWallet:B,accountId:account.id,accountSigla:account.sigla,turno:turn},client);});cases++;
  const rog=event+':PHARAOH_TO_ROG',uranus=event+':PHARAOH_TO_URANUS';
  if(turn===1){mode='DROP_AFTER_COMMIT';await assert.rejects(outbound.processOperation(rog,deps),e=>e.retryable===true);assert.equal(operations.get(rog).status,'NOTIFY_PENDING');assert.equal(remote.get(rog).human,150);cases++;}
  const before=calls.broadcasts;assert.equal((await outbound.processOperation(rog,deps)).operation.status,'COMPLETED');if(turn===1)assert.equal(calls.broadcasts,before);cases++;
  if(turn===2){mode='PENDING';await assert.rejects(outbound.processOperation(uranus,deps),e=>e.code==='CROSS_OUTBOUND_REMOTE_PENDING');assert.equal(operations.get(uranus).status,'NOTIFY_PENDING');mode='NORMAL';cases++;}
  if(turn===3){mode='WRONG_OWNER';await assert.rejects(outbound.processOperation(uranus,deps),e=>e.code==='CROSS_OUTBOUND_REMOTE_OWNER_MISMATCH');assert.equal(operations.get(uranus).status,'RECONCILIATION_REQUIRED');mode='NORMAL';cases++;}
  assert.equal((await outbound.processOperation(uranus,deps)).operation.status,'COMPLETED');cases++;
  const stable=clone(calls);assert.equal((await outbound.processOperation(rog,deps)).idempotent,true);assert.equal((await outbound.processOperation(uranus,deps)).idempotent,true);assert.deepEqual(calls,stable);cases++;
 }
 assert.equal(remote.size,6);assert.equal(calls.signs,6);assert.equal(calls.broadcasts,6);assert.equal(calls.rogRegister,3);assert.equal(calls.registry,6);cases++;
 assert.equal([...remote.values()].reduce((n,x)=>n+x.human,0),480);assert.equal([...remote.values()].reduce((n,x)=>n+x.system,0),480);assert.equal([...remote.values()].reduce((n,x)=>n+x.rgx,0),450);cases++;
 assert.equal([...h.data.movements.values()].filter(m=>m.movement_key.startsWith('CROSS:')&&m.status==='CONFIRMED').length,6);cases++;
 console.log(JSON.stringify({test:'cross-runtime-loopback',status:'PASS',cases,calls,fixtureResults:{rhaExits:3,rogHuman:450,rogPiletta:450,rogRgx:450,uranusHuman:30,uranusCassa:30},scope:'actual EconomicFlow/outbound/ledger/dispatcher/loopback HTTP/HMAC; memory SQL adapter, synthetic ABI/chain and MODEL receivers; NOT native PostgreSQL or real receiver E2E'}));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));Module._load=originalLoad;}
}
main().catch(e=>{Module._load=originalLoad;console.error(e);process.exitCode=1;});

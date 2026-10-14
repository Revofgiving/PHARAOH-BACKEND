'use strict';
const assert=require('node:assert/strict');
const A=require('../economic-amounts');
const {EconomicLedger}=require('../economic-ledger');
const {EconomicFlow,exitKeys}=require('../economic-flow');
const {S0Materializer}=require('../s0-materializer');
const {MemoryHarness,memoryPlacement}=require('./support/economic-memory-store');
const T='0x'+'1'.repeat(40),G='0x'+'2'.repeat(40),P='0x'+'3'.repeat(40),U='0x'+'4'.repeat(40),F='0x'+'5'.repeat(40),TOKEN='0x'+'6'.repeat(40);
const cfg={treasuryWallet:T,gemelliWallet:G,projectsWallet:P,fundAWallet:F,token:TOKEN,chainId:'137',minConfirmations:2};
const hash=n=>'0x'+String(n).padStart(64,'0');
function seed(h,key,wallet,purpose,usdc){h.data.buckets.set(key,{bucket_key:key,wallet,purpose,metadata:{},balance_atomic:A.usdc(usdc).toString()});}
function account(h,id,type='GEMELLO',cls='HUMAN') {const owner=cls==='PILETTA'?null:cls==='FONDO_A'?F:U,custody=owner||T;
 const a={id:String(id),tipo:type,wallet:custody,sigla:'fixture'};h.data.accounts.set(a.id,a);h.data.economics.set(a.id,{account_id:a.id,root_account_id:a.id,position_class:cls,owner_wallet:owner,custody_wallet:custody,origin:'FIXTURE',source_event_key:'FIXTURE'});return a;
}
function run(h,fn){return h.transaction(store=>{const ledger=new EconomicLedger(store,cfg);const flow=new EconomicFlow({ledger,config:cfg,materializer:new S0Materializer({ledger,placement:memoryPlacement(h),config:cfg})});return fn(flow,ledger,store);});}
async function settle(h,key,n){const m=h.data.movements.get(key);return run(h,(_,l)=>l.settleMovement({movementKey:key,verification:{valida:true,proof:{txHash:hash(n),from:m.source_wallet,to:m.destination_wallet,amountBaseUnits:m.amount_atomic,chainId:'137',tokenContract:TOKEN,blockNumber:'100',blockHash:hash(800),confirmations:'10',transferLogIndexes:[0]}}}));}
async function main(){let cases=0;
 let h=new MemoryHarness();seed(h,'S0_TABLE:1',T,'S0_TABLE','600');let a=account(h,9000,'FONDO','FONDO_A');
 const first={tableId:1,tableNumber:1,heir:a,turnNumber:1};
 assert.equal((await run(h,f=>f.prepareEntryCompletion(first))).ready,false);assert.equal(h.data.movements.size,2);assert.equal(h.data.buckets.get('S0_TABLE:1').balance_atomic,'0');cases++;
 await assert.rejects(run(h,f=>f.assertProjectsCapital()),/STRUCTURAL_CAPITAL_REQUIRED/);cases++;
 await settle(h,'BOOTSTRAP:GEMELLI',1);await settle(h,'BOOTSTRAP:PROJECTS',2);assert.equal((await run(h,f=>f.prepareEntryCompletion(first))).ready,true);assert.equal(h.data.movements.size,2);assert.equal(h.data.buckets.get('PROJECTS:STRUCTURAL_CAPITAL').balance_atomic,A.usdc('100').toString());cases++;
 const before=structuredClone(h.data);await run(h,f=>f.prepareEntryCompletion(first));assert.deepEqual(h.data,before);cases++;
 seed(h,'B1_TURN:1',T,'B1_TURN','9000');const turn={id:1,numero_turno:1,sacerdoti_entrati:18,sacerdoti_necessari:18};
 const rha=await run(h,f=>f.planExit({level:'RHA',eventKey:'RHA:1',turn,account:a}));
 assert.equal(rha.netAtomic,6000000000n);assert.equal(rha.beneficiaryWallet,F);assert.equal(h.data.buckets.get('B1_TURN:1').balance_atomic,'0');assert.equal(h.data.movements.get('GEMELLI_NEXT:1').depends_on,'GEMELLI_RETURN:1');cases++;
 await assert.rejects(run(h,f=>f.fundFunctions({turnId:2,turnNumber:2})),/FUNDING_MISSING/);cases++;
 await settle(h,'GEMELLI_RETURN:1',3);await settle(h,'GEMELLI_NEXT:1',4);await run(h,f=>f.fundFunctions({turnId:2,turnNumber:2}));assert.equal(h.data.buckets.get('B1_TURN:2').balance_atomic,A.usdc('2500').toString());assert.equal(h.data.buckets.get('GEMELLI:RESERVE:2').balance_atomic,A.usdc('500').toString());cases++;
 for(let i=1;i<=13;i++){seed(h,`PRIEST:${i+1}`,T,'PRIEST','500');h.data.buckets.get(`PRIEST:${i+1}`).metadata={heirAccountId:String(100+i)};await run(h,f=>f.fundPriest({accountId:100+i,turnId:2,fundingBucket:`PRIEST:${i+1}`}));}
 assert.equal(h.data.buckets.get('B1_TURN:2').balance_atomic,A.usdc('9000').toString());cases++;
 a=account(h,9001,'PERPETUO');const next=await run(h,f=>f.planExit({level:'RHA',eventKey:'RHA:2',turn:{id:2,numero_turno:2,sacerdoti_entrati:13,sacerdoti_necessari:13},account:a}));
 assert.equal(next.netAtomic,A.usdc('1000'));assert.equal(h.data.movements.get('GEMELLI_RETURN:2').purpose,'CONTINUITY_IN');assert.equal(h.data.buckets.get('PROGRESSION:9001:L4').balance_atomic,A.usdc('5000').toString());assert.equal(h.data.buckets.get(next.keys.ROG).balance_atomic,A.usdc('300').toString());assert.equal(h.data.buckets.get(next.keys.URANUS).balance_atomic,A.usdc('200').toString());cases++;
 await run(h,f=>f.fundSecondaryEntry({accountId:9001,turnId:100,level:4}));assert.equal(h.data.buckets.get('L4_TURN:100').balance_atomic,A.usdc('5000').toString());cases++;
 for(const [level,total,netAmount,quota,pass] of [['THOT','15000','4000','500','10000'],['ISIDE','30000','25000','5000',null]]){
  const hx=new MemoryHarness({human:30n}),ax=account(hx,9000);seed(hx,level==='THOT'?'L4_TURN:77':'L5_TURN:77',T,'TURN',total);
  const exit=await run(hx,f=>f.planExit({level,eventKey:`${level}:77`,turn:{id:77,numero_turno:1,sacerdoti_entrati:3,sacerdoti_necessari:3},account:ax}));assert.equal(exit.netAtomic,A.usdc(netAmount));
  if(pass)assert.equal(hx.data.buckets.get('PROGRESSION:9000:L5').balance_atomic,A.usdc(pass).toString());
  assert.equal(hx.data.buckets.get(exit.keys.GENERATED).balance_atomic,A.usdc(quota).toString());
  const roots=await run(hx,f=>f.materializeQuota({eventKey:`${level}:77`,source:level,accountId:9000}));
  assert.equal(roots.positions.length,level==='THOT'?5:50);assert.equal(roots.positions.filter(p=>p.positionClass==='PILETTA').length,level==='THOT'?5:30);
  assert.equal(hx.data.counters.human_cumulative,'30');assert(roots.positions.every(p=>p.ownerWallet===null||p.ownerWallet===F));cases++;
  const snapshot=structuredClone(hx.data);await run(hx,f=>f.materializeQuota({eventKey:`${level}:77`,source:level,accountId:9000}));assert.deepEqual(hx.data,snapshot);cases++;
 }
 h=new MemoryHarness({human:20n});a=account(h,9000,'GEMELLO','PILETTA');seed(h,'L4_TURN:1',T,'TURN','15000');
 const px=await run(h,f=>f.planExit({level:'THOT',eventKey:'P:THOT:1',turn:{id:1,numero_turno:1,sacerdoti_entrati:3,sacerdoti_necessari:3},account:a}));assert.equal(px.cashPayoutAtomic,0n);
 await run(h,f=>f.materializeQuota({eventKey:'P:THOT:1',source:'THOT',accountId:9000}));await run(h,f=>f.reinvestNet(px));assert.equal(h.data.positions.length,45);assert.equal(h.data.counters.human_cumulative,'20');assert.equal(h.data.counters.piletta_cumulative,'20');assert.equal(h.data.positions.filter(p=>h.data.economics.get(p.accountId)?.position_class==='FONDO_A').length,25);cases++;
 h=new MemoryHarness();h.data.activation.mode='ADOPTED';seed(h,'S0_TABLE:1',T,'S0_TABLE','600');a=account(h,9000,'FONDO','FONDO_A');await assert.rejects(run(h,f=>f.prepareEntryCompletion({...first,heir:a})),/HISTORICAL_BOOTSTRAP/);assert.equal(h.data.movements.size,0);cases++;
 h=new MemoryHarness();a=account(h,9000);seed(h,'B1_TURN:1',T,'B1_TURN','9500');seed(h,'GEMELLI:RESERVE:1',G,'GEMELLI_RESERVE','500');await assert.rejects(run(h,f=>f.planExit({level:'RHA',eventKey:'EXCESS',turn,account:a})),/EXACT_FUNDING/);assert.equal(h.data.events.size,0);cases++;
 h=new MemoryHarness();a=account(h,9000);seed(h,'B1_TURN:1',T,'B1_TURN','9000');seed(h,'GEMELLI:RESERVE:1',G,'GEMELLI_RESERVE','500');await assert.rejects(run(h,f=>f.planExit({level:'RHA',eventKey:'MISSING_PRIEST',turn:{...turn,sacerdoti_entrati:17},account:a})),/CONTRIBUTORS_INCOMPLETE/);cases++;
 // The entire plan + root materialization rolls back on a bad source account.
 const snapshot=structuredClone(h.data);await assert.rejects(run(h,f=>f.materializeQuota({eventKey:'UNALLOCATED',source:'THOT',accountId:9000})),/ALLOCATION_REQUIRED/);assert.deepEqual(h.data,snapshot);cases++;
 console.log(JSON.stringify({test:'economic-progression-runtime',status:'PASS',cases,scope:'actual economic flow/ledger/materializer, funded fixtures and memory placement; NOT a full PostgreSQL multi-turn simulation'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

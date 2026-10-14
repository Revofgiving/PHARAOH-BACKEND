'use strict';
/** Funded economic multi-turn MODEL. Uses the actual ledger, EconomicFlow,
 * materializer and inheritance. Table placement, heir choice and settlement
 * proofs are synthetic. NOT a full replay of donation-flow-manager/PostgreSQL
 * or the receiver source. No 9000/15000/30000 reserve is conjured into existence.
 */
const assert=require('node:assert/strict');
const A=require('../economic-amounts'),{EconomicLedger}=require('../economic-ledger');
const {EconomicFlow}=require('../economic-flow'),{S0Materializer}=require('../s0-materializer');
const {MemoryHarness,memoryPlacement}=require('./support/economic-memory-store');
const wallet=n=>'0x'+Number(n).toString(16).padStart(40,'0'),hash=n=>'0x'+Number(n).toString(16).padStart(64,'0');
const T=wallet(1001),G=wallet(1002),P=wallet(1003),F=wallet(1004),TOKEN=wallet(1005),R=wallet(1006),U=wallet(1007),PAYER=wallet(1008);
const cfg={treasuryWallet:T,gemelliWallet:G,projectsWallet:P,fundAWallet:F,token:TOKEN,chainId:'137',minConfirmations:2};
const h=new MemoryHarness();Object.assign(h.data,{nextTable:1,nextNumber:2,currentSlots:0});
const simulatedBalances=new Map([[T,0n],[G,0n],[P,0n]]);let serial=100,external=0n,externalPaid=0n,crossRog=0n,crossUranus=0n,ordinaryNet=0n,cases=0;
const gemelliStates=[];
const run=fn=>h.transaction(store=>{const ledger=new EconomicLedger(store,cfg),flow=new EconomicFlow({ledger,config:cfg,materializer:new S0Materializer({ledger,placement:memoryPlacement(h),config:cfg})});return fn(flow,ledger,store);});
function verification(txHash,from,to,amount){return {valida:true,proof:{txHash,from,to,amountBaseUnits:amount.toString(),tokenContract:TOKEN,chainId:'137',blockNumber:'10000',blockHash:hash(900000),confirmations:10,transferLogIndexes:[0]}};}
async function conservation(){await run(async(_,ledger,store)=>{for(const w of [T,G,P])assert.equal(BigInt((await store.reserved(w)).atomic),simulatedBalances.get(w),'all simulated settled funds must remain accounted');assert.equal(simulatedBalances.get(T)+simulatedBalances.get(G)+simulatedBalances.get(P)+externalPaid,external);const b=await store.bucket('PROJECTS:STRUCTURAL_CAPITAL');if(b)assert.equal(b.balance_atomic,A.usdc('100').toString());});cases++;}
async function settle(key){const m=h.data.movements.get(key);assert(m);if(['CONFIRMED','REGISTERED'].includes(m.status))return;const amount=BigInt(m.amount_atomic);assert(simulatedBalances.get(m.source_wallet)>=amount);await run((_,ledger)=>ledger.settleMovement({movementKey:key,verification:verification(hash(++serial),m.source_wallet,m.destination_wallet,amount)}));simulatedBalances.set(m.source_wallet,simulatedBalances.get(m.source_wallet)-amount);if(simulatedBalances.has(m.destination_wallet))simulatedBalances.set(m.destination_wallet,simulatedBalances.get(m.destination_wallet)+amount);else externalPaid+=amount;if(m.destination_wallet===R)crossRog+=amount;if(m.destination_wallet===U)crossUranus+=amount;if(m.purpose==='QA_NET')ordinaryNet+=amount;if(m.source_wallet===G||m.destination_wallet===G){const b=simulatedBalances.get(G);assert(b===0n||b===A.usdc('500'));gemelliStates.push(A.decimal(b));}await conservation();}
async function externalBatch(count){const txHash=hash(++serial),amount=A.usdc(String(100*count)),owner=wallet(1+(serial%13));const result=await run(flow=>flow.admitExternal({eventKey:'MODEL_EXTERNAL:'+serial,origin:'URANUS',payer:PAYER,beneficiaryWallet:owner,count,txHash,proof:verification(txHash,PAYER,T,amount).proof}));external+=amount;simulatedBalances.set(T,simulatedBalances.get(T)+amount);assert.equal(result.positions.length,count);return result;}
async function netAndCross(exit){const requests=[{key:exit.keys.NET,to:exit.beneficiaryWallet,amount:exit.cashPayoutAtomic,purpose:'QA_NET'}];if(exit.level==='RHA')requests.push({key:exit.keys.ROG,to:R,amount:A.usdc('300'),purpose:'QA_ROG'},{key:exit.keys.URANUS,to:U,amount:A.usdc('200'),purpose:'QA_URANUS'});for(const r of requests){await run((_,l)=>l.prepareMovement({key:'MODEL_PAY:'+r.key,reserveBucket:r.key,to:r.to,amountAtomic:r.amount,purpose:r.purpose}));await settle('MODEL_PAY:'+r.key);}}
async function main(){
 const founder={id:'9000',tipo:'FONDO',wallet:F,sigla:'A'};h.data.accounts.set(founder.id,founder);h.data.economics.set(founder.id,{account_id:founder.id,root_account_id:founder.id,position_class:'FONDO_A',owner_wallet:F,custody_wallet:F,origin:'MODEL_FOUNDER',source_event_key:'MODEL_FOUNDER'});
 await externalBatch(6);assert.equal((await run(f=>f.prepareEntryCompletion({tableId:1,tableNumber:1,heir:founder,turnNumber:1}))).ready,false);await settle('BOOTSTRAP:GEMELLI');await settle('BOOTSTRAP:PROJECTS');assert.equal((await run(f=>f.prepareEntryCompletion({tableId:1,tableNumber:1,heir:founder,turnNumber:1}))).ready,true);
 const secondary=[],rhaTotals=[];
 for(let turn=1;turn<=10;turn++){
  let heir=founder;
  if(turn>1){const parent=h.data.accounts.get(String(turn-1));heir={id:String(9000+turn),tipo:turn%2===0?'PERPETUO':'GEMELLO',wallet:parent.wallet,sigla:'MODEL_SECONDARY_'+turn};h.data.accounts.set(heir.id,heir);await run(f=>f.inherit(parent.id,heir));secondary.push(heir);await run(f=>f.fundFunctions({turnId:turn,turnNumber:turn}));}
  const beforeH=BigInt(h.data.counters.human_cumulative),priests=turn===1?18:13;
  for(let n=0;n<priests;n++){
   const batch=await externalBatch(5),placed=batch.positions.at(-1);assert.equal(placed.completed,true);const priest=h.data.accounts.get(batch.positions[0].accountId);
   await run(async f=>{const funded=await f.prepareEntryCompletion({tableId:placed.tableId,tableNumber:placed.tableNumber,heir:priest,turnNumber:turn});await f.fundPriest({accountId:priest.id,turnId:turn,fundingBucket:funded.fundingBucket});});
  }
  assert.equal(BigInt(h.data.counters.human_cumulative)-beforeH,BigInt(priests*5));
  const exit=await run(f=>f.planExit({level:'RHA',eventKey:'MODEL_RHA:'+turn,turn:{id:turn,numero_turno:turn,sacerdoti_entrati:priests,sacerdoti_necessari:priests,faraone_account_id:heir.id,faraone_wallet:heir.wallet},account:heir}));
  if(heir.tipo==='PERPETUO')assert.equal(h.data.movements.get('GEMELLI_RETURN:'+turn).purpose,'CONTINUITY_IN');
  await settle('GEMELLI_RETURN:'+turn);await settle('GEMELLI_NEXT:'+turn);await netAndCross(exit);rhaTotals.push({turn,type:heir.tipo,humanPaid:turn===1?96:65,net:A.decimal(exit.cashPayoutAtomic)});
 }
 const winners=[];
 for(let group=0;group<3;group++){
  const turn=100+group,members=secondary.slice(group*3,group*3+3),heir=members[0];
  for(const child of members)await run(f=>f.fundSecondaryEntry({accountId:child.id,turnId:turn,level:4}));
  const exit=await run(f=>f.planExit({level:'THOT',eventKey:'MODEL_THOT:'+turn,turn:{id:turn,numero_turno:group+1,sacerdoti_entrati:3,sacerdoti_necessari:3,faraone_account_id:heir.id,faraone_wallet:heir.wallet},account:heir}));
  await run(f=>f.materializeQuota({eventKey:exit.eventKey,source:'THOT',accountId:heir.id}));await settle(exit.keys.PROJECTS);await netAndCross(exit);winners.push(heir);
 }
 for(const heir of winners)await run(f=>f.fundSecondaryEntry({accountId:heir.id,turnId:200,level:5}));
 const finalSpec={level:'ISIDE',eventKey:'MODEL_ISIDE:200',turn:{id:200,numero_turno:1,sacerdoti_entrati:3,sacerdoti_necessari:3,faraone_account_id:winners[0].id,faraone_wallet:winners[0].wallet},account:winners[0]};
 const final=await run(f=>f.planExit(finalSpec));await run(f=>f.materializeQuota({eventKey:final.eventKey,source:'ISIDE',accountId:winners[0].id}));await netAndCross(final);await conservation();
 assert.equal(external,A.usdc('68100'));assert.equal(crossRog,A.usdc('3000'));assert.equal(crossUranus,A.usdc('2000'));assert.equal(ordinaryNet,A.usdc('52000'));assert.equal(externalPaid,A.usdc('57000'));assert.equal(simulatedBalances.get(T)+simulatedBalances.get(G)+simulatedBalances.get(P),A.usdc('11100'));cases++;
 assert.equal(h.data.counters.human_cumulative,'681');assert.equal(h.data.counters.piletta_cumulative,'65');assert.equal(h.data.positions.length,746);assert.equal(simulatedBalances.get(P),A.usdc('1600'));assert.equal(simulatedBalances.get(G),A.usdc('500'));cases++;
 const before=structuredClone(h.data);await run(f=>f.planExit(finalSpec));await run(f=>f.materializeQuota({eventKey:final.eventKey,source:'ISIDE',accountId:winners[0].id}));assert.deepEqual(h.data,before);cases++;
 console.log(JSON.stringify({test:'funded-multiturn-economic-model',status:'PASS',cases,rhaTurns:rhaTotals,thotClosures:3,isideClosures:1,externalUsdc:A.decimal(external),paidOutUsdc:A.decimal(externalPaid),remainingReservedUsdc:'11100',humanRoots:681,pilettaRoots:65,projectsSettledUsdc:'1600',projectsProtectedUsdc:'100',gemelliSettledUsdc:'500',gemelliTransitions:gemelliStates,scope:'Actual ledger/flow/materializer, MODEL table placement/heir selection and SYNTHETIC receipt proofs, 13 synthetic beneficiary wallets; NOT production clone, full donation-flow-manager, native PostgreSQL or actual receivers'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

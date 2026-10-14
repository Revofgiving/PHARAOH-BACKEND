'use strict';
const assert=require('node:assert/strict');
const {EconomicWorker,INTERNAL_PURPOSES}=require('../economic-worker');
function setup() {
 const calls=[],state={blocked:false,active:true,failRegistry:false,failTransfer:false,pending:false};
 const row={movement_key:'GEMELLI:1',purpose:'GEMELLI_RESERVE_OUT',status:'CONFIRMED',tx_hash:'0x'+'1'.repeat(64)};
 const repository={withCycleLock:fn=>fn(),isActive:async()=>state.active,listInternal:async()=>[row],registrySubmitted:async()=>calls.push('registryHash'),registryCompleted:async()=>calls.push('registryCompleted')};
 const worker=new EconomicWorker({repository,dispatcher:{run:async()=>{calls.push('transfer');if(state.failTransfer)throw Object.assign(new Error('manual'),{code:'GEMELLI_MANUAL_SIGNATURE_REQUIRED'});return {confirmed:!state.pending,status:'SUBMITTED'};},read:async()=>row},
  register:async(_,onSubmitted)=>{calls.push('register');await onSubmitted('0x'+'2'.repeat(64));if(state.failRegistry)throw new Error('registry rpc');return {};},
  advance:async()=>{calls.push('advance');return {};},reconcilePayouts:async()=>{calls.push('acceptedPayouts');return [];},isBlocked:async()=>state.blocked});
 return {worker,state,calls,row};
}
async function main(){let cases=0;
 let f=setup();await f.worker.run();assert.deepEqual(f.calls,['transfer','register','registryHash','registryCompleted','acceptedPayouts','advance']);cases++;
 f=setup();f.state.blocked=true;assert.equal((await f.worker.run()).skipped,'SYSTEM_BLOCKED');assert.deepEqual(f.calls,[]);cases++;
 f=setup();f.state.active=false;assert.equal((await f.worker.run()).skipped,'ECONOMIC_CUTOVER_NOT_ACTIVE');assert.deepEqual(f.calls,[]);cases++;
 f=setup();f.state.pending=true;await f.worker.run();assert(!f.calls.includes('register'));cases++;
 f=setup();f.state.failTransfer=true;assert.equal((await f.worker.run()).movements[0].code,'GEMELLI_MANUAL_SIGNATURE_REQUIRED');assert(!f.calls.includes('register'));cases++;
 f=setup();f.state.failRegistry=true;const failed=await f.worker.run();assert(failed.movements[0].code);assert(!f.calls.includes('registryCompleted'));assert(f.calls.includes('registryHash'));cases++;
 f=setup();f.row.purpose='PAYOUT_RHA';await assert.rejects(f.worker.run(),/FORBIDDEN_PURPOSE/);assert.deepEqual(f.calls,[]);cases++;
 f=setup();f.worker.running=true;assert.equal((await f.worker.run()).skipped,'LOCAL_CYCLE_RUNNING');cases++;
 f=setup();await assert.rejects(f.worker.run(101),/BATCH_INVALID/);cases++;
 assert(!INTERNAL_PURPOSES.some(x=>x.startsWith('RHA_')||x.startsWith('PAYOUT')));cases++;
 console.log(JSON.stringify({test:'economic-worker-runtime',status:'PASS',cases,scope:'worker service with repository/chain/registry/advancement doubles'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

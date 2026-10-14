'use strict';
const assert=require('node:assert/strict'),A=require('../economic-amounts'),{assess}=require('../ops/economic-cutover-assessment');
const wallet=n=>'0x'+Number(n).toString(16).padStart(40,'0');
function seal(tables){const values=Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{present:true,count:rows.length,rows,sha256:A.digest(rows)}]));return {version:1,readOnly:true,activatesNothing:true,publicWallets:{PHARAOH_TREASURY_WALLET:wallet(999)},tables:values,inventoryHash:A.digest(values)};}
function fixture(){return {accounts:Array.from({length:13},(_,i)=>({id:String(i+1),wallet:wallet(i+1),tipo:'PRIMARIO',origin_kind:i%3===0?'URANUS':'DIRECT'})),posizioni:Array.from({length:13},(_,i)=>({id:String(i+1),tavola_id:'2',account_id:String(i+1),tipo:'DONATORE',dono_importo:'100.00',numero_posizionale:String(i+8)})),tavole:[{id:'2',livello:'0'}],gift_sessions:[],doni_pendenti:[],cross_outbound_operations:[],post_commit_operations:[]};}
let cases=0,t=fixture(),inv=seal(t),before=A.json(inv),r=assess(inv,{declaredRealPeople:13,declaredNoPendingGifts:true});
assert.equal(r.observed.externalOriginS0CandidateRoots,13);assert.equal(r.observed.distinctCandidateWallets,13);assert.equal(r.observed.noPendingGiftsInSnapshot,true);assert.equal(r.observed.personCount,null);assert.equal(r.counterSeed,null);assert.equal(r.freeTreasuryUsdc,null);assert.equal(r.deployable,false);assert.equal(A.json(inv),before);cases++;
t.accounts.push({id:'14',wallet:wallet(1),tipo:'PRIMARIO',origin_kind:'ROG'});t.posizioni.push({id:'14',account_id:'14',tavola_id:'2',tipo:'DONATORE',dono_importo:'100',numero_posizionale:'22'});r=assess(seal(t),{declaredRealPeople:13});assert.equal(r.observed.externalOriginS0CandidateRoots,14);assert.equal(r.observed.distinctCandidateWallets,13);assert.equal(r.counterSeed,null);cases++;
t.accounts.push({id:'15',wallet:wallet(15),tipo:'PRIMARIO',origin_kind:'DIRECT'});r=assess(seal(t));assert.equal(r.observed.externalOriginS0CandidateRoots,14);cases++;
t=fixture();t.accounts[0].origin_kind='LEGACY';r=assess(seal(t));assert.equal(r.observed.externalOriginS0CandidateRoots,12);assert.equal(r.observed.unresolvedS0Positions.length,1);cases++;
t=fixture();t.accounts[0].tipo='PERPETUO';r=assess(seal(t));assert.equal(r.observed.externalOriginS0CandidateRoots,12);cases++;
t=fixture();t.posizioni[0].tipo='CASSA';r=assess(seal(t));assert.equal(r.observed.externalOriginS0CandidateRoots,12);assert.equal(r.observed.systemS0Positions.length,1);cases++;
t=fixture();t.accounts[0].wallet=wallet(999);assert.equal(assess(seal(t)).observed.externalOriginS0CandidateRoots,12);cases++;
t=fixture();t.gift_sessions=[{gift_id:'g1',status:'PAID_AWAITING_ACTIVATION',pharaoh_tx_hash:'0x'+'a'.repeat(64),pharaoh_amount_usdc:'100'}];r=assess(seal(t),{declaredNoPendingGifts:true});assert.equal(r.observed.noPendingGiftsDeclarationMatches,false);assert.equal(r.observed.paidUnassignedKnownUsdc,'100');cases++;
t.gift_sessions[0].status='CANCELLED';assert.equal(assess(seal(t)).observed.noPendingGiftsInSnapshot,false);cases++;
t.gift_sessions[0].status='POSITION_ASSIGNED';assert.equal(assess(seal(t)).observed.noPendingGiftsInSnapshot,true);cases++;
t=fixture();t.gift_sessions=[{gift_id:'x'}];assert.equal(assess(seal(t)).observed.noPendingGiftsInSnapshot,false);cases++;
t=fixture();t.cross_outbound_operations=[{status:'FUNDS_CONFIRMED'}];t.doni_pendenti=[{status:'ACCEPTED'}];r=assess(seal(t));assert.equal(r.observed.pendingCross,1);assert.equal(r.observed.pendingPayouts,1);assert.equal(r.observed.noPendingGiftsInSnapshot,true);cases++;
inv=seal(fixture());inv.tables.accounts.rows[0].wallet=wallet(55);assert.throws(()=>assess(inv),/HASH_MISMATCH/);cases++;
t=fixture();t.posizioni.push({...t.posizioni[0],id:'99'});assert.throws(()=>assess(seal(t)),/MULTIPLE_S0_POSITIONS/);cases++;
t=fixture();t.accounts.push(t.accounts[0]);assert.throws(()=>assess(seal(t)),/DUPLICATE_ACCOUNT/);cases++;
assert.throws(()=>assess(seal(fixture()),{declaredRealPeople:'13'}),/DECLARATION_INVALID/);cases++;
console.log(JSON.stringify({test:'cutover-assessment',status:'PASS',cases,scope:'offline inventory fixtures, including 13 synthetic wallets; NOT reading or classifying production'}));

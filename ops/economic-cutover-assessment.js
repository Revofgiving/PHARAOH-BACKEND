'use strict';
/** Offline, read-only assessment of an inventory, NOT an adoption/activation.
 * Counts PERSONS, WALLETS and materialized S0 ROOTS are deliberately different.
 * A numerical correspondence with a user declaration is not proof of identity.
 */
const fs=require('node:fs'),A=require('../economic-amounts');
const EXTERNAL=new Set(['DIRECT','GIFT','URANUS','ROG','URANUS_TO_PHARAOH','ROG_TO_PHARAOH']);
const GIFT_FINAL=new Set(['POSITION_ASSIGNED','CANCELLED']);
function validateInventory(inv){
 if(inv?.version!==1||inv.readOnly!==true||inv.activatesNothing!==true||!inv.tables)throw A.error('ASSESSMENT_REQUIRES_READONLY_INVENTORY');
 if(A.digest(inv.tables)!==inv.inventoryHash)throw A.error('ASSESSMENT_INVENTORY_HASH_MISMATCH');
 for(const [name,t] of Object.entries(inv.tables))if(t.present){
  if(!Array.isArray(t.rows)||t.count!==t.rows.length||A.digest(t.rows)!==t.sha256)throw A.error('ASSESSMENT_TABLE_HASH_MISMATCH',{table:name});
 }
 for(const table of ['accounts','posizioni','tavole','gift_sessions','doni_pendenti','cross_outbound_operations','post_commit_operations'])if(!inv.tables[table]?.present)throw A.error('ASSESSMENT_REQUIRED_TABLE_MISSING',{table});
}
function assess(inv,{declaredRealPeople=null,declaredNoPendingGifts=null}={}){
 validateInventory(inv);
 if(declaredRealPeople!==null&&(!Number.isSafeInteger(declaredRealPeople)||declaredRealPeople<0))throw A.error('ASSESSMENT_DECLARATION_INVALID');
 if(declaredNoPendingGifts!==null&&typeof declaredNoPendingGifts!=='boolean')throw A.error('ASSESSMENT_DECLARATION_INVALID');
 const rows=name=>inv.tables[name]?.present?inv.tables[name].rows:[];
 const accounts=new Map(rows('accounts').map(a=>[String(a.id),a]));
 if(accounts.size!==rows('accounts').length)throw A.error('ASSESSMENT_DUPLICATE_ACCOUNT_ID');
 const tables=new Map(rows('tavole').map(t=>[String(t.id),t]));
 const seenPositions=new Set(),rootPositions=new Map(),unknownPositions=[],systemPositions=[];
 const systemWallets=new Set(Object.entries(inv.publicWallets||{}).filter(([k,v])=>k!=='PHARAOH_REGISTRY_ADDRESS'&&v).map(([,v])=>String(v).toLowerCase()));
 const verifiedOrigins=[];
 for(const p of rows('posizioni')){
  if(seenPositions.has(String(p.id)))throw A.error('ASSESSMENT_DUPLICATE_POSITION_ID');seenPositions.add(String(p.id));
  const table=tables.get(String(p.tavola_id));
  if(!table||table.livello==null){unknownPositions.push({positionId:p.id,reason:'TABLE_LEVEL_NOT_RESOLVED'});continue;}
  if(String(table.livello)!=='0')continue;
  const a=accounts.get(String(p.account_id));
  if(!a){unknownPositions.push({positionId:p.id,reason:'ACCOUNT_LINK_MISSING'});continue;}
  const origin=String(a.origin_kind||'').toUpperCase();
  if(['CASSA','ROLLOVER','CONTINUITA_RHA'].includes(p.tipo)||a.tipo==='FONDO'||origin==='CASSA_ENTRY'){
   systemPositions.push({positionId:p.id,accountId:a.id,kind:p.tipo||a.tipo});continue;
  }
  // Never infer HUMAN from the existence of a wallet alone, or from a child
  // PERPETUO/GEMELLO. Origins without traceable evidence remain unresolved.
  if(a.tipo!=='PRIMARIO'||!EXTERNAL.has(origin)||systemWallets.has(String(a.wallet).toLowerCase())){
   unknownPositions.push({positionId:p.id,accountId:a.id,reason:'EXTERNAL_ROOT_REQUIRES_REVIEW'});continue;
  }
  try{if(A.usdc(p.dono_importo)!==A.usdc('100'))throw Error();A.address(a.wallet);A.positive(p.numero_posizionale);}catch(_){unknownPositions.push({positionId:p.id,accountId:a.id,reason:'S0_AMOUNT_WALLET_OR_NUMBER_UNRESOLVED'});continue;}
  if(rootPositions.has(String(a.id)))throw A.error('ASSESSMENT_MULTIPLE_S0_POSITIONS_FOR_ROOT',{accountId:a.id});
  rootPositions.set(String(a.id),p.id);verifiedOrigins.push({accountId:a.id,positionId:p.id,origin,wallet:String(a.wallet).toLowerCase(),numeroPosizionale:String(p.numero_posizionale)});
 }
 const gifts=rows('gift_sessions'),missingGiftStatus=gifts.some(r=>typeof r.status!=='string'||!r.status);
 const nonFinalGifts=gifts.filter(r=>!GIFT_FINAL.has(r.status));
 const paidUnassigned=gifts.filter(r=>r.pharaoh_tx_hash&&r.status!=='POSITION_ASSIGNED');
 let paidAmount=0n,unresolvedPaidAmounts=0;
 for(const r of paidUnassigned){try{const amount=A.usdc(r.pharaoh_amount_usdc);if(amount!==A.usdc('100'))throw Error();paidAmount+=amount;}catch(_){unresolvedPaidAmounts++;}}
 const pendingPayouts=rows('doni_pendenti').filter(r=>!['SENT','CANCELLED','EXPIRED'].includes(r.status));
 const pendingCross=rows('cross_outbound_operations').filter(r=>r.status!=='COMPLETED');
 const pendingPostCommit=rows('post_commit_operations').filter(r=>r.status!=='COMPLETED');
 const distinctCandidateWallets=new Set(verifiedOrigins.map(r=>r.wallet)).size;
 const noPendingGifts=!missingGiftStatus&&!nonFinalGifts.length&&!paidUnassigned.length;
 const blockers=['OPENING_RESERVES_AND_CLASSIFICATION_NOT_APPLIED','SETTLED_BALANCES_AND_OBLIGATIONS_MUST_BE_RECONCILED','PRODUCTION_BACKUP_AND_RESTORE_EVIDENCE_REQUIRED'];
 if(unknownPositions.length)blockers.push('UNRESOLVED_HISTORICAL_S0_CLASSIFICATION');
 if(systemPositions.length)blockers.push('PRESERVE_HISTORICAL_SYSTEM_POSITIONS_REVIEW_ECONOMIC_BINDING');
 if(paidUnassigned.length||nonFinalGifts.length||missingGiftStatus)blockers.push('GIFT_STATE_REQUIRES_REVIEW');
 if(pendingPayouts.length)blockers.push('PENDING_PAYOUTS_REQUIRE_BINDING');
 if(pendingCross.length)blockers.push('PENDING_CROSS_REQUIRE_BINDING');
 if(pendingPostCommit.length)blockers.push('PENDING_POST_COMMIT_REQUIRE_BINDING');
 return {version:1,scope:'OFFLINE_READONLY_ASSESSMENT_NOT_ADOPTION',inputInventoryHash:inv.inventoryHash,readOnly:true,deployable:false,activatesNothing:true,
  declarations:{realPeople:declaredRealPeople,noPendingGifts:declaredNoPendingGifts,source:'USER_DECLARATION_NOT_DATABASE_PROOF'},
  observed:{accounts:rows('accounts').length,positions:rows('posizioni').length,personCount:null,externalOriginS0CandidateRoots:rootPositions.size,distinctCandidateWallets,
   peopleDeclarationNumericallyMatchesWallets:declaredRealPeople===null?null:declaredRealPeople===distinctCandidateWallets,unresolvedS0Positions:unknownPositions,systemS0Positions:systemPositions,
   giftRows:gifts.length,nonFinalGiftRows:nonFinalGifts.length,paidUnassignedGiftRows:paidUnassigned.length,paidUnassignedKnownUsdc:A.decimal(paidAmount),unresolvedPaidGiftAmounts:unresolvedPaidAmounts,noPendingGiftsInSnapshot:noPendingGifts,
   noPendingGiftsDeclarationMatches:declaredNoPendingGifts===null?null:declaredNoPendingGifts===noPendingGifts,pendingPayouts:pendingPayouts.length,pendingCross:pendingCross.length,pendingPostCommit:pendingPostCommit.length},
  s0Candidates:verifiedOrigins,counterSeed:null,freeTreasuryUsdc:null,blockers,
  notes:['H_COUNTS_MATERIALIZED_EXTERNAL_POSITIONS_NOT_PEOPLE_OR_REGISTERED_WALLETS','CANDIDATE_ORIGIN_IS_NOT_PAYMENT_PROOF','NO_HISTORICAL_BOOTSTRAP_REPLAY','NO_GIFT_ROWS_DOES_NOT_MEAN_NO_OTHER_OBLIGATIONS','SNAPSHOT_HASH_CHECK_IS_NOT_PROOF_OF_PRODUCTION_PROVENANCE']};
}
function main(){const [input,output,declared]=process.argv.slice(2);if(!input||!output||process.argv.length>5||fs.existsSync(output))throw A.error('USAGE_INVENTORY_JSON_NEW_OUTPUT_JSON_OPTIONAL_PEOPLE');if(fs.statSync(input).size>128*1024*1024)throw A.error('ASSESSMENT_INPUT_TOO_LARGE');const inv=JSON.parse(fs.readFileSync(input,'utf8'));const result=assess(inv,{declaredRealPeople:declared==null?null:Number(declared)});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log('OFFLINE_ASSESSMENT_WRITTEN_NO_DATABASE_CHANGE');}
if(require.main===module)try{main();}catch(e){console.error(e.code||'ASSESSMENT_FAILED');process.exitCode=1;}
module.exports={assess,validateInventory};

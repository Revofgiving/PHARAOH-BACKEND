'use strict';
/** Read-only, bounded inventory for a reviewed cutover. NOT an activation tool,
 * NOT a backup, NOT a funded opening ledger. Never reads keys or raw signed txs.
 */
const fs=require('node:fs'),A=require('../economic-amounts');
const COLUMNS=Object.freeze({
 accounts:['id','wallet','tipo','sigla','numero_posizionale','root_account_id','parent_account_id','source_account_id','source_event_key','origin_kind','account_key','status','created_at'],
 posizioni:['id','tavola_id','casella','wallet','tipo','dono_importo','account_id','account_sigla','numero_posizionale','sdoppiamento_tavola_id','status','created_at'],
 tavole:['id','numero','livello','turno','tipo','status','faraone_wallet','faraone_account_id','faraone_sigla','doni_totali','doni_ricevuti'],
 turni:['id','numero_turno','sezione','sistema','livello','status','faraone_wallet','faraone_account_id','sacerdoti_entrati','sacerdoti_necessari'],
 donazioni:['id','tx_hash','importo','donor_wallet','destinatario_wallet','beneficiary_wallet','source_platform','source_event_key','positions_created','tavola_id','livello','turno','status','blockchain_verified_at','created_at'],
 gift_sessions:['gift_id','payment_wallet','beneficiary_wallet','status','pharaoh_tx_hash','pharaoh_amount_usdc','activation_expires_at','completed_at'],
 doni_pendenti:['id','event_key','wallet','account_id','importo','livello','status','accepted_at','tx_hash','expires_at','created_at'],
 cross_outbound_operations:['event_key','rha_event_key','target_platform','source_wallet','destination_wallet','beneficiary_wallet','account_id','amount_usdc','status','payment_tx_hash','protocol_version','created_at'],
 post_commit_operations:['id','event_key','operation_type','source_tavola_id','source_tavola_numero','turno_id','turno_numero','wallet','status','payload','created_at'],
 pharaoh_schema_migrations:['id','checksum','applied_at'],
 pharaoh_economic_activation:['singleton','status','mode','evidence_hash','cutover_block_number','cutover_block_hash','activated_at'],
 pharaoh_economic_buckets:['bucket_key','wallet','purpose','balance_atomic','metadata'],
 pharaoh_treasury_movements:['movement_key','reserve_bucket','source_wallet','destination_wallet','amount_atomic','purpose','status','tx_hash','registry_tx_hash'],
 pharaoh_s0_counters:['human_cumulative','piletta_cumulative','seeded','evidence_hash']
});
async function inventory({client,env=process.env,maxRows=200000}={}) {
 if(!client || !Number.isSafeInteger(maxRows)||maxRows<1||maxRows>1000000)throw A.error('CUTOVER_INVENTORY_ARGUMENT_INVALID');
 let begun=false;
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  await client.query("SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='5s'; SET LOCAL TIME ZONE 'UTC'; SET LOCAL row_security=off");
  const serverRow=(await client.query("SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num, current_schema() AS current_schema")).rows[0] || {};
  const serverInfo=Object.fromEntries(['database_name','server_version','server_version_num','current_schema'].map(k=>[k,serverRow[k] == null ? null : String(serverRow[k])]));
  const tables={};let total=0;
  for(const [table,wanted] of Object.entries(COLUMNS)){
   const columns=(await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',['public',table])).rows.map(r=>r.column_name);
   if(!columns.length){tables[table]={present:false};continue;}
   const selected=wanted.filter(c=>columns.includes(c));if(!selected.length)throw A.error('CUTOVER_INVENTORY_COLUMNS_MISSING');
   const fields=selected.map(c=>`"${c}"::text AS "${c}"`).join(',');
   const rows=(await client.query(`SELECT ${fields} FROM public."${table}" LIMIT $1`,[maxRows-total+1])).rows;
   total+=rows.length;if(total>maxRows)throw A.error('CUTOVER_INVENTORY_LIMIT_NO_PARTIAL_OUTPUT');
   rows.sort((a,b)=>A.json(a).localeCompare(A.json(b)));
   tables[table]={present:true,columns:selected,count:rows.length,sha256:A.digest(rows),rows};
  }
  for(const required of ['accounts','posizioni','tavole','turni','donazioni','gift_sessions','doni_pendenti','cross_outbound_operations','post_commit_operations'])if(!tables[required]?.present)throw A.error('CUTOVER_INVENTORY_BASELINE_TABLE_MISSING',{table:required});
  const publicWallets={};for(const name of ['PHARAOH_FUND_A_WALLET','PHARAOH_TREASURY_WALLET','PHARAOH_GEMELLI_WALLET','PHARAOH_PROJECTS_WALLET','PHARAOH_REGISTRY_ADDRESS']){try{publicWallets[name]=A.address(env[name]);}catch(_){publicWallets[name]=null;}}
  await client.query('COMMIT');begun=false;
  return {version:1,generatedAt:new Date().toISOString(),readOnly:true,activatesNothing:true,serverInfo,publicWallets,totalRows:total,inventoryHash:A.digest(tables),tables,
    limitations:['NOT_A_DATABASE_BACKUP','NO_RPC_BALANCES_OR_SETTLEMENT_CHECK','NO_AUTOMATIC_HUMAN_CLASSIFICATION','NO_OPENING_RESERVE_CREATION','MUST_BE_REVIEWED_AGAINST_LOCKED_WRITER_CUTOVER']};
 }catch(e){if(begun)try{await client.query('ROLLBACK');}catch(_){}throw e;}
}
async function main(){const out=process.argv[2];if(!out||process.argv.length!==3||fs.existsSync(out))throw A.error('USAGE_NEW_FILE_REQUIRED');const pg=require('../pg-connection-manager');let c;try{c=await pg.getClient();const result=await inventory({client:c});fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log('READ_ONLY_INVENTORY_CREATED_NO_ACTIVATION');}finally{if(c)c.release();await pg.close();}}
if(require.main===module)main().catch(e=>{console.error(e.code||'CUTOVER_INVENTORY_FAILED');process.exitCode=1;});
module.exports={inventory,COLUMNS};

'use strict';
/** Read-only audit, NOT a backup. Use with all writers stopped, on staging first. */
const fs=require('node:fs');
const crypto=require('node:crypto');
const TABLES=Object.freeze(['accounts','tavole','posizioni','turni','funzioni','prenotazioni_funzioni','donazioni','contenitori','storico_avanzamenti','post_commit_operations']);
const FORMAT='PHARAOH_ALL_USER_TABLES_TEXT_CELLS_V2';
const sha=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key=(schema,name)=>JSON.stringify([schema,name]);
const HASH=/^[0-9a-f]{64}$/;
function ident(value){if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('INVALID_IDENTIFIER');return '"'+value.replace(/"/g,'""')+'"';}
function hashCells(cells){if(!Array.isArray(cells)||cells.some(v=>v!==null&&typeof v!=='string'))throw new Error('LOSSY_CELL_ENCODING');return sha(cells);}
function rowsPreserved(before,after,label){
 if(after.length<before.length)throw new Error('RECORDS_REMOVED:'+label);
 const counts=new Map();for(const h of after)counts.set(h,(counts.get(h)||0)+1);
 for(const h of before){const n=counts.get(h)||0;if(!n)throw new Error('HISTORICAL_RECORD_CHANGED_OR_DELETED:'+label);counts.set(h,n-1);}
}
function validate(s){
 if(!s||s.version!==2||s.format!==FORMAT||!HASH.test(s.sourceFingerprint||'')||!s.tables||!s.sequences)throw new Error('INVALID_SNAPSHOT');
 for(const name of TABLES)if(!s.tables[key('public',name)])throw new Error('MISSING_TABLE_SNAPSHOT:'+name);
 for(const [k,t] of Object.entries(s.tables)){
  if(k!==key(t.schema,t.name)||!['r','p','m'].includes(t.kind)||!Number.isSafeInteger(t.count)||t.count<0||!Array.isArray(t.rowHashes)||t.count!==t.rowHashes.length||t.rowHashes.some(h=>!HASH.test(h)))throw new Error('INVALID_SNAPSHOT');
  if(!Array.isArray(t.columns)||!t.columns.length||new Set(t.columns.map(c=>c.name)).size!==t.columns.length||!Array.isArray(t.constraints))throw new Error('INVALID_SNAPSHOT');
  for(const c of t.columns)if(typeof c.name!=='string'||typeof c.type!=='string'||typeof c.notNull!=='boolean')throw new Error('INVALID_SNAPSHOT');
  for(const c of t.constraints)if(typeof c.name!=='string'||!HASH.test(c.hash)||typeof c.validated!=='boolean')throw new Error('INVALID_SNAPSHOT');
 }
 for(const [k,sq] of Object.entries(s.sequences))if(k!==key(sq.schema,sq.name)||typeof sq.lastValue!=='string'||!/^(-?[1-9]\d*|0)$/.test(sq.lastValue)||typeof sq.increment!=='string'||!/^-?[1-9]\d*$/.test(sq.increment)||!HASH.test(sq.definition)||typeof sq.isCalled!=='boolean')throw new Error('INVALID_SEQUENCE_SNAPSHOT');
}
function historicalColumns(old,current,label){
 const byName=new Map(current.map(c=>[c.name,c]));
 return old.map(c=>{const actual=byName.get(c.name);if(!actual||actual.type!==c.type||(c.notNull&&!actual.notNull))throw new Error('HISTORICAL_COLUMN_CHANGED:'+label+':'+c.name);return actual;});
}
function compare(before,after){
 if(!before||!after||before.version!==after.version)throw new Error('INVALID_SNAPSHOT');
 if(before.version===1){
  for(const t of TABLES){const b=before.tables?.[t],a=after.tables?.[t];if(!b||!a)throw new Error('MISSING_TABLE_SNAPSHOT:'+t);if(!Array.isArray(b.rowHashes)||!Array.isArray(a.rowHashes)||b.count!==b.rowHashes.length||a.count!==a.rowHashes.length)throw new Error('INVALID_SNAPSHOT');rowsPreserved(b.rowHashes,a.rowHashes,t);}return true;
 }
 validate(before);validate(after);
 if(before.sourceFingerprint!==after.sourceFingerprint)throw new Error('DIFFERENT_DATABASE_SOURCE');
 for(const [k,b] of Object.entries(before.tables)){
  const a=after.tables[k];if(!a)throw new Error('MISSING_TABLE_SNAPSHOT:'+k);
  if(a.kind!==b.kind)throw new Error('HISTORICAL_TABLE_KIND_CHANGED:'+k);
  historicalColumns(b.columns,a.columns,k);
  if(JSON.stringify(b.columns.map(c=>c.name))!==JSON.stringify(a.columns.map(c=>c.name)))throw new Error('PROJECTION_REQUIRED:'+k);
  for(const c of b.constraints){const actual=a.constraints.find(x=>x.name===c.name);if(!actual||c.hash!==actual.hash||(c.validated&&!actual.validated))throw new Error('HISTORICAL_CONSTRAINT_CHANGED:'+k);}
  rowsPreserved(b.rowHashes,a.rowHashes,k);
 }
 for(const [k,b] of Object.entries(before.sequences)){
  const a=after.sequences[k];if(!a||a.definition!==b.definition||a.increment!==b.increment)throw new Error('SEQUENCE_CHANGED_OR_REMOVED:'+k);
  if((b.isCalled&&!a.isCalled)||(BigInt(b.increment)>0n?BigInt(a.lastValue)<BigInt(b.lastValue):BigInt(a.lastValue)>BigInt(b.lastValue)))throw new Error('SEQUENCE_MOVED_BACKWARDS:'+k);
 }
 return true;
}
async function snapshot({client=null,projection=null,maxRows=2000000,batchSize=1000}={}){
 if(projection)validate(projection);
 if(!Number.isSafeInteger(maxRows)||maxRows<1||!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>10000)throw new Error('INVALID_AUDIT_LIMIT');
 if(!client)require('./db-migrate').validateDatabaseUrl();
 const pg=client?null:require('../pg-connection-manager');const c=client||await pg.getClient();let begun=false;
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  for(const sql of ["SET LOCAL search_path = pg_catalog","SET LOCAL row_security = off","SET LOCAL statement_timeout = '60s'","SET LOCAL lock_timeout = '5s'","SET LOCAL TIME ZONE 'UTC'","SET LOCAL DateStyle = 'ISO, YMD'","SET LOCAL IntervalStyle = 'iso_8601'","SET LOCAL extra_float_digits = 3","SET LOCAL bytea_output = 'hex'"])await c.query(sql);
  const source=(await c.query(`/* audit:source */ SELECT current_database() AS name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,inet_server_addr()::text AS address,inet_server_port()::text AS port`)).rows[0];
  if(!source)throw new Error('DATABASE_SOURCE_UNAVAILABLE');const sourceFingerprint=sha(source);
  if(projection&&sourceFingerprint!==projection.sourceFingerprint)throw new Error('DIFFERENT_DATABASE_SOURCE');
  const catalog=(await c.query(`/* audit:tables */ SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname`)).rows;
  const available=new Set(catalog.map(t=>key(t.schema,t.name)));
  for(const required of [...TABLES.map(t=>key('public',t)),...Object.keys(projection?.tables||{})])if(!available.has(required))throw new Error('REQUIRED_TABLE_MISSING:'+required);
  const tables=Object.create(null);let total=0;
  for(const t of catalog){
   const k=key(t.schema,t.name);if(t.kind==='f')throw new Error('FOREIGN_TABLE_CANNOT_BE_CERTIFIED:'+k);
   const allColumns=(await c.query(`/* audit:columns */ SELECT attname AS name,format_type(atttypid,atttypmod) AS type,attnotnull AS "notNull" FROM pg_attribute WHERE attrelid=$1::oid AND attnum>0 AND NOT attisdropped ORDER BY attnum`,[t.oid])).rows;
   const columns=projection?.tables[k]?historicalColumns(projection.tables[k].columns,allColumns,k):allColumns;
   if(!columns.length)throw new Error('TABLE_WITHOUT_COLUMNS');
   const constraints=(await c.query(`/* audit:constraints */ SELECT conname AS name,pg_get_constraintdef(oid,false) AS definition,convalidated AS validated FROM pg_constraint WHERE conrelid=$1::oid ORDER BY conname`,[t.oid])).rows.map(x=>({name:x.name,hash:sha(x.definition),validated:x.validated}));
   const cells=columns.map(col=>`t.${ident(col.name)}::text`).join(',');
   await c.query(`DECLARE pharaoh_audit_cursor NO SCROLL CURSOR FOR SELECT to_jsonb(ARRAY[${cells}]::text[])::text AS doc FROM ONLY ${ident(t.schema)}.${ident(t.name)} t`);
   const rowHashes=[];
   try{
    while(true){const batch=(await c.query(`FETCH FORWARD ${batchSize} FROM pharaoh_audit_cursor`)).rows;if(!batch.length)break;
     for(const row of batch){if(++total>maxRows)throw new Error('AUDIT_LIMIT_NO_PARTIAL_SNAPSHOT');const values=JSON.parse(row.doc);if(values.length!==columns.length)throw new Error('INVALID_CELL_COUNT');rowHashes.push(hashCells(values));}
    }
   }finally{await c.query('CLOSE pharaoh_audit_cursor').catch(()=>{});}
   rowHashes.sort();tables[k]={schema:t.schema,name:t.name,kind:t.kind,columns,constraints,count:rowHashes.length,rowHashes};
  }
  const sequences=Object.create(null);
  const seqs=(await c.query(`/* audit:sequences */ SELECT n.nspname AS schema,c.relname AS name,s.seqincrement::text AS increment,s.seqmin::text AS minimum,s.seqmax::text AS maximum,s.seqstart::text AS start,s.seqcache::text AS cache,s.seqcycle AS cycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname`)).rows;
  for(const seq of seqs){const value=(await c.query(`/* audit:sequence-state */ SELECT last_value::text AS "lastValue",is_called AS "isCalled" FROM ${ident(seq.schema)}.${ident(seq.name)}`)).rows[0];if(!value)throw new Error('SEQUENCE_STATE_UNAVAILABLE');sequences[key(seq.schema,seq.name)]={schema:seq.schema,name:seq.name,increment:seq.increment,definition:sha(seq),...value};}
  const result={version:2,format:FORMAT,sourceFingerprint,createdAt:new Date().toISOString(),tables,sequences,caveats:['STOP_ALL_WRITERS','SEQUENCES_ARE_NOT_TRANSACTIONAL','NOT_A_BACKUP','NO_LIVE_CERTIFICATION']};
  validate(result);if(projection)compare(projection,result);await c.query('COMMIT');begun=false;return result;
 }catch(error){if(begun)await c.query('ROLLBACK').catch(()=>{});throw error;}finally{if(!client)c.release();}
}
function writeSnapshot(file,value){validate(value);fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
async function main(){
 const [action,first,third,fourth,...extra]=process.argv.slice(2);
 if(action==='snapshot'&&first&&!extra.length&&(!third||(third==='--projection'&&fourth))){
  if(fs.existsSync(first))throw new Error('REFUSING_TO_OVERWRITE_SNAPSHOT');
  writeSnapshot(first,await snapshot({projection:third?JSON.parse(fs.readFileSync(fourth,'utf8')):null}));console.log('PRESERVATION_V2_SNAPSHOT_CREATED');
 }else if(action==='compare'&&first&&third&&!fourth){const before=JSON.parse(fs.readFileSync(first,'utf8'));compare(before,JSON.parse(fs.readFileSync(third,'utf8')));console.log(before.version===2?'HISTORICAL_DATA_PRESERVATION_V2_PASS':'LEGACY_10_TABLE_COMPARE_PASS_NOT_FULL_COVERAGE');}
 else throw new Error('USAGE: snapshot new.json [--projection before.json] | compare before.json after.json');
}
if(require.main===module)main().catch(e=>{console.error(require('./db-migrate').sanitizeError(e));process.exitCode=1;}).finally(async()=>{const p=require.cache[require.resolve('../pg-connection-manager')];if(p)await p.exports.close();});
module.exports={TABLES,FORMAT,key,ident,hashCells,validate,compare,snapshot,writeSnapshot};

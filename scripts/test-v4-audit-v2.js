'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const a=require('../ops/v4-data-preservation');
const secret='0x'+'8'.repeat(40);
function data(){return {tables:[...a.TABLES,'gift_sessions','cross_outbound_operations'].map((name,i)=>({schema:'public',name,kind:'r',oid:String(i+1),columns:[{name:'id',type:'bigint',notNull:true},{name:'wallet',type:'text',notNull:false}],rows:[['9007199254740993',secret]],constraints:[]})).concat([{schema:'archive',name:'old_wallets',kind:'r',oid:'100',columns:[{name:'id',type:'bigint',notNull:true}],rows:[['9007199254740994']],constraints:[]}]),sequences:[{schema:'public',name:'counter',increment:'1',minimum:'1',maximum:'9223372036854775807',start:'1',cache:'1',cycle:false,lastValue:'9007199254740993',isCalled:true}]};}
function mock(d,fail=''){
 const queries=[];let cursor=[];
 return {queries,async query(sql,args=[]){queries.push(sql);if(fail&&sql.includes(fail))throw new Error('MOCK_READ_DENIED');
  if(sql.includes('audit:source'))return {rows:[{name:'test',oid:'12',address:'127.0.0.1',port:'5432'}]};
  if(sql.includes('audit:tables'))return {rows:d.tables.map(({schema,name,kind,oid})=>({schema,name,kind,oid}))};
  if(sql.includes('audit:columns'))return {rows:structuredClone(d.tables.find(t=>t.oid===args[0]).columns)};
  if(sql.includes('audit:constraints'))return {rows:structuredClone(d.tables.find(t=>t.oid===args[0]).constraints)};
  if(sql.includes('audit:sequences'))return {rows:d.sequences.map(({lastValue,isCalled,...r})=>r)};
  if(sql.includes('audit:sequence-state'))return {rows:[{lastValue:d.sequences[0].lastValue,isCalled:d.sequences[0].isCalled}]};
  if(sql.startsWith('DECLARE')){const t=d.tables.find(t=>sql.endsWith(`FROM ONLY ${a.ident(t.schema)}.${a.ident(t.name)} t`));assert.ok(t);const cols=[...sql.matchAll(/t\."([^"]+)"::text/g)].map(m=>m[1]);cursor=t.rows.map(r=>({doc:JSON.stringify(cols.map(c=>r[t.columns.findIndex(x=>x.name===c)]))}));return {rows:[]};}
  if(sql.startsWith('FETCH'))return {rows:cursor.splice(0,Number(sql.match(/FORWARD (\d+)/)[1]))};
  if(/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK|CLOSE)/.test(sql))return {rows:[]};throw new Error('UNEXPECTED_SQL:'+sql);
 }};
}
let n=0;async function check(name,f){await f();n++;console.log('PASS '+name);}
(async()=>{
 let before;
 await check('all user tables and schemas, RLS guard, bounded fetch, no plaintext wallets',async()=>{const c=mock(data());before=await a.snapshot({client:c,batchSize:1});assert.equal(Object.keys(before.tables).length,13);assert.equal(c.queries[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.ok(c.queries.includes('SET LOCAL row_security = off'));assert.equal(c.queries.at(-1),'COMMIT');assert.ok(!JSON.stringify(before).includes(secret));});
 await check('unchanged snapshot compares',()=>assert.equal(a.compare(before,structuredClone(before)),true));
 await check('exact integers and NULL encoding',()=>{assert.notEqual(a.hashCells(['9007199254740992']),a.hashCells(['9007199254740993']));assert.notEqual(a.hashCells([null]),a.hashCells(['null']));assert.throws(()=>a.hashCells([9007199254740992]),/LOSSY/);});
 await check('new column projected, historical values preserved',async()=>{const d=data();d.tables[0].columns.push({name:'new_column',type:'text',notNull:false});d.tables[0].rows[0].push('new');const s=await a.snapshot({client:mock(d),projection:before});assert.equal(a.compare(before,s),true);const raw=await a.snapshot({client:mock(d)});assert.throws(()=>a.compare(before,raw),/PROJECTION_REQUIRED/);});
 await check('cross table deletion detected despite same core tables',async()=>{const d=data();d.tables.find(t=>t.name==='cross_outbound_operations').rows=[];await assert.rejects(a.snapshot({client:mock(d),projection:before}),/RECORDS_REMOVED/);});
 await check('changed wallet detected',async()=>{const d=data();d.tables[0].rows[0][1]='changed';await assert.rejects(a.snapshot({client:mock(d),projection:before}),/HISTORICAL_RECORD_CHANGED/);});
 await check('duplicate multiplicity is preserved',()=>{const b=structuredClone(before),c=structuredClone(before),k=Object.keys(b.tables)[0];b.tables[k].rowHashes.push(b.tables[k].rowHashes[0]);b.tables[k].count++;c.tables[k].rowHashes.push(a.hashCells(['changed']));c.tables[k].count++;assert.throws(()=>a.compare(b,c),/HISTORICAL_RECORD_CHANGED/);});
 await check('type change rejected',async()=>{const d=data();d.tables[0].columns[0].type='integer';await assert.rejects(a.snapshot({client:mock(d),projection:before}),/COLUMN_CHANGED/);});
 await check('non-core historical table missing rejected',async()=>{const d=data();d.tables.pop();await assert.rejects(a.snapshot({client:mock(d),projection:before}),/REQUIRED_TABLE_MISSING/);});
 await check('foreign table cannot receive false certification',async()=>{const d=data();d.tables[0].kind='f';await assert.rejects(a.snapshot({client:mock(d)}),/FOREIGN_TABLE/);});
 await check('sequence regression beyond numeric precision rejected',async()=>{const d=data();d.sequences[0].lastValue='9007199254740992';await assert.rejects(a.snapshot({client:mock(d),projection:before}),/SEQUENCE_MOVED_BACKWARDS/);});
 await check('sequence is_called reset rejected',async()=>{const d=data();d.sequences[0].isCalled=false;await assert.rejects(a.snapshot({client:mock(d),projection:before}),/SEQUENCE_MOVED_BACKWARDS/);});
 await check('database mixup rejected',()=>{const c=structuredClone(before);c.sourceFingerprint='b'.repeat(64);assert.throws(()=>a.compare(before,c),/DIFFERENT_DATABASE/);});
 await check('permission error causes rollback only',async()=>{const c=mock(data(),'audit:columns');await assert.rejects(a.snapshot({client:c}),/DENIED/);assert.equal(c.queries.at(-1),'ROLLBACK');assert.ok(!c.queries.includes('COMMIT'));});
 await check('row limit is not silent truncation',async()=>{await assert.rejects(a.snapshot({client:mock(data()),maxRows:1}),/LIMIT_NO_PARTIAL/);});
 await check('constraint deletion rejected',()=>{const b=structuredClone(before),k=Object.keys(b.tables)[0];b.tables[k].constraints=[{name:'original',hash:'a'.repeat(64),validated:true}];assert.throws(()=>a.compare(b,before),/CONSTRAINT_CHANGED/);});
 await check('snapshots private and no overwrite',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pharaoh-audit-'));try{const file=path.join(dir,'pre.json');a.writeSnapshot(file,before);assert.equal(fs.statSync(file).mode&0o777,0o600);assert.throws(()=>a.writeSnapshot(file,before),/EEXIST/);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
 console.log(`V4_AUDIT_V2_PASS: ${n} mock/client or pure scenarios; NOT live PostgreSQL`);
})().catch(e=>{console.error(e);process.exitCode=1;});

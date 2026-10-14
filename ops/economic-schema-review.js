'use strict';
/** Read-only comparison of the SAME database immediately before/after forward
 * DDL. Preserved rows do not certify a changed constraint. Every schema delta
 * remains an explicit review item. Does not weaken the strict V2 comparator.
 */
const fs=require('node:fs');
const audit=require('./v4-data-preservation');
const A=require('../economic-amounts');
function compareForwardData(before,after) {
  audit.validate(before);audit.validate(after);
  if(before.sourceFingerprint!==after.sourceFingerprint)throw A.error('DIFFERENT_DATABASE_SOURCE');
  const changes=[];let checkedRows=0;
  for(const [key,b] of Object.entries(before.tables)) {
    const a=after.tables[key];
    if(!a || a.kind!==b.kind)throw A.error('HISTORICAL_TABLE_MISSING_OR_CHANGED',{table:key});
    if(JSON.stringify(b.columns.map(c=>[c.name,c.type]))!==JSON.stringify(a.columns.map(c=>[c.name,c.type])))throw A.error('HISTORICAL_COLUMN_PROJECTION_REQUIRED',{table:key});
    b.columns.forEach((c,i)=>{if(c.notNull!==a.columns[i].notNull)changes.push({kind:'NULLABILITY',table:key,column:c.name,before:c.notNull,after:a.columns[i].notNull});});
    const counts=new Map();a.rowHashes.forEach(h=>counts.set(h,(counts.get(h)||0)+1));
    for(const hash of b.rowHashes){const n=counts.get(hash)||0;if(!n)throw A.error('HISTORICAL_ROW_CHANGED_OR_REMOVED',{table:key});counts.set(hash,n-1);checkedRows++;}
    const names=[...new Set([...b.constraints,...a.constraints].map(c=>c.name))].sort();
    for(const name of names){const old=b.constraints.find(c=>c.name===name)||null,now=a.constraints.find(c=>c.name===name)||null;if(JSON.stringify(old)!==JSON.stringify(now))changes.push({kind:'CONSTRAINT',table:key,name,before:old,after:now});}
  }
  for(const [key,a] of Object.entries(after.tables))if(!before.tables[key])changes.push({kind:'NEW_TABLE',table:key,definitionHash:A.digest({kind:a.kind,columns:a.columns,constraints:a.constraints}),rows:a.count});
  for(const [key,b] of Object.entries(before.sequences)) {
    const a=after.sequences[key];
    if(!a || a.definition!==b.definition || a.increment!==b.increment)throw A.error('SEQUENCE_CHANGED_OR_REMOVED',{sequence:key});
    if(b.isCalled&&!a.isCalled || (BigInt(b.increment)>0n?BigInt(a.lastValue)<BigInt(b.lastValue):BigInt(a.lastValue)>BigInt(b.lastValue)))throw A.error('SEQUENCE_MOVED_BACKWARDS',{sequence:key});
  }
  for(const key of Object.keys(after.sequences))if(!before.sequences[key])changes.push({kind:'NEW_SEQUENCE',sequence:key,definition:after.sequences[key].definition});
  return {version:1,readOnly:true,historicalRowsPreserved:true,checkedRows,checkedTables:Object.keys(before.tables).length,
    beforeHash:A.digest(before),afterHash:A.digest(after),schemaChanges:changes,schemaReviewRequired:changes.length>0,
    schemaApproved:false,authorizesDeployment:false,
    limitations:['COMPARE_INPUT_SNAPSHOTS_ONLY','NOT_A_BACKUP','STOP_ALL_WRITERS_FOR_CUTOVER','DDL_CHANGES_REQUIRE_SEPARATE_REVIEW','DOES_NOT_CERTIFY_LEDGER_OPENING_BALANCES']};
}
if(require.main===module) {
  try {const [before,after]=process.argv.slice(2);if(process.argv.length!==4)throw A.error('USAGE_TWO_SNAPSHOT_FILES_REQUIRED');
    console.log(JSON.stringify(compareForwardData(JSON.parse(fs.readFileSync(before,'utf8')),JSON.parse(fs.readFileSync(after,'utf8'))),null,2));
  }catch(e){console.error(e.code||e.message);process.exitCode=1;}
}
module.exports={compareForwardData};

'use strict';
/** Keep one transaction owned by the caller, without editing historical SQL or
 * recorded checksums. ONLY these three exact reviewed historical files have a
 * standalone BEGIN/COMMIT envelope removed from their executable projection.
 * This is a statement framer for trusted migration sources, NOT a SQL parser or
 * sandbox for arbitrary/untrusted SQL. PostgreSQL remains the syntax authority.
 */
const crypto=require('node:crypto');
const WRAPPED=Object.freeze({
 '0016_gift_pending_rog_beneficiary':'ef222ac26a4ca4f41e59637b19005cc117674993e21eefc47c16a06f254e76e9',
 '0017_gift_dynamic_rog_amount':'2fb47583ac54a944dab0d836070fe1a81be1cda0994c585b2af2803831152419',
 '0018_gift_rog_exact_2':'e7051eb0e632dfde4a78e454e933c3be1bc6668ca98cd17f9602e54bd0a08302'
});
function failure(code){return Object.assign(new Error(code),{code});}
function visibleSql(sql){
 if(typeof sql!=='string')throw failure('MIGRATION_SQL_REQUIRED');
 let out='',i=0;
 while(i<sql.length){
  const c=sql[i],n=sql[i+1];
  if(c==='-'&&n==='-'){const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end;out+=' ';continue;}
  if(c==='/'&&n==='*'){let depth=1;i+=2;while(i<sql.length&&depth){if(sql[i]==='/'&&sql[i+1]==='*'){depth++;i+=2;}else if(sql[i]==='*'&&sql[i+1]==='/'){depth--;i+=2;}else i++;}if(depth)throw failure('MIGRATION_UNTERMINATED_COMMENT');out+=' ';continue;}
  if(c==="'"||c==='"'){
   const quote=c,escaped=quote==="'"&&/[eE]/.test(sql[i-1]||'')&&!/[a-zA-Z0-9_$]/.test(sql[i-2]||'');let closed=false;i++;
   while(i<sql.length){if(escaped&&sql[i]==='\\'){i+=2;continue;}if(sql[i]===quote){if(sql[i+1]===quote){i+=2;continue;}closed=true;i++;break;}i++;}
   if(!closed)throw failure('MIGRATION_UNTERMINATED_QUOTE');out+=' ';continue;
  }
  if(c==='$'){
   const match=sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/);
   if(match){const tag=match[0],end=sql.indexOf(tag,i+tag.length);if(end<0)throw failure('MIGRATION_UNTERMINATED_DOLLAR_QUOTE');i=end+tag.length;out+=' ';continue;}
  }
  out+=c;i++;
 }
 return out;
}
function assertNoTransactionControl(sql){
 const statements=visibleSql(sql).split(';').map(s=>s.trim()).filter(Boolean);
 for(const statement of statements){
  if(/^(?:BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE)\b/i.test(statement)||/^SET\s+(?:LOCAL\s+)?TRANSACTION\b/i.test(statement)||/^SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION\b/i.test(statement))throw failure('MIGRATION_TRANSACTION_CONTROL_FORBIDDEN');
 }
 return statements.length;
}
function prepareMigrationSql(item){
 if(!item||typeof item.sql!=='string'||typeof item.id!=='string')throw failure('MIGRATION_SQL_REQUIRED');
 const rawSha256=crypto.createHash('sha256').update(item.sql).digest('hex');
 if(item.sha256!==rawSha256)throw failure('MIGRATION_EXECUTION_CHECKSUM_MISMATCH');
 let executionSql=item.sql,transactionNormalization='NONE';
 if(Object.prototype.hasOwnProperty.call(WRAPPED,item.id)){
  if(WRAPPED[item.id]!==rawSha256)throw failure('MIGRATION_TRANSACTION_WRAPPER_REVIEW_REQUIRED');
  const match=item.sql.match(/^\s*BEGIN\s*;([\s\S]*?)COMMIT\s*;\s*$/i);
  if(!match)throw failure('MIGRATION_TRANSACTION_WRAPPER_REVIEW_REQUIRED');
  executionSql=match[1];transactionNormalization='STRIP_REVIEWED_OUTER_TRANSACTION_WRAPPER';
 }
 assertNoTransactionControl(executionSql);
 return{executionSql,transactionNormalization,rawSha256};
}
module.exports={prepareMigrationSql,assertNoTransactionControl,visibleSql};

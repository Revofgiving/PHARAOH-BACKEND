'use strict';
const assert=require('node:assert/strict'),{safeSchema,run}=require('./rehearse-postgres-concurrency');
for(const value of ['public','pharaoh_qa_','pharaoh_qa_'+('a'.repeat(24))+';DROP SCHEMA public','other_qa_'+('a'.repeat(24))])assert.throws(()=>safeSchema(value),/SCHEMA_NAME_INVALID/);
assert.equal(safeSchema('pharaoh_qa_'+'a'.repeat(24)),'"pharaoh_qa_'+'a'.repeat(24)+'"');
(async()=>{await assert.rejects(run({}),/ACK_REQUIRED/);await assert.rejects(run({PHARAOH_DISPOSABLE_PG_ACK:'DISPOSABLE_EMPTY_DATABASE',PHARAOH_TEST_DATABASE_URL:'postgres://qa:qa@localhost/production'}),/DISPOSABLE_NAME_REQUIRED/);console.log('PG_CONCURRENCY_GUARD_PASS: 7 assertions, NO database connection or native concurrency test');})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const gate=require('../ops/v4-release-gate'),migrations=require('../ops/db-migrate');

(async()=>{
 let scenarios=0;
 const state=gate.loadReleaseState();
 assert.equal(gate.assertReleaseAllowed(state),state);scenarios++;

 for(const [field,mutate,expected] of [
  ['deployable',s=>{s.deployable=false;},/RELEASE_NOT_MARKED_DEPLOYABLE/],
  ['migrationAllowed',s=>{s.migrationAllowed=false;},/MIGRATIONS_NOT_ALLOWED_FOR_RELEASE/],
  ['registryContractId',s=>{s.registryContractId='PHARAOH_TREASURY_REGISTRY_V3';},/REGISTRY_CONTRACT_ID_NOT_V4/],
  ['registryAbiVersion',s=>{s.registryAbiVersion='3.0.0';},/REGISTRY_ABI_VERSION_NOT_4_0_0/],
  ['tests',s=>{s.testSummary.FAIL=1;s.testSummary.PASS=52;},/TEST_PASS_NOT_53|TEST_FAILURES_PRESENT/]
 ]){
  const bad=JSON.parse(JSON.stringify(state));mutate(bad);
  assert.throws(()=>gate.assertReleaseAllowed(bad),expected,field);scenarios++;
 }

 const docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');
 assert.match(docker,/^RUN node ops\/v4-release-gate\.js && node ops\/deploy-preflight\.js static$/m);scenarios++;
 assert.match(docker,/node ops\/deploy-preflight\.js production && node ops\/integration-preflight\.js && npm run db:migrate && exec node api-server\.js/);scenarios++;
 assert.match(fs.readFileSync(path.join(root,'api-server.js'),'utf8'),/v4-release-gate'\)\.assertReleaseAllowed\(\)/);scenarios++;
 assert.match(fs.readFileSync(path.join(root,'ops/db-migrate.js'),'utf8'),/v4-release-gate'\)\.assertReleaseAllowed\(\)/);scenarios++;
 assert.match(fs.readFileSync(path.join(root,'ops/db-restore.js'),'utf8'),/v4-release-gate'\)\.assertReleaseAllowed\(\)/);scenarios++;
 assert.match(fs.readFileSync(path.join(root,'db-manager.js'),'utf8'),/v4-release-gate'\)\.assertReleaseAllowed\(\)/);scenarios++;
 assert.match(fs.readFileSync(path.join(root,'ops/deploy-preflight.js'),'utf8'),/v4-release-gate'\)\.assertReleaseAllowed\(\)/);scenarios++;

 const baseline=JSON.parse(fs.readFileSync(path.join(root,'evidence/baseline-recovery.json'),'utf8'));let preserved=0,legacyTests=0;
 const securityOverlay=JSON.parse(fs.readFileSync(path.join(root,'evidence/security-overlay-10oct-2026.json'),'utf8'));
 assert.equal(securityOverlay.type,'SECURITY_DEPENDENCY_OVERLAY');
 assert.equal(securityOverlay.file,'package-lock.json');
 assert.equal(securityOverlay.historicalBaselinePreserved,true);
 assert.equal(securityOverlay.auditResult,'0 vulnerabilities');
 let securityOverlayVerified=0;
 for(const item of baseline.files){const p=path.join(root,item.file);assert.ok(fs.existsSync(p),'BASELINE_FILE_MISSING:'+item.file);
  if(item.file.startsWith('database/') && item.file!=='database/migration-plan.json') {
   assert.equal(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),item.sha256,'IMMUTABLE_BASELINE_FILE_CHANGED:'+item.file); preserved++;
  }
  if(item.file==='package-lock.json') {
   const currentSha=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
   assert.equal(securityOverlay.historicalSha256,item.sha256,'SECURITY_OVERLAY_HISTORICAL_SHA_MISMATCH');
   assert.equal(currentSha,securityOverlay.approvedSha256,'SECURITY_OVERLAY_APPROVED_SHA_MISMATCH');
   securityOverlayVerified++;
  }
  if(item.file.startsWith('scripts/test-')) {
   const original=path.join(root,'evidence/legacy-tests-5oct',path.basename(item.file));
   assert.equal(crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex'),item.sha256,'ORIGINAL_TEST_ARCHIVE_CHANGED'); legacyTests++;
  }
 }
 const oldPlan=JSON.parse(fs.readFileSync(path.join(root,'evidence/migration-plan-5oct.json'),'utf8'));
 const plan=JSON.parse(fs.readFileSync(path.join(root,'database/migration-plan.json'),'utf8'));
 // The 0022 SQL is immutable; only its explicitly verified applied checksum is allowed as historical metadata.
 const expectedPlan=JSON.parse(JSON.stringify(oldPlan.migrations));
 const historical0022=expectedPlan.find(x=>x.id==='0022_cassa_posizione_completa');
 assert.ok(historical0022,'HISTORICAL_0022_NOT_IN_BASELINE');
 historical0022.acceptedAppliedSha256=['1e78baf17ebe367332ed99254605b045d13831c57727cd9bda44ef91da86327f'];
 assert.deepEqual(plan.migrations.slice(0,25),expectedPlan,'ONLY_VERIFIED_0022_APPLIED_CHECKSUM_EXCEPTION_ALLOWED');
 assert.equal(migrations.loadPlan().length,30);assert.equal(baseline.matchedFiles,114);
 assert.equal(securityOverlayVerified,1,'SECURITY_OVERLAY_PACKAGE_LOCK_NOT_VERIFIED');scenarios++;

 console.log(`V4_RELEASE_SOURCE_PASS: ${scenarios} scenarios; deployable V4 release gate ALLOW, fail-closed tamper checks, Docker build/runtime preflights wired, ${preserved} SQL baseline files byte-identical, package-lock security overlay verified, original 25 plan records retained, ${legacyTests} original tests archived unchanged; no production deploy executed`);
})().catch(e=>{console.error(e);process.exitCode=1;});

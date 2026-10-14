'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const p=require('../treasury-subwallet-policy');
const m=require('../projects-treasury-manager');
const A=n=>'0x'+String(n).repeat(40);

assert.equal(m.normalizePurpose('HUMANITARIAN'),'PROJECTS_HUMANITARIAN_OUT');
assert.equal(m.normalizePurpose('maintenance'),'PROJECTS_MAINTENANCE_OUT');
assert.throws(()=>m.normalizePurpose('ARBITRARY'),/FORBIDDEN/);

const rows=[
 {bucket_key:'A',balance_atomic:String(300n*p.DECIMALS)},
 {bucket_key:'B',balance_atomic:String(400n*p.DECIMALS)}
];
const plan=m.fundingPlan(rows,500n*p.DECIMALS);
assert.deepEqual(plan,[{key:'A',amountAtomic:300n*p.DECIMALS},{key:'B',amountAtomic:200n*p.DECIMALS}]);
assert.throws(()=>m.fundingPlan(rows,701n*p.DECIMALS),/INSUFFICIENT/);

const transfer=fs.readFileSync(path.join(__dirname,'../treasury-transfer-manager.js'),'utf8');
assert.doesNotMatch(transfer,/PROJECTS_DIRECT_OUTGOING_DEFERRED_TO_CONTRACT_PHASE/);
assert.match(transfer,/PROJECTS_OUT_PURPOSES/);
assert.deepEqual(p.PROJECTS_OUT_PURPOSES,['PROJECTS_HUMANITARIAN_OUT','PROJECTS_MAINTENANCE_OUT']);
assert.match(transfer,/PROJECTS_SETTLED_STRUCTURAL_CAPITAL_REQUIRED/);

const chain=fs.readFileSync(path.join(__dirname,'../treasury-chain-adapter.js'),'utf8');
assert.match(chain,/PHARAOH_PROJECTS_PRIVATE_KEY/);
assert.match(chain,/PHARAOH_PROJECTS_SIGNING_MODE/);
assert.match(chain,/PROJECTS_MANUAL_SIGNATURE_REQUIRED/);

const security=fs.readFileSync(path.join(__dirname,'../security-manager.js'),'utf8');
assert.match(security,/PHARAOH_PROJECTS_WALLET/);
assert.match(security,/PHARAOH_PROJECTS_SIGNING_MODE/);
assert.match(security,/PHARAOH_GEMELLI_WALLET/);
assert.match(security,/PHARAOH_GEMELLI_SIGNING_MODE/);
assert.match(security,/CASSE_PHARAOH_PROGETTI_ROG_URANUS_DEVONO_ESSERE_DISTINTE/);

const deployPreflight=fs.readFileSync(path.join(__dirname,'../ops/deploy-preflight.js'),'utf8');
assert.match(deployPreflight,/CHIAVE_PROJECTS_NON_CORRISPONDE_AL_WALLET/);
assert.match(deployPreflight,/CHIAVE_GEMELLI_NON_CORRISPONDE_AL_WALLET/);

const admin=fs.readFileSync(path.join(__dirname,'../economic-admin.js'),'utf8');
assert.match(admin,/\/api\/admin\/economy\/projects\/prepare/);
assert.match(admin,/requireAdminKey/);

const worker=fs.readFileSync(path.join(__dirname,'../economic-worker.js'),'utf8');
assert.match(worker,/PROJECTS_HUMANITARIAN_OUT/);
assert.match(worker,/PROJECTS_MAINTENANCE_OUT/);
assert.match(worker,/destinationWallet:row\.destination_wallet/);

console.log('PROJECTS_TREASURY_V4_FLOW_PASS: prepare -> durable reserve -> verified transfer -> Registry V4 wiring present; no RPC or deploy');

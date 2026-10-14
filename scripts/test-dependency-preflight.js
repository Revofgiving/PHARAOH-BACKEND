'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {inspectDependencies}=require('../ops/dependency-preflight');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pharaoh-deps-'));
let n=0;const check=(name,f)=>{f();n++;console.log('PASS '+name);};
try {
  const file=path.join(dir,'package-lock.json');
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({dependencies:{ethers:'^6.17.0'}}));
  const lock={lockfileVersion:3,packages:{'':{},'node_modules/ethers':{version:'6.17.0'},'node_modules/ethers/node_modules/test-dep':{version:'1.0.0'}}};
  fs.writeFileSync(file,JSON.stringify(lock));
  check('missing packages are not a test PASS',()=>{const r=inspectDependencies(dir);assert.equal(r.installComplete,false);assert.equal(r.counts.MISSING,2);assert.equal(r.direct[0].expected,'6.17.0');});
  const pkg=path.join(dir,'node_modules/ethers');fs.mkdirSync(pkg,{recursive:true});
  fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'6.16.0',main:'must-not-execute.js'}));
  fs.writeFileSync(path.join(pkg,'must-not-execute.js'),"throw Error('PACKAGE_EXECUTED');");
  check('older dependency cannot silently satisfy frozen lockfile',()=>assert.equal(inspectDependencies(dir).counts.VERSION_MISMATCH,1));
  fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'6.17.0'}));
  check('top-level match does not hide missing transitive dependency',()=>{const r=inspectDependencies(dir);assert.equal(r.installComplete,false);assert.equal(r.counts.VERSION_MATCH,1);assert.equal(r.counts.MISSING,1);});
  fs.mkdirSync(path.join(pkg,'node_modules/test-dep'),{recursive:true});fs.writeFileSync(path.join(pkg,'node_modules/test-dep/package.json'),JSON.stringify({version:'1.0.0'}));
  check('all matching metadata is explicitly not an integrity or E2E certificate',()=>{const r=inspectDependencies(dir);assert.equal(r.installComplete,true);assert.match(r.scope,/not tarball integrity/);});
  lock.packages['../outside']={version:'1.0.0'};fs.writeFileSync(file,JSON.stringify(lock));
  check('path traversal is rejected',()=>assert.throws(()=>inspectDependencies(dir),/NOT_SUPPORTED/));
  delete lock.packages['../outside'];lock.packages['node_modules/link']={version:'1.0.0',link:true};fs.writeFileSync(file,JSON.stringify(lock));
  check('symlink/workspace lock entries are not guessed',()=>assert.throws(()=>inspectDependencies(dir),/NOT_SUPPORTED/));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
console.log(`DEPENDENCY_PREFLIGHT_PASS: ${n} temporary filesystem scenarios; no package code executed`);

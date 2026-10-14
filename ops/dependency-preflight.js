'use strict';
/** No package execution, network, npm install, secrets or DB access. */
const fs = require('node:fs');
const path = require('node:path');
function inspectDependencies(root = path.resolve(__dirname, '..')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (!lock.packages || ![2,3].includes(lock.lockfileVersion)) throw new Error('LOCKFILE_FORMAT_NOT_SUPPORTED');
  const results = [];
  for (const [location, expected] of Object.entries(lock.packages)) {
    if (!location) continue;
    if (!location.startsWith('node_modules/') || location.split('/').includes('..') || expected.link) {
      throw new Error('LOCKFILE_NON_REGISTRY_LOCATION_NOT_SUPPORTED');
    }
    let actual;
    try {
      const file=path.join(root,location,'package.json');
      const real=fs.realpathSync(file);
      if(!real.startsWith(fs.realpathSync(root)+path.sep)) throw new Error('DEPENDENCY_LINK_OUTSIDE_ROOT');
      actual = JSON.parse(fs.readFileSync(file,'utf8'));
    }
    catch (error) {
      results.push({location, expected:expected.version, status:error.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE'});
      continue;
    }
    results.push({location, expected:expected.version, installed:actual.version,
      status:actual.version === expected.version ? 'VERSION_MATCH' : 'VERSION_MISMATCH'});
  }
  const direct = Object.entries(manifest.dependencies || {}).map(([name, requested]) => ({name,requested,
    ...results.find(r => r.location === `node_modules/${name}`)}));
  return {scope:'Installed package metadata vs existing lockfile; not tarball integrity or test certification',
    installComplete:results.length>0 && results.every(r => r.status === 'VERSION_MATCH'),
    totalLocked:results.length, counts:results.reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1;return a;},{}), direct, results};
}
if (require.main === module) {
  try { const report=inspectDependencies(); console.log(JSON.stringify(report,null,2)); if(!report.installComplete)process.exitCode=1; }
  catch (_) { console.error('DEPENDENCY_INSPECTION_FAILED'); process.exitCode=1; }
}
module.exports = {inspectDependencies};

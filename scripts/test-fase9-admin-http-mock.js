'use strict';
// Fase 9: executes REAL admin-routes handlers + exact requireAdminKey source
// behind a Node HTTP test harness. PostgreSQL is simulated; NOT HTTP+PG E2E.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const Module = require('node:module');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const originalLoad = Module._load;
const calls = [];
const mockPg = {
  queryMany: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('pharaoh_gas_reserve_entries')) return [{payout_id:'11',account_id:'3',amount_atomic:'5000000',status:'AVAILABLE'}];
    if (sql.includes('pharaoh_gas_conversion_events')) return [{id:'22',conversion_id:'7',event_type:'PREPARATA',actor:'ADMIN_KEY_AUTHENTICATED'}];
    return [];
  }
};
const registrations = [];
const app = new Proxy({}, {get:(_, method) => (route, ...handlers) => {registrations.push({ method, route, handlers });}});
const multer = () => ({single: () => (_req,_res,next) => next()});
multer.memoryStorage = () => ({});
// Intercept only module dependencies needed for registration; never alter source files.
Module._load = function(request, parent, isMain) {
  if(request === 'multer') return multer;
  if(request === './gas-conversion-manager') return {balances:async()=>({availableUsdc:'5.00'})};
  if(request === './pg-connection-manager') return mockPg;
  return originalLoad.call(this, request, parent, isMain);
};
let registerAdminRoutes;
try { ({registerAdminRoutes} = require('../admin-routes')); }
catch(e) { Module._load = originalLoad; throw e; }
// Compile exact production middleware function, including constant-time comparison.
const securitySrc = fs.readFileSync(path.join(root,'security-manager.js'),'utf8');
function extract(name){
 const start=securitySrc.indexOf(`function ${name}(`);
 assert.ok(start>=0,`missing ${name}`);
 const brace=securitySrc.indexOf('{',start);
 let level=0;
 for(let i=brace;i<securitySrc.length;i++){
   if(securitySrc[i]==='{')level++;
   if(securitySrc[i]==='}' && --level===0)return securitySrc.slice(start,i+1);
 }
 throw new Error('unclosed '+name);
}
// Use authenticated setup; no environment variables containing live secrets.
process.env.NODE_ENV='production';
process.env.ADMIN_API_KEY='FASE9_ONLY_LOCAL_KEY_NOT_VALID_IN_PRODUCTION';
const context = vm.createContext({process,crypto,Buffer,securityLog:()=>{}});
vm.runInContext([extract('safeSecretEqual'),extract('requireAdminKey')].join('\n'),context);
const requireAdminKey = context.requireAdminKey;
try {registerAdminRoutes({app,pg:mockPg,security:{requireAdminKey,sanitizeString:x=>x,assertNoSecretSetting:()=>{},sanitizeError:e=>String(e)}}); }
finally { Module._load = originalLoad; }
const paths = registrations.filter(x=> x.route.includes('/gas-reserve/'));
const targetRoutes = ['/api/admin/gas-reserve/entries','/api/admin/gas-reserve/conversions/:id/events'];
for(const route of targetRoutes){
 const r=paths.find(x=>x.route===route && x.method==='get');
 assert.ok(r,'missing GET '+route);
 assert.equal(r.handlers[0],requireAdminKey,'admin auth middleware not first');
}
const server = http.createServer(async(req,res)=>{
  const url = new URL(req.url,'http://localhost');
  const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  const match = paths.find(x=> x.method===req.method.toLowerCase() && (x.route===url.pathname || (x.route.endsWith('/:id/events') && /^\/api\/admin\/gas-reserve\/conversions\/[^/]+\/events$/.test(url.pathname))));
  if(!match)return send(404,{error:'NOT_FOUND'});
  const result={req:{headers:req.headers,query:Object.fromEntries(url.searchParams),params:{id:url.pathname.split('/')[5] || ''}},
    res:{status(s){this.code=s;return this;},json(obj){send(this.code||200,obj);return this;}}};
  // Execute same middleware+handler in original order; errors fail closed.
  let i=0;
  const next=()=>{ const fn=match.handlers[i++]; if(fn)Promise.resolve(fn(result.req,result.res,next)).catch(e=>send(500,{error:e.message})); };
  next();
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 let count=0;
 async function check(name,path,key,expected,validate){
   const r=await fetch(base+path,{headers:key?{'X-Admin-Key':key}:{}});
   const data=await r.json();
   assert.equal(r.status,expected,`${name}: ${JSON.stringify(data)}`);
   if(validate)validate(data);
   console.log('PASS',name,r.status);count++;
 }
 const good=process.env.ADMIN_API_KEY;
 await check('entries-no-key','/api/admin/gas-reserve/entries',null,401);
 await check('entries-bad-key','/api/admin/gas-reserve/entries','bad',401);
 await check('entries-query-key-denied','/api/admin/gas-reserve/entries?admin_key='+encodeURIComponent(good),null,401);
 await check('entries-valid-key','/api/admin/gas-reserve/entries',good,200,d=>assert.equal(d.entries[0].payout_id,'11'));
 await check('events-no-key','/api/admin/gas-reserve/conversions/7/events',null,401);
 await check('events-valid-key','/api/admin/gas-reserve/conversions/7/events',good,200,d=>assert.equal(d.events[0].conversion_id,'7'));
 await check('events-invalid-id','/api/admin/gas-reserve/conversions/invalid/events',good,400);
 await check('events-sql-injection','/api/admin/gas-reserve/conversions/7%27%20OR%201=1/events',good,400);
 assert.equal(calls.length,2,'unexpected database calls for unauthorized/invalid requests');
 assert.ok(calls[0].sql.includes('LIMIT 200'));
 assert.ok(calls[1].sql.includes('conversion_id=$1'));
 assert.deepEqual(calls[1].params,['7']);
 console.log('PASS SQL parameterized, bounded, authenticated; queries:',calls.length);
 console.log('FASE9_HTTP_MOCK_PASS',count,'requests; PostgreSQL SIMULATED');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());

'use strict';
const assert=require('node:assert/strict');
const {publicConfig,atomicToUsdc,readChain}=require('../ops/public-runtime-inspection');
const A='0x1234567890123456789012345678901234567890';
let n=0;async function check(name,f){await f();n++;console.log('PASS '+name);}
function fixture(){
 let network=137n,hash='0xabc',after=false;const calls=[];
 const config={PHARAOH_FUND_A_WALLET:A,PHARAOH_TREASURY_WALLET:A,PHARAOH_REGISTRY_ADDRESS:A,USDC_CONTRACT_ADDRESS:A};
 const provider={getNetwork:async()=>({chainId:network}),getBlockNumber:async()=>123,
   getBlock:async b=>{calls.push(['block',b]);return {hash:after?hash:'0xabc'};},
   getCode:async(a,b)=>{calls.push(['code',b]);return '0x1234';}};
 const registry={};for(const [name,value] of Object.entries({CONTRACT_ID:'0xid',CONTRACT_VERSION:'3.0.0',pharaohTreasury:A,MAX_SINGLE_AMOUNT:500000000000n,MAX_VOLUME_PER_HOUR:1000000000000n})) registry[name]=async o=>{calls.push([name,o.blockTag]);return value;};
 const token={decimals:async()=>6n,balanceOf:async(a,o)=>{calls.push(['balanceOf',o.blockTag]);after=true;return 500000000n;}};
 return {config,provider,registry,token,calls,wrongChain:()=>network=1n,reorganize:()=>hash='0xchanged'};
}
(async()=>{
 await check('only explicit public addresses can be printed',()=>{const c=publicConfig({PHARAOH_TREASURY_WALLET:A,PHARAOH_PAYOUT_PRIVATE_KEY:'SECRET',DATABASE_URL:'SECRET',POLYGON_RPC_URL:'SECRET'});assert.equal(c.PHARAOH_TREASURY_WALLET,A);assert.ok(!JSON.stringify(c).includes('SECRET'));assert.equal(c.PHARAOH_FUND_A_WALLET,null);});
 await check('malformed values cannot leak secrets through public fields',()=>{const c=publicConfig({PHARAOH_FUND_A_WALLET:'not-an-address-SECRET'});assert.equal(c.PHARAOH_FUND_A_WALLET,null);});
 await check('example placeholders are never certified as real wallets',()=>assert.equal(publicConfig({PHARAOH_FUND_A_WALLET:'0x0000000000000000000000000000000000000001'}).PHARAOH_FUND_A_WALLET,null));
 await check('atomic values remain exact at large amounts',()=>{assert.equal(atomicToUsdc(500000000000n),'500000.000000');assert.equal(atomicToUsdc(50000000001n),'50000.000001');assert.throws(()=>atomicToUsdc(-1n));});
 await check('read-only snapshot exposes actual registry limit, not desired limit',async()=>{const f=fixture(),r=await readChain(f);assert.equal(r.registryMaxSingleAmountUsdc,'500000.000000');assert.equal(r.registryMaxHourlyVolumeUsdc,'1000000.000000');assert.equal(r.blockNumber,123);assert.match(r.note,/not free spendable/);assert.ok(f.calls.every(([,block])=>block===123));});
 await check('wrong chain fails before contract access',async()=>{const f=fixture();f.wrongChain();await assert.rejects(readChain(f),/WRONG_CHAIN/);assert.equal(f.calls.length,0);});
 await check('reorganization invalidates snapshot',async()=>{const f=fixture();f.reorganize();await assert.rejects(readChain(f),/REORGANIZED/);});
 await check('wrong token decimals fail closed',async()=>{const f=fixture();f.token.decimals=async()=>18n;await assert.rejects(readChain(f),/DECIMALS/);});
 await check('contract must have bytecode',async()=>{const f=fixture();f.provider.getCode=async()=> '0x';await assert.rejects(readChain(f),/NO_CODE/);});
 console.log(`PUBLIC_INSPECTION_PASS: ${n} pure/mock scenarios; no live RPC or blockchain writes`);
})().catch(e=>{console.error(e);process.exitCode=1;});

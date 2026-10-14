'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),A=require('../economic-amounts');
function fixture(){
 const s={funded:true,previous:true,first:true,slot:null,created:0,updates:0,reservations:0};
 const reservation={id:8,tipo_funzione:'CONTINUITA_RHA',funzione_id:null,account_destinazione_id:null,account_destinazione_wallet:null,numero_posizionale:null,livello_destinazione:3,tavola_relativa:7,casella:2,turno_destinazione:2,tavola_numero:null,account_origine_id:11};
 const client={async query(sql,params){
  if(sql.startsWith('SELECT id FROM turni'))return {rows:[{id:20}]};
  if(sql.includes('SELECT * FROM posizioni'))return {rows:s.slot?[s.slot]:[]};
  if(sql.includes('SELECT id FROM posizioni'))return {rows:s.first?[{id:99}]:[]};
  if(sql.startsWith('UPDATE tavole SET doni_ricevuti'))s.updates++;
  if(sql.startsWith('UPDATE '))return {rows:[],rowCount:1};
  throw Error('UNEXPECTED SQL:'+sql);
 }};
 const db={async createPrenotazioneFunzione(input,c){assert.equal(c,client);assert.equal(input.accountDestinazioneWallet,null);assert.equal(input.accountDestinazioneId,null);assert.equal(input.numeroPosizionale,null);assert.equal(input.funzioneId,null);s.reservations++;return {...reservation};},async createPosizione(input,c){assert.equal(c,client);s.created++;s.slot={id:10,tipo:input.tipo,wallet:input.wallet,account_id:null,account_sigla:null,numero_posizionale:null,sdoppiamento_tavola_id:null,dono_importo:input.donoImporto};return s.slot;}};
 const ledger={async ready(){},store:{async movement(){return s.previous?{purpose:'CONTINUITY_IN',amount_atomic:'500000000'}:null;},async event(){return s.funded?{status:'COMPLETED'}:null;}}};
 const box={module:{exports:{}},require(name){if(name==='./economic-amounts')return A;if(name==='./db-manager')return db;if(name==='./economic-ledger')return {configuredLedger(c){assert.equal(c,client);return ledger;}};throw Error(name);}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','continuity-manager.js'),'utf8'),box);
 return {s,client,reservation,manager:box.module.exports,table:{id:30,livello:3,turno:2,numero:70},account:{id:11,tipo:'PERPETUO',wallet:'0x'+'1'.repeat(40)}};
}
async function main(){let cases=0,f=fixture();
 await f.manager.reserve({account:f.account,turnNumber:1},f.client);assert.equal(f.s.reservations,1);cases++;
 f=fixture();await assert.rejects(f.manager.reserve({account:{...f.account,tipo:'PRIMARIO'},turnNumber:1},f.client),/ONLY_AFTER_PERPETUO/);cases++;
 f=fixture();f.s.previous=false;await assert.rejects(f.manager.reserve({account:f.account,turnNumber:1},f.client),/PREFUNDING/);cases++;
 f=fixture();await assert.rejects(f.manager.reserve({account:f.account,turnNumber:NaN},f.client),/TURN_INVALID/);cases++;
 f=fixture();let p=await f.manager.materialize({reservation:f.reservation,table:f.table,turnNumber:2},f.client);assert.equal(p.wallet,null);assert.equal(p.account_id,null);assert.equal(f.s.created,1);assert.equal(f.s.updates,1);cases++;
 await f.manager.materialize({reservation:f.reservation,table:f.table,turnNumber:2},f.client);assert.equal(f.s.created,1);assert.equal(f.s.updates,1);cases++;
 f=fixture();f.s.funded=false;await assert.rejects(f.manager.materialize({reservation:f.reservation,table:f.table,turnNumber:2},f.client),/FUNDED_TURN/);assert.equal(f.s.created,0);cases++;
 f=fixture();f.s.first=false;await assert.rejects(f.manager.materialize({reservation:f.reservation,table:f.table,turnNumber:2},f.client),/PRECEDING_SLOT/);cases++;
 f=fixture();f.reservation.account_destinazione_wallet=f.account.wallet;await assert.rejects(f.manager.materialize({reservation:f.reservation,table:f.table,turnNumber:2},f.client),/IDENTITY_OR_SLOT/);cases++;
 f=fixture();f.reservation.turno_destinazione=3;await assert.rejects(f.manager.materialize({reservation:f.reservation,table:f.table,turnNumber:2},f.client),/TABLE_MISMATCH/);cases++;
 f=fixture();f.s.slot={tipo:'GEMELLO',wallet:f.account.wallet};await assert.rejects(f.manager.materialize({reservation:f.reservation,table:f.table,turnNumber:2},f.client),/SLOT_ALREADY_OCCUPIED/);cases++;
 f=fixture();f.reservation.tavola_numero=71;await assert.rejects(f.manager.materialize({reservation:f.reservation,table:f.table,turnNumber:2},f.client),/TABLE_MISMATCH/);cases++;
 console.log(JSON.stringify({test:'continuity-runtime',status:'PASS',cases,scope:'real continuity manager with transaction/ledger/SQL doubles; NO real PostgreSQL or multi-turn progression E2E'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

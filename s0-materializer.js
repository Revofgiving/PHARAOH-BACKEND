'use strict';
/** Actual S0 materialization, not a planner. All calls require ONE transaction
 * covering funding, accounts, positions, numbering, H/P and the completion queue.
 * Transaction ownership remains with DIRECT/GIFT/cross/exit callers.
 */
const A=require('./economic-amounts');
const {classifyGeneratedBatch,UNIT_ATOMIC}=require('./s0-generated-batch-policy');
const {normalizeHumanOrigin}=require('./s0-confirmed-economics');
const {configuredLedger}=require('./economic-ledger');
function sameEconomics(row,spec) {
  return row && String(row.root_account_id)===String(spec.rootAccountId) && row.position_class===spec.positionClass &&
    row.owner_wallet===spec.ownerWallet && row.custody_wallet===spec.custodyWallet;
}
class S0Materializer {
  constructor({ledger,placement,config}) { this.ledger=ledger;this.store=ledger.store;this.placement=placement;this.config=config; }
  async checkedCounters() {
    const c=await this.store.counters();
    if(!c?.seeded) throw A.error('S0_COUNTER_CUTOVER_REQUIRED');
    const h=A.atomic(c.human_cumulative),p=A.atomic(c.piletta_cumulative);
    if(p>h)throw A.error('S0_COUNTER_INVARIANT_BROKEN');
    return {h,p};
  }
  async root({eventKey,index,positionClass,origin,sourceAccountId,name,beneficiaryWallet}) {
    const system=positionClass==='PILETTA';
    const owner=system?null:A.address(beneficiaryWallet);
    const custody=system?A.address(this.config.treasuryWallet):owner;
    if(positionClass==='FONDO_A' && owner!==A.address(this.config.fundAWallet))throw A.error('FONDO_A_OWNER_MISMATCH');
    const accountKey=`S0:${A.digest({eventKey,index})}`;
    let account=await this.placement.getAccountByKey(accountKey);
    if(!account)account=await this.placement.createRoot({wallet:custody,nome:name || positionClass,tipo:'PRIMARIO',accountKey,
      sourceAccountId:sourceAccountId || null,sourceEventKey:eventKey,originKind:origin});
    if(account.tipo!=='PRIMARIO' || A.address(account.wallet)!==custody || String(account.account_key)!==accountKey)throw A.error('S0_ROOT_IDENTITY_CONFLICT');
    const economics={accountId:account.id,rootAccountId:account.id,positionClass,ownerWallet:owner,custodyWallet:custody,origin,sourceEventKey:eventKey};
    if(!sameEconomics(await this.store.putEconomics(economics),economics))throw A.error('ACCOUNT_ECONOMICS_CONFLICT');
    return account;
  }
  async one({eventKey,index,positionClass,origin,sourceAccountId,name,beneficiaryWallet,fundingBucket,remaining}) {
    const account=await this.root({eventKey,index,positionClass,origin,sourceAccountId,name,beneficiaryWallet});
    const placed=await this.placement.place(account);
    if(!placed?.positionId || !placed.accountId || String(placed.accountId)!==String(account.id) || !placed.personalTableId)throw A.error('S0_PLACEMENT_INCOMPLETE');
    const n=A.positive(placed.number,'POSITION_NUMBER');
    if(n>=26n && (n-26n)%14n===0n)throw A.error('S0_RESERVED_NUMBER_ASSIGNED');
    await this.ledger.reallocate({eventKey:`S0_FUND:${A.digest({eventKey,index})}`,
      inputs:[{key:fundingBucket,amountAtomic:UNIT_ATOMIC}],
      outputs:[{key:`S0_TABLE:${placed.tableId}`,wallet:this.config.treasuryWallet,purpose:'S0_TABLE',amountAtomic:UNIT_ATOMIC}],
      context:{positionId:String(placed.positionId),accountId:String(account.id),positionClass}});
    await this.store.membership({positionId:placed.positionId,accountId:account.id,eventKey,index,positionClass,origin,number:n,amountAtomic:UNIT_ATOMIC});
    const h=positionClass==='HUMAN'?1n:0n,p=positionClass==='PILETTA'?1n:0n;
    if(!await this.store.incrementCounters(h,p))throw A.error('S0_COUNTER_UPDATE_FAILED');
    if(placed.completed)await this.placement.queueCompleted({placed,eventKey,index,remaining});
    return {...placed,positionClass,origin,ownerWallet:positionClass==='PILETTA'?null:beneficiaryWallet,index};
  }
  async external({eventKey,origin,beneficiaryWallet,name=null,count,fundingBucket}) {
    origin=normalizeHumanOrigin(origin);
    const n=A.positive(count,'POSITION_COUNT');if(n>100n)throw A.error('S0_EXTERNAL_BATCH_TOO_LARGE');
    const beneficiary=A.address(beneficiaryWallet);
    const context={origin,beneficiary,name,count:n,fundingBucket};
    return this.ledger.event(eventKey,'S0_EXTERNAL_MATERIALIZATION',context,async()=>{
      await this.checkedCounters();
      const funding=await this.store.bucket(fundingBucket);
      if(!funding || funding.wallet!==A.address(this.config.treasuryWallet) || !['EXTERNAL_ENTRY','GIFT_ENTRY'].includes(funding.purpose) || A.atomic(funding.balance_atomic)<n*UNIT_ATOMIC)throw A.error('S0_EXTERNAL_FUNDING_REQUIRED');
      const positions=[];
      for(let i=1;i<=Number(n);i++)positions.push(await this.one({eventKey,index:i,positionClass:'HUMAN',origin,sourceAccountId:null,name,beneficiaryWallet:beneficiary,fundingBucket,remaining:Number(n)-i}));
      return {status:'MATERIALIZED',count:n,humanDelta:n,pilettaDelta:0n,positions};
    });
  }
  async generated({eventKey,source,sourceAccountId,sourceLevel,amountAtomic,fundingBucket}) {
    const amount=A.positive(amountAtomic);const count=amount/UNIT_ATOMIC;
    if(amount%UNIT_ATOMIC || count>250n)throw A.error('S0_GENERATED_BATCH_INVALID');
    if(source==='THOT' && amount!==A.usdc('500'))throw A.error('THOT_GENERATION_MUST_BE_FIVE');
    if(source==='ISIDE' && amount!==A.usdc('5000'))throw A.error('ISIDE_GENERATION_MUST_BE_FIFTY');
    const context={source,sourceAccountId:String(A.positive(sourceAccountId)),sourceLevel,amount,fundingBucket};
    return this.ledger.event(eventKey,'S0_GENERATED_MATERIALIZATION',context,async()=>{
      const sourceAccount=await this.placement.getAccountById(sourceAccountId);
      if(!sourceAccount)throw A.error('GENERATED_SOURCE_ACCOUNT_MISSING');
      if(['THOT','ISIDE'].includes(source) && (!['PERPETUO','GEMELLO'].includes(sourceAccount.tipo) || sourceLevel!==source))throw A.error('GENERATED_SOURCE_NOT_SECONDARY_EXIT');
      if(source==='PILETTA_REINVESTMENT') {
        const economics=await this.store.economics(sourceAccount.id);
        const {planExitNet}=require('./s0-confirmed-economics');
        if(economics?.position_class!=='PILETTA')throw A.error('REINVESTMENT_REQUIRES_PILETTA');
        if(planExitNet({positionClass:'PILETTA',accountType:sourceAccount.tipo,level:sourceLevel}).netAtomic!==amount)throw A.error('PILETTA_REINVESTMENT_AMOUNT_MISMATCH');
      }
      const c=await this.checkedCounters();
      const funding=await this.store.bucket(fundingBucket);
      if(!funding || funding.purpose!=='GENERATED_S0' || funding.wallet!==A.address(this.config.treasuryWallet))throw A.error('GENERATED_FUNDING_RESERVE_REQUIRED');
      const plan=classifyGeneratedBatch({source,amountAtomic:amount,settledAvailableAtomic:A.atomic(funding.balance_atomic),humanExternalCumulative:c.h,pilettaS0Cumulative:c.p});
      const positions=[];
      for(let i=1;i<=Number(count);i++) {
        const positionClass=BigInt(i)<=plan.pilettaToCreate?'PILETTA':'FONDO_A';
        positions.push(await this.one({eventKey,index:i,positionClass,origin:source,sourceAccountId:sourceAccount.id,
          name:positionClass,beneficiaryWallet:positionClass==='FONDO_A'?A.address(this.config.fundAWallet):null,fundingBucket,remaining:Number(count)-i}));
      }
      const after=await this.checkedCounters();
      if(after.h!==c.h || after.p!==c.p+plan.pilettaToCreate)throw A.error('GENERATED_COUNTER_POSTCONDITION_FAILED');
      return {status:'MATERIALIZED',count,pilettaCreated:plan.pilettaToCreate,fondoACreated:plan.fondoAToCreate,humanDelta:0n,positions};
    });
  }
}
function configuredMaterializer(client) {
  const db=require('./db-manager'),tables=require('./table-manager');
  const placement={
    getAccountByKey:key=>db.getAccountByKey(key,client),
    getAccountById:id=>db.getAccountById(id,client),
    createRoot:async input=>{
      const account=await db.createAccount(input,client);
      return db.updateAccountIdentity(account.id,{rootAccountId:account.id},client);
    },
    async place(account) {
      const turno=await db.getTurnoCorrente('ENTRATA',0,client);
      if(!turno)throw A.error('S0_ACTIVE_TURN_MISSING');
      const table=await tables.getTavolaPercorsoAttiva(0,turno.numero_turno,client);
      if(!table)throw A.error('S0_ACTIVE_TABLE_MISSING');
      const p=await tables.posizionaDonatore({tavolaId:table.id,tavolaNumero:table.numero,livello:0,wallet:account.wallet,
        nome:account.nome,tipo:'DONATORE',donoImporto:100,turno:turno.numero_turno,sdoppiabile:true,accountId:account.id,accountSigla:account.sigla,client});
      const updated=await db.setAccountNumeroPosizionale(account.id,p.numeroPosizionaleGlobale,client,{setSiglaIfNull:true});
      await db.syncEntryPlacementIdentity({posizioneId:p.posizione.id,tavolaSdoppiamentoId:p.tavolaSdoppiamento.id,accountId:account.id,accountSigla:updated.sigla},client);
      await db.incrementSacerdotiEntrati(turno.id,client);
      return {positionId:p.posizione.id,accountId:account.id,number:updated.numero_posizionale,sigla:updated.sigla,
        tableId:table.id,tableNumber:table.numero,slot:p.casellaOccupata,personalTableId:p.tavolaSdoppiamento.id,
        personalTableNumber:p.tavolaSdoppiamento.numero,completed:p.tavolaCompleta,turnId:turno.id,turnNumber:turno.numero_turno,
        heirAccountId:table.faraone_account_id,heirWallet:table.faraone_wallet};
    },
    async queueCompleted({placed,eventKey,remaining}) {
      if(!placed.heirAccountId)throw A.error('S0_HEIR_ACCOUNT_ID_REQUIRED');
      const heir=await db.getAccountById(placed.heirAccountId,client);if(!heir)throw A.error('S0_HEIR_ACCOUNT_MISSING');
      const first=Number(placed.tableNumber)===1;
      if(first && remaining>0)throw A.error('S0_BOOTSTRAP_SETTLEMENT_REQUIRED_BEFORE_NEXT_TABLE');
      // The capital may still be awaiting the first settled transfer. In that
      // case the durable completion worker opens table 2 after reconciliation.
      let advanced=false;
      if(!first) {
        await require('./donation-flow-manager').avviaNuovoTurnoEntrata({id:placed.turnId,numero_turno:placed.turnNumber},client);
        advanced=true;
      }
      await db.createPostCommitOperation({eventKey:`S0_COMPLETE:${placed.tableId}`,operationType:'USCITA_ENTRATA_POST_COMMIT',
        txHash:null,sourceTavolaId:placed.tableId,sourceTavolaNumero:placed.tableNumber,turnoId:placed.turnId,
        turnoNumero:placed.turnNumber,wallet:heir.wallet,payload:{nomeErede:heir.nome,isFondo:heir.tipo==='FONDO',doniRicevuti:600,
          turnoEntrataAvviatoNelBatch:advanced,eredeAccountId:heir.id,eredeAccountSigla:heir.sigla,
          economicModel:'V4',sourceEventKey:eventKey}},client);
    }
  };
  return new S0Materializer({ledger:configuredLedger(client),placement,config:{treasuryWallet:process.env.PHARAOH_TREASURY_WALLET,fundAWallet:process.env.PHARAOH_FUND_A_WALLET}});
}
module.exports={S0Materializer,configuredMaterializer,sameEconomics};

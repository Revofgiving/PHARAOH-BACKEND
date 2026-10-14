'use strict';
/** Runtime allocations shared by S0, progression, exits and payment workers.
 * Amounts are atomic USDC integers. No function here performs an ERC20 transfer.
 * The caller owns ONE PostgreSQL transaction for both legacy rows and the ledger.
 */
const A = require('./economic-amounts');
const { configuredLedger } = require('./economic-ledger');
const { configuredMaterializer } = require('./s0-materializer');
const { planExitNet, normalizeHumanOrigin } = require('./s0-confirmed-economics');
const { UNIT_ATOMIC } = require('./s0-generated-batch-policy');
function exitKeys(eventKey) {
  const prefix = `EXIT:${A.digest(A.key(eventKey))}`;
  return Object.fromEntries(['NET','GENERATED','PROJECTS','ROG','URANUS','NEXT_GEMELLI'].map(k => [k,`${prefix}:${k}`]));
}
function progressionBucket(accountId, level) { return `PROGRESSION:${A.positive(accountId)}:L${level}`; }
function turnBucket(turnId, level) { return level === 'RHA' ? `B1_TURN:${A.positive(turnId)}` : `L${level === 'THOT' ? 4 : 5}_TURN:${A.positive(turnId)}`; }
class EconomicFlow {
  constructor({ ledger, materializer, config }) { this.ledger=ledger; this.store=ledger.store; this.materializer=materializer; this.config=config; }
  treasury() { return A.address(this.config.treasuryWallet); }
  bucket(key, purpose, amount) { return {key,wallet:this.treasury(),purpose,amountAtomic:A.positive(amount)}; }
  async holdExternalPayment({origin,payer,count,txHash,proof}) {
    origin=normalizeHumanOrigin(origin);
    const amount=A.positive(count)*UNIT_ATOMIC;
    const funding=`ENTRY_PROOF:${A.hash(txHash)}`;
    await this.ledger.incoming({eventKey:`CREDIT:${funding}`,bucket:{key:funding,wallet:this.treasury(),purpose:origin==='GIFT'?'GIFT_ENTRY':'EXTERNAL_ENTRY'},
      verification:{valida:true,proof},from:payer,amountAtomic:amount,txHash});
    return funding;
  }
  async admitExternal({eventKey,origin,payer,beneficiaryWallet,name=null,count,txHash,proof}) {
    origin=normalizeHumanOrigin(origin);
    // A prepaid Smartbox may already hold this exact proof. Replaying the same
    // immutable credit event is a read, not a second balance increase.
    const funding=await this.holdExternalPayment({origin,payer,count,txHash,proof});
    return this.materializer.external({eventKey:`ENTRY:${A.digest({eventKey,origin})}`,origin,beneficiaryWallet,name,count,fundingBucket:funding});
  }
  async inherit(parentId, child) {
    await this.ledger.ready();
    const parent=await this.store.economics(parentId);
    if(!parent) throw A.error('ACCOUNT_ECONOMIC_CLASSIFICATION_REQUIRED',{accountId:parentId});
    if(A.address(child.wallet)!==parent.custody_wallet) throw A.error('SECONDARY_CUSTODY_IDENTITY_MISMATCH');
    const spec={accountId:child.id,rootAccountId:parent.root_account_id,positionClass:parent.position_class,
      ownerWallet:parent.owner_wallet,custodyWallet:parent.custody_wallet,origin:'SECONDARY',sourceEventKey:parent.source_event_key};
    const row=await this.store.putEconomics(spec);
    if(!require('./s0-materializer').sameEconomics(row,spec))throw A.error('SECONDARY_ECONOMICS_CONFLICT');
    return row;
  }
  async assertProjectsCapital() {
    await this.ledger.ready();
    const b=await this.store.bucket('PROJECTS:STRUCTURAL_CAPITAL');
    if(!b || b.wallet!==A.address(this.config.projectsWallet) || b.purpose!=='PROJECTS_STRUCTURAL_CAPITAL' || A.atomic(b.balance_atomic)!==A.usdc('100'))throw A.error('PROJECTS_SETTLED_STRUCTURAL_CAPITAL_REQUIRED');
    return b;
  }
  async recordProjectsPosition(account,placed) {
    await this.assertProjectsCapital();
    const eventKey=`PROJECTS_SLOT:${placed.positionId}`;
    return this.ledger.event(eventKey,'PROJECTS_STRUCTURAL_SLOT',{accountId:String(account.id),positionId:String(placed.positionId),number:String(placed.number)},async()=>{
      const spec={accountId:account.id,rootAccountId:account.id,positionClass:'CASSA_PROGETTI',ownerWallet:A.address(this.config.projectsWallet),
        custodyWallet:A.address(this.config.projectsWallet),origin:'CASSA_ENTRY',sourceEventKey:eventKey};
      if(!require('./s0-materializer').sameEconomics(await this.store.putEconomics(spec),spec))throw A.error('PROJECTS_ACCOUNT_ECONOMICS_CONFLICT');
      await this.store.membership({positionId:placed.positionId,accountId:account.id,eventKey,index:1,positionClass:'CASSA_PROGETTI',origin:'CASSA_ENTRY',number:placed.number,amountAtomic:UNIT_ATOMIC});
      // The SAME protected 100 is referenced, never credited into Treasury again.
      return {positionId:placed.positionId,structuralCapitalBucket:'PROJECTS:STRUCTURAL_CAPITAL',humanDelta:0,pilettaDelta:0};
    });
  }
  async prepareEntryCompletion({tableId,tableNumber,heir,turnNumber}) {
    await this.ledger.ready();
    if(Number(tableNumber)===1) {
      const activation=await this.store.activation();
      if(activation.mode!=='FRESH')throw A.error('HISTORICAL_BOOTSTRAP_REPLAY_FORBIDDEN');
      if(heir.tipo!=='FONDO')throw A.error('BOOTSTRAP_FOUNDER_IDENTITY_REQUIRED');
      const gemelli=A.address(this.config.gemelliWallet), projects=A.address(this.config.projectsWallet);
      await this.ledger.reallocate({eventKey:`S0_BOOTSTRAP:${tableId}`,exactInputs:true,inputs:[{key:`S0_TABLE:${tableId}`,amountAtomic:A.usdc('600')}],
        outputs:[this.bucket('BOOTSTRAP:GEMELLI','GEMELLI_BOOTSTRAP',A.usdc('500')),this.bucket('BOOTSTRAP:PROJECTS','PROJECTS_BOOTSTRAP',A.usdc('100'))],context:{tableId:String(tableId)}});
      await this.ledger.prepareMovement({key:'BOOTSTRAP:GEMELLI',reserveBucket:'BOOTSTRAP:GEMELLI',to:gemelli,amountAtomic:A.usdc('500'),purpose:'GEMELLI_RESERVE_OUT',destinationBucket:'GEMELLI:RESERVE:1',destinationPurpose:'GEMELLI_RESERVE'});
      await this.ledger.prepareMovement({key:'BOOTSTRAP:PROJECTS',reserveBucket:'BOOTSTRAP:PROJECTS',to:projects,amountAtomic:A.usdc('100'),purpose:'PROJECTS_BOOTSTRAP_OUT',destinationBucket:'PROJECTS:STRUCTURAL_CAPITAL',destinationPurpose:'PROJECTS_STRUCTURAL_CAPITAL'});
      const g=await this.store.movement('BOOTSTRAP:GEMELLI'),p=await this.store.movement('BOOTSTRAP:PROJECTS');
      if(!['CONFIRMED','REGISTERED'].includes(g.status)||!['CONFIRMED','REGISTERED'].includes(p.status))return {ready:false,reason:'BOOTSTRAP_AWAITING_SETTLED_SUBWALLETS'};
      await this.assertProjectsCapital();
      return {ready:true,fundingBucket:null,bootstrap:true};
    }
    if(heir.tipo==='FONDO')throw A.error('FOUNDER_BOOTSTRAP_CANNOT_BE_REPLAYED');
    await this.assertProjectsCapital();
    const fundingBucket=`PRIEST:${tableId}`;
    await this.ledger.reallocate({eventKey:`S0_PRIEST:${tableId}`,exactInputs:true,inputs:[{key:`S0_TABLE:${tableId}`,amountAtomic:A.usdc('500')}],
      outputs:[{...this.bucket(fundingBucket,'PRIEST',A.usdc('500')),metadata:{sourceTableId:String(tableId),heirAccountId:String(heir.id)}}],context:{heirId:String(heir.id),turnNumber:String(turnNumber)}});
    return {ready:true,fundingBucket,bootstrap:false};
  }
  async fundPriest({accountId,turnId,fundingBucket}) {
    if(!fundingBucket)throw A.error('PRIEST_SETTLED_RESERVE_REQUIRED');
    const b=await this.store.bucket(fundingBucket);
    if(!b || b.purpose!=='PRIEST')throw A.error('PRIEST_FUNDING_PURPOSE_INVALID');
    if(String(b.metadata?.heirAccountId)!==String(accountId))throw A.error('PRIEST_RESERVE_OWNER_MISMATCH');
    return this.ledger.reallocate({eventKey:`PRIEST_TO_B1:${A.digest(fundingBucket)}`,inputs:[{key:fundingBucket,amountAtomic:A.usdc('500')}],
      outputs:[this.bucket(`B1_TURN:${turnId}`,'B1_TURN',A.usdc('500'))],context:{accountId:String(accountId),turnId:String(turnId)}});
  }
  async fundFunctions({turnId,turnNumber}) {
    if(Number(turnNumber)<=1)throw A.error('INITIAL_TURN_HAS_NO_PREVIOUS_FUNCTIONS');
    return this.ledger.reallocate({eventKey:`FUNCTIONS_TO_B1:${turnId}`,
      inputs:[{key:`FUNCTIONS:${turnNumber}`,amountAtomic:A.usdc('2000')},{key:`CURRENT_FUNCTION:${turnNumber}`,amountAtomic:A.usdc('500')}],
      outputs:[this.bucket(`B1_TURN:${turnId}`,'B1_TURN',A.usdc('2500'))],context:{turnId:String(turnId),turnNumber:String(turnNumber)}});
  }
  async fundSecondaryEntry({accountId,turnId,level}) {
    if(![4,5].includes(level))throw A.error('SECONDARY_LEVEL_INVALID');
    const amount=A.usdc(level===4?'5000':'10000');
    return this.ledger.reallocate({eventKey:`SECONDARY_ENTRY:${accountId}:L${level}`,inputs:[{key:progressionBucket(accountId,level),amountAtomic:amount}],
      outputs:[this.bucket(`L${level}_TURN:${turnId}`,`L${level}_TURN`,amount)],context:{accountId:String(accountId),turnId:String(turnId),level}});
  }
  async planExit({level,eventKey,turn,account}) {
    await this.ledger.ready();
    if(turn.faraone_account_id!=null && String(turn.faraone_account_id)!==String(account.id))throw A.error('EXIT_TURN_ACCOUNT_MISMATCH');
    if(turn.faraone_wallet!=null && A.address(turn.faraone_wallet)!==A.address(account.wallet))throw A.error('EXIT_TURN_WALLET_MISMATCH');
    if(['THOT','ISIDE'].includes(level) && (Number(turn.sacerdoti_entrati)!==3 || Number(turn.sacerdoti_necessari)!==3))throw A.error('SECONDARY_TURN_CONTRIBUTORS_INCOMPLETE');
    const economics=await this.store.economics(account.id);
    if(!economics)throw A.error('EXIT_ACCOUNT_ECONOMICS_REQUIRED');
    if(economics.position_class==='LEGACY_CASSA')throw A.error('LEGACY_CASSA_ECONOMIC_DESTINATION_REQUIRES_CUTOVER_REVIEW');
    const positionClass=economics.position_class;
    const net=planExitNet({positionClass:positionClass==='CASSA_PROGETTI'?'HUMAN':positionClass,accountType:account.tipo,level,
      ownerWallet:economics.owner_wallet,fundAWallet:this.config.fundAWallet});
    const keys=exitKeys(eventKey), outputs=[];
    outputs.push(this.bucket(keys.NET,positionClass==='PILETTA'?'GENERATED_S0':'PAYOUT',net.netAtomic));
    let total;
    if(level==='RHA') {
      total=A.usdc('9000');
      if(Number(turn.sacerdoti_entrati)!==Number(turn.sacerdoti_necessari) || ![13,18].includes(Number(turn.sacerdoti_necessari)))throw A.error('RHA_REAL_CONTRIBUTORS_INCOMPLETE');
      const next=Number(turn.numero_turno)+1;
      outputs.push(this.bucket(`FUNCTIONS:${next}`,'FUNCTIONS',A.usdc('2000')),this.bucket(keys.NEXT_GEMELLI,'NEXT_GEMELLI',A.usdc('500')),
        this.bucket(keys.ROG,'RHA_ROG',A.usdc('300')),this.bucket(keys.URANUS,'RHA_URANUS',A.usdc('200')));
      if(['PERPETUO','GEMELLO'].includes(account.tipo))outputs.push(this.bucket(progressionBucket(account.id,4),'SECONDARY_L4',A.usdc('5000')));
    } else if(level==='THOT') {
      total=A.usdc('15000');
      outputs.push(this.bucket(progressionBucket(account.id,5),'SECONDARY_L5',A.usdc('10000')),this.bucket(keys.GENERATED,'GENERATED_S0',A.usdc('500')),this.bucket(keys.PROJECTS,'THOT_PROJECTS',A.usdc('500')));
    } else if(level==='ISIDE') {
      total=A.usdc('30000'); outputs.push(this.bucket(keys.GENERATED,'GENERATED_S0',A.usdc('5000')));
    } else throw A.error('EXIT_LEVEL_INVALID');
    await this.ledger.reallocate({eventKey:`ALLOCATE_EXIT:${A.digest(eventKey)}`,exactInputs:true,inputs:[{key:turnBucket(turn.id,level),amountAtomic:total}],outputs,
      context:{eventKey,level,accountId:String(account.id),positionClass,turnId:String(turn.id),turnNumber:String(turn.numero_turno)}});
    if(level==='RHA')await this.prepareGemelliCycle({eventKey,turnNumber:turn.numero_turno,accountType:account.tipo});
    if(level==='THOT')await this.ledger.prepareMovement({key:keys.PROJECTS,reserveBucket:keys.PROJECTS,to:this.config.projectsWallet,amountAtomic:A.usdc('500'),purpose:'THOT_PROJECTS_OUT',
      destinationBucket:`PROJECTS:THOT:${A.digest(eventKey)}`,destinationPurpose:'PROJECTS_HUMANITARIAN'});
    return {level,eventKey,positionClass,accountId:account.id,keys,netAtomic:net.netAtomic,cashPayoutAtomic:net.cashPayoutAtomic,beneficiaryWallet:net.beneficiaryWallet};
  }
  async prepareGemelliCycle({eventKey,turnNumber,accountType}) {
    const next=Number(turnNumber)+1,keys=exitKeys(eventKey),gemelli=A.address(this.config.gemelliWallet);
    const old=await this.store.bucket(`GEMELLI:RESERVE:${turnNumber}`);
    if(!old || old.wallet!==gemelli)throw A.error('PREVIOUS_GEMELLI_RESERVE_NOT_SETTLED');
    const incomingKey=`GEMELLI_RETURN:${turnNumber}`;
    await this.ledger.prepareMovement({key:incomingKey,reserveBucket:old.bucket_key,to:this.treasury(),amountAtomic:A.usdc('500'),purpose:accountType==='PERPETUO'?'CONTINUITY_IN':'GEMELLI_FUNDING_IN',
      destinationBucket:`CURRENT_FUNCTION:${next}`,destinationPurpose:'CURRENT_FUNCTION'});
    await this.ledger.prepareMovement({key:`GEMELLI_NEXT:${turnNumber}`,reserveBucket:keys.NEXT_GEMELLI,to:gemelli,amountAtomic:A.usdc('500'),purpose:'GEMELLI_RESERVE_OUT',
      destinationBucket:`GEMELLI:RESERVE:${next}`,destinationPurpose:'GEMELLI_RESERVE',dependsOn:incomingKey});
  }
  async materializeQuota({eventKey,source,accountId}) {
    if(!['THOT','ISIDE'].includes(source))throw A.error('GENERATED_QUOTA_SOURCE_INVALID');
    const allocation=await this.store.event(`ALLOCATE_EXIT:${A.digest(eventKey)}`);
    if(!allocation || allocation.status!=='COMPLETED' || String(allocation.context.context.accountId)!==String(accountId) || allocation.context.context.level!==source)throw A.error('GENERATED_QUOTA_EXIT_ALLOCATION_REQUIRED');
    return this.materializer.generated({eventKey:`GENERATED:${A.digest(eventKey)}`,source,sourceAccountId:accountId,sourceLevel:source,
      amountAtomic:A.usdc(source==='THOT'?'500':'5000'),fundingBucket:exitKeys(eventKey).GENERATED});
  }
  async reinvestNet(exit) {
    if(exit.positionClass!=='PILETTA')return null;
    return this.materializer.generated({eventKey:`NET_REINVEST:${A.digest(exit.eventKey)}`,source:'PILETTA_REINVESTMENT',sourceAccountId:exit.accountId,
      sourceLevel:exit.level,amountAtomic:exit.netAtomic,fundingBucket:exit.keys.NET});
  }
}
function configuredFlow(client) {
  return new EconomicFlow({ledger:configuredLedger(client),materializer:configuredMaterializer(client),config:{
    treasuryWallet:process.env.PHARAOH_TREASURY_WALLET,fundAWallet:process.env.PHARAOH_FUND_A_WALLET,
    gemelliWallet:process.env.PHARAOH_GEMELLI_WALLET,projectsWallet:process.env.PHARAOH_PROJECTS_WALLET}});
}
function publicPosition(p) {
  return {accountId:p.accountId,accountSigla:p.sigla,numeroPosizionale:p.number,positionClass:p.positionClass,
    tavola:{id:p.tableId,numero:p.tableNumber,casella:p.slot,completa:p.completed},
    tavolaPersonale:{id:p.personalTableId,numero:p.personalTableNumber}};
}
module.exports={EconomicFlow,configuredFlow,exitKeys,progressionBucket,turnBucket,publicPosition};

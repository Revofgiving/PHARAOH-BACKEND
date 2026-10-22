'use strict';
/** Real V4 manager code with mocked provider/contract and real ABI encoding.
 * No RPC, EVM execution, Registry write or ERC20 transfer.
 */
const assert=require('node:assert/strict');
const {ethers}=require('ethers');
const registry=require('../pharaoh-registry-manager');
const policy=require('../treasury-subwallet-policy');

const A=n=>'0x'+String(n).repeat(40);
const H=n=>'0x'+String(n).repeat(64);

const subConfig={
  wallets:{PHARAOH:A(1),GEMELLI:A(2),PROGETTI:A(3)},
  tokenContract:A(4),
  chainId:137
};

const cfg={
  contractAddress:A(6),
  treasuryWallet:A(1),
  projectsTreasury:A(3),
  rogParent:A(5),
  chainId:137,
  minConfirmations:3
};

const iface=new ethers.Interface(registry.REGISTRY_ABI);

const BLOCK_HASH='0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

function fixture(){
  const receipts=new Map();
  const logs=[];
  const used=new Set();
  const locks=[];
  let calls=0;

  function movementTx(args){
    calls++;
    const txHash=H(7);
    const [
      sourceTreasury,destinationTreasury,sourceWallet,destinationWallet,
      amount,txType,externalTxHash,backendRef,rogRef
    ]=args;

    const encoded=iface.encodeEventLog(
      iface.getEvent('TreasuryMovementRegistered'),
      [1n,sourceTreasury,destinationTreasury,sourceWallet,destinationWallet,
       amount,txType,externalTxHash,backendRef,rogRef]
    );

    const log={
      address:A(6),
      topics:encoded.topics,
      data:encoded.data,
      transactionHash:txHash,
      blockHash:BLOCK_HASH
    };

    const receipt={
      hash:txHash,
      transactionHash:txHash,
      status:1,
      blockNumber:12,
      blockHash:BLOCK_HASH,
      logs:[log]
    };

    used.add(String(backendRef).toLowerCase());
    logs.push(log);
    receipts.set(txHash,receipt);

    return {hash:txHash,wait:async()=>receipt};
  }

  const contract={
    CONTRACT_ID:async()=>registry.EXPECTED_CONTRACT_ID,
    CONTRACT_VERSION:async()=>registry.EXPECTED_CONTRACT_VERSION,
    parentDAO:async()=>A(5),
    pharaohTreasury:async()=>A(1),
    projectsTreasury:async()=>A(3),
    BACKEND_ROLE:async()=>H(1),
    hasRole:async()=>true,
    usedBackendRefs:async ref=>used.has(String(ref).toLowerCase()),
    usedRogRefs:async()=>false,
    registerMovement:async(...args)=>movementTx(args)
  };

  const pg={
    getClient:async()=>({
      query:async sql=>{locks.push(sql);return {rows:[]};},
      release(){}
    })
  };

  const deps={
    config:cfg,
    subwalletConfig:subConfig,
    provider:{
      getNetwork:async()=>({chainId:137n}),
      getCode:async()=>'0x60006000',
      getBlockNumber:async()=>14,
      getTransactionReceipt:async hash=>receipts.get(String(hash).toLowerCase())||null,
      getLogs:async()=>logs
    },
    signer:{getAddress:async()=>A(8)},
    contract,
    pg,
    cooldownGuardMs:0,
    sleep:async()=>{}
  };

  return {deps,getCalls:()=>calls,locks,logs};
}

function request(purpose){
  const plan=policy.prepareSubwalletMovement({
    purpose,
    amountAtomic:policy.PURPOSES[purpose].amount,
    externalTxHash:H(5),
    ...subConfig
  });

  return {
    plan,
    verification:{
      valida:true,
      proof:{
        chainId:137,
        txHash:H(5),
        from:plan.from,
        to:plan.to,
        tokenContract:A(4),
        amountBaseUnits:plan.amountAtomic.toString(),
        blockNumber:10,
        blockHash:H(6),
        confirmations:3,
        transferLogIndexes:[0]
      }
    },
    eventKey:'test-event',
    requiredConfirmations:3,
    onSubmitted:async()=>{}
  };
}

function projectsRequest(){
  const plan=policy.prepareSubwalletMovement({
    purpose:'PROJECTS_HUMANITARIAN_OUT',
    amountAtomic:250n*policy.DECIMALS,
    externalTxHash:H(9),
    destinationWallet:A(8),
    ...subConfig
  });

  return {
    plan,
    verification:{
      valida:true,
      proof:{
        chainId:137,
        txHash:H(9),
        from:plan.from,
        to:plan.to,
        tokenContract:A(4),
        amountBaseUnits:plan.amountAtomic.toString(),
        blockNumber:10,
        blockHash:H(6),
        confirmations:3,
        transferLogIndexes:[0]
      }
    },
    eventKey:'projects-event',
    requiredConfirmations:3,
    onSubmitted:async()=>{}
  };
}

(async()=>{
  let scenarios=0;

  for(const purpose of Object.keys(policy.PURPOSES)){
    const f=fixture();
    const input=request(purpose);
    let saved=null;
    input.onSubmitted=async hash=>{saved=hash;};

    const result=await registry.registerSubwalletMovement(input,f.deps);

    assert.equal(f.getCalls(),1);
    assert.equal(saved,H(7));
    assert.equal(result.txHash,H(7));
    assert.equal(result.movementId,1);
    assert.ok(f.locks.some(x=>x.includes('pg_advisory_lock')));
    scenarios++;
  }

  {
    const f=fixture();
    const input=request('GEMELLI_FUNDING_IN');
    await registry.registerSubwalletMovement(input,f.deps);

    const retry=await registry.registerSubwalletMovement(
      {...input,eventKey:'another-label'},
      f.deps
    );
    assert.equal(retry.recovered,true);
    assert.equal(f.getCalls(),1);
    scenarios++;

    await assert.rejects(
      registry.registerSubwalletMovement(request('CONTINUITY_IN'),f.deps),
      e=>e.code==='PHARAOH_REGISTRY_RECOVERY_FAILED'
    );
    assert.equal(f.getCalls(),1);
    scenarios++;

    const stored=await registry.registerSubwalletMovement(
      {...input,existingRegistryTxHash:H(7)},
      f.deps
    );
    assert.equal(stored.recovered,true);
    assert.equal(f.getCalls(),1);
    scenarios++;
  }

  {
    const f=fixture();
    const input=request('THOT_PROJECTS_OUT');
    input.plan={...input.plan,to:A(9)};
    await assert.rejects(
      registry.registerSubwalletMovement(input,f.deps),
      /CONFIGURATION_MISMATCH/
    );
    assert.equal(f.getCalls(),0);
    scenarios++;
  }

  {
    const f=fixture();
    const input=request('THOT_PROJECTS_OUT');
    input.verification.proof.amountBaseUnits='1';
    await assert.rejects(
      registry.registerSubwalletMovement(input,f.deps),
      /PROOF_MISMATCH/
    );
    assert.equal(f.getCalls(),0);
    scenarios++;
  }

  {
    const f=fixture();
    const input=request('THOT_PROJECTS_OUT');
    input.requiredConfirmations=1;
    input.verification.proof.confirmations=2;
    await assert.rejects(
      registry.registerSubwalletMovement(input,f.deps),
      /CONFIRMATIONS_PENDING/
    );
    assert.equal(f.getCalls(),0);
    scenarios++;
  }

  {
    const f=fixture();
    const input=projectsRequest();
    const result=await registry.registerSubwalletMovement(input,f.deps);
    assert.equal(result.movementId,1);
    assert.equal(f.getCalls(),1);
    scenarios++;
  }

  console.log(`SUBWALLET_REGISTRY_V4_WIRING_PASS: ${scenarios} manager-code scenarios; provider/contract mocked, real ABI encoding, no RPC or deploy`);
})().catch(e=>{console.error(e);process.exitCode=1;});

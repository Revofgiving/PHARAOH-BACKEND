'use strict';
/**
 * Standalone READ-ONLY utility: copy THIS file, not the incomplete backend, to
 * /app of the existing deployment and run node public-runtime-inspection.js.
 * No .env file loading; no private-key access. --chain uses provider-only calls.
 */
const PUBLIC_NAMES = Object.freeze([
  'PHARAOH_FUND_A_WALLET','PHARAOH_TREASURY_WALLET','PHARAOH_REGISTRY_ADDRESS',
  'PHARAOH_GEMELLI_WALLET','PHARAOH_PROJECTS_WALLET','USDC_CONTRACT_ADDRESS'
]);
const VALID = /^0x[0-9a-fA-F]{40}$/;
function publicConfig(env) {
  return Object.fromEntries(PUBLIC_NAMES.map(name => {
    const value = env[name];
    return [name,typeof value === 'string' && VALID.test(value) && !/^0x0{32}[0-9a-fA-F]{8}$/.test(value)
      ? value : null];
  }));
}
function atomicToUsdc(value) {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('INVALID_ATOMIC_AMOUNT');
  return `${value/1000000n}.${String(value%1000000n).padStart(6,'0')}`;
}
async function readChain({config, provider, registry, token}) {
  const network = await provider.getNetwork();
  if (BigInt(network.chainId) !== 137n) throw new Error('WRONG_CHAIN');
  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  if (!block?.hash) throw new Error('BLOCK_NOT_FOUND');
  const overrides = {blockTag:blockNumber};
  const [code, contractId, version, treasury, max, hourly, decimals] = await Promise.all([
    provider.getCode(config.PHARAOH_REGISTRY_ADDRESS,blockNumber), registry.CONTRACT_ID(overrides),
    registry.CONTRACT_VERSION(overrides), registry.pharaohTreasury(overrides),
    registry.MAX_SINGLE_AMOUNT(overrides), registry.MAX_VOLUME_PER_HOUR(overrides),token.decimals(overrides)
  ]);
  if (!code || code === '0x') throw new Error('REGISTRY_NO_CODE');
  if (Number(decimals)!==6)throw new Error('TOKEN_DECIMALS_MISMATCH');
  const balances = {};
  for (const name of PUBLIC_NAMES.filter(n => n.endsWith('_WALLET'))) {
    if (config[name]) balances[name] = atomicToUsdc(await token.balanceOf(config[name],overrides));
  }
  const after = await provider.getBlock(blockNumber);
  if (after?.hash !== block.hash) throw new Error('BLOCK_REORGANIZED_RETRY');
  return {chainId:'137',blockNumber,blockHash:block.hash,contractId,version,treasury,
    treasuryMatchesConfig:treasury.toLowerCase() === config.PHARAOH_TREASURY_WALLET?.toLowerCase(),
    registryMaxSingleAmountUsdc:atomicToUsdc(max), registryMaxHourlyVolumeUsdc:atomicToUsdc(hourly),
    token:config.USDC_CONTRACT_ADDRESS,balancesUsdc:balances,
    note:'Balances are not free spendable funds: committed reserves and pending transfers have NOT been deducted.'};
}
async function main(args=process.argv.slice(2), env=process.env) {
  if (args.some(a=>a!=='--chain')) throw new Error('UNKNOWN_ARGUMENT');
  const config=publicConfig(env);
  const report={readOnly:true,scope:'Whitelisted public runtime configuration; no secrets, DB writes or payments',config};
  let provider;
  try {
    if(args.includes('--chain')) {
      if(!config.PHARAOH_REGISTRY_ADDRESS || !config.PHARAOH_TREASURY_WALLET || !config.USDC_CONTRACT_ADDRESS)throw new Error('PUBLIC_CONFIGURATION_MISSING');
      if(!env.POLYGON_RPC_URL)throw new Error('RPC_MISSING');
      const {ethers}=require('ethers');
      // Validate mixed-case checksums; never lowercase first to bypass a typo.
      for(const value of Object.values(config))if(value)ethers.getAddress(value);
      const request=new ethers.FetchRequest(env.POLYGON_RPC_URL);request.timeout=12000;
      provider=new ethers.JsonRpcProvider(request);
      const registry=new ethers.Contract(config.PHARAOH_REGISTRY_ADDRESS,[
        'function CONTRACT_ID() view returns (bytes32)', 'function CONTRACT_VERSION() view returns (string)',
        'function pharaohTreasury() view returns (address)', 'function MAX_SINGLE_AMOUNT() view returns (uint256)',
        'function MAX_VOLUME_PER_HOUR() view returns (uint256)'],provider);
      const token=new ethers.Contract(config.USDC_CONTRACT_ADDRESS,[
        'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)'],provider);
      report.chain=await readChain({config,provider,registry,token});
    }
    console.log(JSON.stringify(report,null,2));
  } catch (_) {
    // An RPC/library message can contain a credential-bearing URL: do NOT echo it.
    report.error='READ_ONLY_INSPECTION_FAILED_NO_SECRETS_EXPOSED';
    console.log(JSON.stringify(report,null,2));process.exitCode=1;
  } finally {if(provider)provider.destroy();}
}
if(require.main===module)main().catch(()=>{console.error('INVALID_INSPECTION_ARGUMENTS');process.exitCode=1;});
module.exports={PUBLIC_NAMES,publicConfig,atomicToUsdc,readChain};

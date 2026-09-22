'use strict';

const { ethers } = require('ethers');

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const NATIVE_POLYGON_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const EXPECTED_CONTRACT_ID = ethers.id('PHARAOH_TREASURY_REGISTRY_V3').toLowerCase();
const EXPECTED_CONTRACT_VERSION = '3.0.0';

const PHARAOH_REGISTRY_ABI = [
  'function CONTRACT_ID() view returns (bytes32)',
  'function CONTRACT_VERSION() view returns (string)',
  'function BACKEND_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
  'function parentDAO() view returns (address)',
  'function pharaohTreasury() view returns (address)',
  'function paused() view returns (bool)',
  'function emergencyMode() view returns (bool)',
  'function circuitBreakerTriggered() view returns (bool)'
];

function validAddress(value) {
  return WALLET_RE.test(String(value || '')) && String(value).toLowerCase() !== ethers.ZeroAddress.toLowerCase();
}

async function requireCode(provider, address, label, failures) {
  if (!validAddress(address)) {
    failures.push(`${label}_NON_VALIDO`);
    return false;
  }
  const code = await provider.getCode(address);
  if (!code || code === '0x') {
    failures.push(`${label}_SENZA_BYTECODE`);
    return false;
  }
  return true;
}

async function main() {
  const failures = [];
  const warnings = [];
  const rpc = String(process.env.POLYGON_RPC_URL || '').trim();
  if (!rpc) failures.push('POLYGON_RPC_URL_MANCANTE');

  if (rpc) {
    const provider = new ethers.JsonRpcProvider(rpc);
    try {
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== 137) failures.push(`CHAIN_ID_ERRATA:${network.chainId}`);
      if (String(process.env.USDC_CONTRACT_ADDRESS || '').toLowerCase() !== NATIVE_POLYGON_USDC) failures.push('USDC_NON_CIRCLE_NATIVO_POLYGON');
      if (String(process.env.ROG_USDC_CONTRACT_ADDRESS || '').toLowerCase() !== NATIVE_POLYGON_USDC) failures.push('ROG_USDC_NON_CIRCLE_NATIVO_POLYGON');

      for (const [name, address] of [
        ['USDC_CONTRACT_ADDRESS', process.env.USDC_CONTRACT_ADDRESS],
        ['ROG_USDC_CONTRACT_ADDRESS', process.env.ROG_USDC_CONTRACT_ADDRESS],
        ['ROG_CONTRACT_ADDRESS', process.env.ROG_CONTRACT_ADDRESS],
        ['PHARAOH_REGISTRY_ADDRESS', process.env.PHARAOH_REGISTRY_ADDRESS]
      ]) {
        await requireCode(provider, address, name, failures);
      }

      try {
        const registryAddress = String(process.env.PHARAOH_REGISTRY_ADDRESS || '');
        const rogAddress = String(process.env.ROG_CONTRACT_ADDRESS || '');
        const treasuryAddress = String(process.env.PHARAOH_TREASURY_WALLET || '');
        const privateKey = String(process.env.PHARAOH_REGISTRY_PRIVATE_KEY || '');
        if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
          failures.push('PHARAOH_REGISTRY_PRIVATE_KEY_NON_VALIDA');
        } else if (validAddress(registryAddress)) {
          const signerAddress = new ethers.Wallet(privateKey).address;
          const registry = new ethers.Contract(registryAddress, PHARAOH_REGISTRY_ABI, provider);
          const [contractId, contractVersion, role, parentDAO, pharaohTreasury, paused, emergency, circuit] = await Promise.all([
            registry.CONTRACT_ID(),
            registry.CONTRACT_VERSION(),
            registry.BACKEND_ROLE(),
            registry.parentDAO(),
            registry.pharaohTreasury(),
            registry.paused(),
            registry.emergencyMode(),
            registry.circuitBreakerTriggered()
          ]);
          const hasRole = await registry.hasRole(role, signerAddress);

          if (String(contractId).toLowerCase() !== EXPECTED_CONTRACT_ID) failures.push('PHARAOH_REGISTRY_CONTRACT_ID_MISMATCH');
          if (String(contractVersion) !== EXPECTED_CONTRACT_VERSION) failures.push('PHARAOH_REGISTRY_VERSION_MISMATCH');
          if (!validAddress(rogAddress) || String(parentDAO).toLowerCase() !== rogAddress.toLowerCase()) failures.push('PHARAOH_REGISTRY_PARENT_ROG_MISMATCH');
          if (!validAddress(treasuryAddress) || String(pharaohTreasury).toLowerCase() !== treasuryAddress.toLowerCase()) failures.push('PHARAOH_REGISTRY_TREASURY_MISMATCH');
          if (!hasRole) failures.push('PHARAOH_REGISTRY_BACKEND_ROLE_MANCANTE');
          if (paused) failures.push('PHARAOH_REGISTRY_PAUSED');
          if (emergency) failures.push('PHARAOH_REGISTRY_EMERGENCY_MODE');
          if (circuit) failures.push('PHARAOH_REGISTRY_CIRCUIT_BREAKER');
        }
      } catch (error) {
        failures.push(`PHARAOH_REGISTRY_READ_ONLY_FALLITO:${String(error.message || error).slice(0,180)}`);
      }
    } catch (error) {
      failures.push(`POLYGON_READ_ONLY_FALLITO:${String(error.message || error).slice(0,180)}`);
    }
  }

  const testWallet = String(process.env.PREFLIGHT_TEST_WALLET || '').trim();
  if (testWallet) {
    try {
      const rog = require('../rog-community-manager');
      const result = await rog.getCommunityStatus(testWallet);
      console.log(`ROG_COMMUNITY_READ_ONLY: OK registered=${result.registered === true}`);
    } catch (error) {
      failures.push(`ROG_READ_ONLY_FALLITO:${String(error.message || error).slice(0,180)}`);
    }
  } else {
    warnings.push('ROG_COMMUNITY_READ_ONLY_NON_ESEGUITO:PREFLIGHT_TEST_WALLET_MANCANTE');
  }

  // Le integrazioni ROG/URANUS restano responsabilita del backend. Qui si
  // valida solo che gli endpoint configurati siano URL validi; il Registry
  // PHARAOH non dipende da contratti sibling.
  for (const name of ['ROG_CROSS_INGRESS_URL', 'URANUS_CROSS_INGRESS_URL']) {
    try {
      const url = new URL(String(process.env[name] || ''));
      if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') failures.push(`${name}_NON_HTTPS`);
    } catch (_) { failures.push(`${name}_NON_VALIDO`); }
  }
  warnings.push('RECEIVER_CROSS:URL_VALIDATA_MA_NESSUN_POST_ESEGUITO');

  warnings.forEach(w => console.log(`WARNING: ${w}`));
  if (failures.length) throw new Error([...new Set(failures)].join(','));
  console.log('PREFLIGHT_INTEGRAZIONI_READ_ONLY: OK');
  console.log('PHARAOH_REGISTRY_V3_PARENT_ROG_TREASURY: OK');
  console.log('URANUS_REGISTRY_DEPENDENCY: NONE');
  console.log('NESSUN_FONDO_INVIATO: TRUE');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`PREFLIGHT_INTEGRAZIONI_FALLITO: ${error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = { main };

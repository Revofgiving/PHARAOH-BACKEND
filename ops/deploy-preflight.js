'use strict';

const fs = require('fs');
const path = require('path');
const migrations = require('./db-migrate');

const ROOT = path.resolve(__dirname, '..');

function check(condition, code, failures) {
  if (!condition) failures.push(code);
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function runStaticChecks() {
  const failures = [];
  const major = Number(process.versions.node.split('.')[0]);
  check(major >= 22 && major < 25, 'NODE_22_23_24_RICHIESTO', failures);

  for (const relative of [
    'database/init.sql',
    'database/migration-plan.json',
    'database/0002_direct_donation_sessions.sql',
    'database/0003_gift_sessions.sql',
    'database/0004_cross_movements.sql',
    'database/0005_rha_dual_300_200.sql',
    'database/0006_thot_humanitarian_reentry.sql',
    'database/0007_iside_reentry_receiver_gift.sql',
    'database/0008_remove_doni_credito.sql',
    'database/0009_remove_dono_al_volo_staff_legacy.sql',
    'database/0010_secondary_identity_wallets.sql',
    'database/0011_entry_function_reservation_guard.sql',
    'database/0012_entry_rollover_100.sql',
    'database/0013_pharaoh_treasury_registry_v3.sql',
    'database/0014_rog_rha_registration_evidence.sql',
    'database/0015_direct_rog_async_gate.sql',
    'direct-donation-manager.js',
    'direct-donation-session-manager.js',
    'pharaoh-registry-manager.js',
    'gift-session-manager.js',
    'rog-gift-manager.js',
    'gift-flow-manager.js',
    'verified-entry-manager.js',
    'cross-platform-auth.js',
    'cross-entry-manager.js',
    'cross-outbound-manager.js',
    'ops/db-migrate.js',
    'ops/db-backup.js',
    'ops/db-restore.js',
    'ops/integration-preflight.js',
    'Dockerfile',
    'package-lock.json'
  ]) check(fs.existsSync(path.join(ROOT, relative)), `FILE_MANCANTE:${relative}`, failures);

  try {
    const plan = migrations.loadPlan();
    check(plan.length === 15, 'PIANO_MIGRAZIONI_DEVE_AVERE_15_STEP', failures);
    check(plan.some(m => m.id === '0004_cross_movements'), 'MIGRATION_0004_MANCANTE', failures);
    check(plan.some(m => m.id === '0005_rha_dual_300_200'), 'MIGRATION_0005_MANCANTE', failures);
    check(plan.some(m => m.id === '0006_thot_humanitarian_reentry'), 'MIGRATION_0006_MANCANTE', failures);
    check(plan.some(m => m.id === '0007_iside_reentry_receiver_gift'), 'MIGRATION_0007_MANCANTE', failures);
    check(plan.some(m => m.id === '0008_remove_doni_credito'), 'MIGRATION_0008_MANCANTE', failures);
    check(plan.some(m => m.id === '0009_remove_dono_al_volo_staff_legacy'), 'MIGRATION_0009_MANCANTE', failures);
    check(plan.some(m => m.id === '0010_secondary_identity_wallets'), 'MIGRATION_0010_MANCANTE', failures);
    check(plan.some(m => m.id === '0011_entry_function_reservation_guard'), 'MIGRATION_0011_MANCANTE', failures);
    check(plan.some(m => m.id === '0012_entry_rollover_100'), 'MIGRATION_0012_MANCANTE', failures);
    check(plan.some(m => m.id === '0013_pharaoh_treasury_registry_v3'), 'MIGRATION_0013_MANCANTE', failures);
    check(plan.some(m => m.id === '0014_rog_rha_registration_evidence'), 'MIGRATION_0014_MANCANTE', failures);
    check(plan.some(m => m.id === '0015_direct_rog_async_gate'), 'MIGRATION_0015_MANCANTE', failures);
  } catch (error) {
    failures.push(error.message);
  }

  const pkg = JSON.parse(read('package.json'));
  for (const script of [
    'db:plan', 'db:status', 'db:migrate', 'db:verify',
    'deploy:preflight', 'deploy:preflight:production', 'deploy:preflight:integrations',
    'test', 'test:cross', 'test:thot', 'test:iside', 'test:no-credito-no-dono-al-volo', 'test:entry-rollover'
  ]) check(Boolean(pkg.scripts[script]), `SCRIPT_MANCANTE:${script}`, failures);

  const gitignore = read('.gitignore');
  check(gitignore.includes('DATABASE_BACKUPS/'), 'BACKUP_DATABASE_NON_IGNORATI', failures);

  const api = read('api-server.js');
  check(api.includes("app.post('/api/donazione/diretta/session'"), 'DIRECT_SESSION_ROUTE_MANCANTE', failures);
  check(api.includes("app.post('/api/gift/create'"), 'GIFT_ROUTE_MANCANTE', failures);
  check(api.includes("crossAuth.verifyRequest(req, 'URANUS')"), 'URANUS_HMAC_GATE_MANCANTE', failures);
  check(api.includes("app.post('/api/cross/donation/entrata'"), 'URANUS_CROSS_ROUTE_MANCANTE', failures);
  check(!api.includes("crossAuth.verifyRequest(req, 'ROG')"), 'ROG_TO_PHARAOH_NON_DEVE_ESSERE_ABILITATO', failures);

  const integrationPreflight = read('ops/integration-preflight.js');
  check(integrationPreflight.includes("ethers.id('PHARAOH_TREASURY_REGISTRY_V3')"), 'INTEGRATION_REGISTRY_ID_CHECK_MANCANTE', failures);
  check(integrationPreflight.includes('pharaohTreasury()'), 'INTEGRATION_REGISTRY_TREASURY_CHECK_MANCANTE', failures);
  check(!integrationPreflight.includes('URANUS_REGISTRY_ADDRESS'), 'INTEGRATION_REGISTRY_NON_DEVE_DIPENDERE_DA_URANUS_REGISTRY', failures);

  const directFlow = read('donation-flow-manager.js');
  check(directFlow.includes('DIRECT_DONATION_EXACT_ENTRY_REQUIRED'), 'DIRECT_EXACT_100_GUARD_MANCANTE', failures);
  check(directFlow.includes('maxPosizioni: 1'), 'DIRECT_MAX_1_MANCANTE', failures);
  check(directFlow.includes('pharaohRegistry.registerDirectIncoming'), 'DIRECT_REGISTRY_MANCANTE', failures);

  const registryManager = read('pharaoh-registry-manager.js');
  check(registryManager.includes('EXPECTED_CONTRACT_ID') && registryManager.includes('contract.CONTRACT_ID()'), 'REGISTRY_CONTRACT_ID_GUARD_MANCANTE', failures);
  check(registryManager.includes("EXPECTED_CONTRACT_VERSION = '3.0.0'"), 'REGISTRY_VERSION_GUARD_MANCANTE', failures);

  const giftFlow = read('gift-flow-manager.js');
  check(giftFlow.includes('GIFT_PHARAOH_AMOUNT_USDC = 100'), 'GIFT_100_MANCANTE', failures);
  check(giftFlow.includes("require('./pharaoh-registry-manager')"), 'GIFT_REGISTRY_MANCANTE', failures);
  check(giftFlow.includes('pharaohRegistry.registerGiftIncoming'), 'GIFT_REGISTRY_INCOMING_MANCANTE', failures);

  const crossOutbound = read('cross-outbound-manager.js');
  check(crossOutbound.includes('contract.registerDonation('), 'RHA_ROG_REGISTER_DONATION_MANCANTE', failures);
  check(crossOutbound.includes('rog_register_nonce'), 'RHA_ROG_REGISTER_NONCE_DUREVOLE_MANCANTE', failures);
  check(crossOutbound.includes('rog_register_tx_hash'), 'RHA_ROG_REGISTER_TX_DUREVOLE_MANCANTE', failures);
  check(crossOutbound.includes('CROSS_OUTBOUND_ROG_POSTCONDITION_FAILED'), 'RHA_ROG_POSTCONDITION_MANCANTE', failures);
  check(!crossOutbound.includes('.getDonation('), 'RHA_ROG_NON_DEVE_USARE_GET_DONATION', failures);

  const functions = read('function-manager.js');
  const l3 = functions.slice(functions.indexOf('async function rilasciaFunzioniL3'), functions.indexOf('async function rilasciaFunzioniL4'));
  check(!l3.includes('accantonaDoniCredito'), 'RHA_L3_NON_DEVE_CREARE_DONI_CREDITO', failures);
  check(!l3.includes('staffOmaggiReservedUsdc'), 'RHA_OMAGGI_STAFF_DEVE_ESSERE_RIMOSSO', failures);
  check(l3.includes('rogDualPositions'), 'RHA_ROG_DUAL_POSITIONS_MANCANTI', failures);
  check(l3.includes('uranusDualPositions'), 'RHA_URANUS_DUAL_POSITIONS_MANCANTI', failures);

  const l4 = functions.slice(functions.indexOf('async function rilasciaFunzioniL4'), functions.indexOf('async function rilasciaFunzioniL5'));
  check(!l4.includes('accantonaDoniCredito'), 'THOT_L4_NON_DEVE_CREARE_DONI_CREDITO', failures);
  check(l4.includes('createThotExitAllocation'), 'THOT_ALLOC_REGISTRY_MANCANTE', failures);
  check(l4.includes("source: 'THOT_REENTRY'"), 'THOT_RIENTRI_ENTRATA_MANCANTI', failures);
  const ruleSource = read('rules-engine.js');
  check(ruleSource.includes('TRATTENUTA_PROGETTI_UMANITARI_L4: 500'), 'THOT_500_UMANITARI_MANCANTE', failures);
  check(ruleSource.includes('TRATTENUTA_RIENTRI_ENTRATA_L4: 500'), 'THOT_500_RIENTRI_MANCANTE', failures);
  check(ruleSource.includes('NUM_RIENTRI_ENTRATA_L4: 5'), 'THOT_5_RIENTRI_MANCANTE', failures);

  const l5 = functions.slice(functions.indexOf('async function rilasciaFunzioniL5'));
  check(!l5.includes('accantonaDoniCredito'), 'ISIDE_L5_NON_DEVE_CREARE_DONI_CREDITO', failures);
  check(l5.includes('createIsideExitAllocation'), 'ISIDE_ALLOC_REGISTRY_MANCANTE', failures);
  check(l5.includes("source: 'ISIDE_REENTRY'"), 'ISIDE_RIENTRI_ENTRATA_MANCANTI', failures);
  check(ruleSource.includes('TRATTENUTA_RIENTRI_ENTRATA_L5: 5000'), 'ISIDE_5000_RIENTRI_MANCANTE', failures);
  check(ruleSource.includes('NUM_RIENTRI_ENTRATA_L5: 50'), 'ISIDE_50_RIENTRI_MANCANTE', failures);
  check(ruleSource.includes('QUOTA_RICEVENTE_L5: 6000'), 'ISIDE_6000_QUOTA_RICEVENTE_MANCANTE', failures);
  check(ruleSource.includes('USCITA_L5_NETTO_BASE: 19000'), 'ISIDE_19000_NETTO_BASE_MANCANTE', failures);
  check(ruleSource.includes('USCITA_L5_PAYOUT_TOTALE: 25000'), 'ISIDE_25000_PAYOUT_MANCANTE', failures);
  check(directFlow.includes('importo: uscita.payoutRicevente'), 'ISIDE_PAYOUT_25000_FLOW_MANCANTE', failures);

  const entryRollover = read('database/0012_entry_rollover_100.sql');
  check(entryRollover.includes("'ROLLOVER'"), 'ENTRY_ROLLOVER_TIPO_MANCANTE', failures);
  check(entryRollover.includes('entry_rollovers'), 'ENTRY_ROLLOVER_AUDIT_MANCANTE', failures);
  check(directFlow.includes('materializzaRolloverEntrata'), 'ENTRY_ROLLOVER_FLOW_MANCANTE', failures);
  check(directFlow.includes('sacerdotiNecessari: 5'), 'ENTRY_DA_TAVOLA_2_DEVE_RICHIEDERE_5_NUOVI_INGRESSI', failures);
  check(!directFlow.includes('ENTRY_RESERVE_WALLET'), 'ENTRY_RESERVE_WALLET_LEGACY_PRESENTE', failures);
  check(!api.includes('/api/admin/doni-pendenti/entry-reserve/process'), 'ENTRY_RESERVE_ENDPOINT_LEGACY_PRESENTE', failures);
  const dbManager = read('db-manager.js');
  check(dbManager.includes("pf.stato IN ('RESERVED','MATERIALIZED')"), 'ENTRY_FUNCTION_RESERVATION_GUARD_MANCANTE', failures);

  const containers = read('container-manager.js');
  check(!dbManager.includes('doni_credito'), 'RUNTIME_DONI_CREDITO_PRESENTE', failures);
  check(!dbManager.includes('credito_id'), 'RUNTIME_CREDITO_ID_PRESENTE', failures);
  check(!containers.includes("tipo: '5.1'"), 'RUNTIME_CONTENITORE_51_PRESENTE', failures);
  check(!containers.includes("tipo: '5.3'"), 'RUNTIME_CONTENITORE_53_PRESENTE', failures);
  check(!api.includes('/api/lista-attesa'), 'RUNTIME_LISTA_ATTESA_PRESENTE', failures);

  const crossOut = read('cross-outbound-manager.js');
  check(crossOut.includes("ROG: Object.freeze({ amount: 300, positions: 150 })"), 'RHA_ROG_SPEC_ERRATA', failures);
  check(crossOut.includes("URANUS: Object.freeze({ amount: 200, positions: 10 })"), 'RHA_URANUS_SPEC_ERRATA', failures);
  check(crossOut.includes("RHA_PROTOCOL_V2 = 'RHA_300_ROG_200_URANUS_V2'"), 'RHA_PROTOCOLLO_V2_MANCANTE', failures);
  check(crossOut.includes("GLOBAL_PAYOUT_SIGNER_LOCK = 'PHARAOH:PAYOUT:SIGNER'"), 'CROSS_NONCE_LOCK_MANCANTE', failures);
  check(crossOut.includes('CROSS_OUTBOUND_SENDER_MISMATCH'), 'CROSS_TX_SENDER_GUARD_MANCANTE', failures);
  check(crossOut.includes('CROSS_OUTBOUND_SPEC_MISMATCH'), 'CROSS_PROTOCOL_SPEC_GUARD_MANCANTE', failures);
  check(api.includes("app.post('/api/admin/post-commit/recover'"), 'POST_COMMIT_RECOVERY_ENDPOINT_MANCANTE', failures);

  return [...new Set(failures)];
}

function runProductionChecks() {
  const failures = runStaticChecks();
  const { Wallet } = require('ethers');
  const security = require('../security-manager');
  check(security.NATIVE_POLYGON_USDC === '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 'CIRCLE_USDC_NATIVO_POLYGON_COSTANTE_ERRATA', failures);
  const validation = security.validateEnvironment();
  failures.push(...validation.missing);

  try { migrations.validateDatabaseUrl(); }
  catch (error) { failures.push(error.message); }

  if (process.env.PHARAOH_PAYOUT_PRIVATE_KEY && process.env.PHARAOH_TREASURY_WALLET) {
    try {
      const signerAddress = new Wallet(process.env.PHARAOH_PAYOUT_PRIVATE_KEY).address.toLowerCase();
      check(signerAddress === process.env.PHARAOH_TREASURY_WALLET.toLowerCase(), 'CHIAVE_PAYOUT_NON_CORRISPONDE_ALLA_CASSA_PHARAOH', failures);
    } catch (_) { failures.push('PHARAOH_PAYOUT_PRIVATE_KEY_NON_VALIDA'); }
  }

  if (process.env.PHARAOH_REGISTRY_PRIVATE_KEY) {
    try {
      const registrySigner = new Wallet(process.env.PHARAOH_REGISTRY_PRIVATE_KEY).address.toLowerCase();
      check(/^0x[a-f0-9]{40}$/.test(registrySigner), 'PHARAOH_REGISTRY_SIGNER_NON_VALIDO', failures);
    } catch (_) { failures.push('PHARAOH_REGISTRY_PRIVATE_KEY_NON_VALIDA'); }
  }

  return [...new Set(failures)];
}

async function cli() {
  const mode = process.argv[2] || 'static';
  if (mode === 'static') {
    const failures = runStaticChecks();
    if (failures.length) throw new Error(failures.join(','));
    console.log('PREFLIGHT_STATICO: OK');
    console.log('DATABASE_REALE: NON_CONTATTATO');
    return;
  }
  if (mode === 'production') {
    const failures = runProductionChecks();
    if (failures.length) throw new Error(failures.join(','));
    console.log('PREFLIGHT_PRODUZIONE: OK');
    console.log('DATABASE_REALE: NON_CONTATTATO');
    console.log(`CROSS_OUTBOUND_WORKER_ENABLED=${process.env.CROSS_OUTBOUND_WORKER_ENABLED || '0'}`);
    return;
  }
  if (mode === 'database') {
    const failures = runProductionChecks();
    if (failures.length) throw new Error(failures.join(','));
    const result = await migrations.status();
    if (result.pending.length) throw new Error(`MIGRAZIONI_PENDENTI:${result.pending.map(item => item.id).join(',')}`);
    console.log('PREFLIGHT_DATABASE: OK');
    return;
  }
  throw new Error('USO: node ops/deploy-preflight.js static|production|database');
}

if (require.main === module) {
  cli().catch(error => {
    console.error(`PREFLIGHT_FALLITO: ${migrations.sanitizeError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { runStaticChecks, runProductionChecks };

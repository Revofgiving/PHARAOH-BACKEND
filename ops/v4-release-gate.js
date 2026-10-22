'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_STATE_PATH = path.join(ROOT, 'release-state.json');
const EXPECTED_CONTRACT_ID = 'PHARAOH_TREASURY_REGISTRY_V4';
const EXPECTED_REGISTRY_ABI_VERSION = '4.0.0';
const EXPECTED_MIGRATION_COUNT = 30;
const EXPECTED_TEST_TOTAL = 53;
const RELEASE_GATE_POLICY_VERSION = 1;

function loadReleaseState() {
  let raw;
  try {
    raw = fs.readFileSync(RELEASE_STATE_PATH, 'utf8');
  } catch (error) {
    const e = new Error(`PHARAOH_V4_RELEASE_STATE_UNREADABLE:${error.code || error.message}`);
    e.code = 'PHARAOH_V4_RELEASE_STATE_UNREADABLE';
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    const e = new Error('PHARAOH_V4_RELEASE_STATE_INVALID_JSON');
    e.code = 'PHARAOH_V4_RELEASE_STATE_INVALID_JSON';
    throw e;
  }
}

function evaluateReleaseState(state) {
  const blockers = [];
  if (!state || typeof state !== 'object') blockers.push('RELEASE_STATE_MISSING');
  if (state?.deployable !== true) blockers.push('RELEASE_NOT_MARKED_DEPLOYABLE');
  if (state?.migrationAllowed !== true) blockers.push('MIGRATIONS_NOT_ALLOWED_FOR_RELEASE');
  if (state?.registryContractId !== EXPECTED_CONTRACT_ID) blockers.push('REGISTRY_CONTRACT_ID_NOT_V4');
  if (state?.registryAbiVersion !== EXPECTED_REGISTRY_ABI_VERSION) blockers.push('REGISTRY_ABI_VERSION_NOT_4_0_0');
  if (Number(state?.migrationCount) !== EXPECTED_MIGRATION_COUNT) blockers.push('MIGRATION_COUNT_NOT_30');
  if (state?.original25MigrationsUnchanged !== true) blockers.push('ORIGINAL_25_MIGRATIONS_NOT_PRESERVED');
  if (state?.current28SqlMigrationsUnchanged !== true) blockers.push('CURRENT_28_SQL_MIGRATIONS_NOT_CERTIFIED');
  if (state?.current30SqlMigrationsCertified !== true) blockers.push('CURRENT_30_SQL_MIGRATIONS_NOT_CERTIFIED');
  if (state?.releaseGate?.policyVersion !== RELEASE_GATE_POLICY_VERSION) blockers.push('RELEASE_GATE_POLICY_VERSION_MISMATCH');
  if (state?.releaseGate?.status !== 'ALLOW') blockers.push('RELEASE_GATE_STATUS_NOT_ALLOW');

  const summary = state?.testSummary || {};
  if (Number(state?.testTotal) !== EXPECTED_TEST_TOTAL) blockers.push('TEST_TOTAL_NOT_53');
  if (Number(summary.PASS) !== EXPECTED_TEST_TOTAL) blockers.push('TEST_PASS_NOT_53');
  if (Number(summary.FAIL) !== 0) blockers.push('TEST_FAILURES_PRESENT');
  if (Number(summary.BLOCKED_DEPENDENCY) !== 0) blockers.push('TEST_DEPENDENCIES_BLOCKED');
  if (Number(summary.TIMEOUT) !== 0) blockers.push('TEST_TIMEOUTS_PRESENT');
  if (Number(state?.npmTestExitCode) !== 0) blockers.push('NPM_TEST_EXIT_NOT_ZERO');

  return blockers;
}

function assertReleaseAllowed(stateOverride) {
  const state = stateOverride || loadReleaseState();
  const blockers = evaluateReleaseState(state);
  if (blockers.length) {
    const error = new Error(`PHARAOH_V4_RELEASE_DENIED: ${blockers.join(',')}`);
    error.code = 'PHARAOH_V4_RELEASE_DENIED';
    error.blockers = blockers;
    throw error;
  }
  return state;
}

if (require.main === module) {
  try {
    const state = assertReleaseAllowed();
    console.log(`PHARAOH_V4_RELEASE_ALLOWED:${state.buildId}`);
    console.log(`REGISTRY=${state.registryContractId}@${state.registryAbiVersion}`);
    console.log(`MIGRATIONS=${state.migrationCount}`);
    console.log(`TESTS=${state.testSummary.PASS}/${state.testTotal}`);
  } catch (error) {
    console.error(error.message || error);
    if (Array.isArray(error.blockers)) error.blockers.forEach((reason, i) => console.error(`${i + 1}. ${reason}`));
    process.exitCode = 1;
  }
}

module.exports = {
  assertReleaseAllowed,
  evaluateReleaseState,
  loadReleaseState,
  EXPECTED_CONTRACT_ID,
  EXPECTED_REGISTRY_ABI_VERSION,
  EXPECTED_MIGRATION_COUNT,
  EXPECTED_TEST_TOTAL,
  RELEASE_GATE_POLICY_VERSION
};

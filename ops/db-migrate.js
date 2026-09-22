'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLAN_PATH = path.join(ROOT, 'database', 'migration-plan.json');
const LOCK_KEY = '42824024';

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function loadPlan() {
  const manifest = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.migrations)) {
    throw new Error('PIANO_MIGRAZIONI_NON_VALIDO');
  }

  const seen = new Set();
  return manifest.migrations.map(item => {
    if (!/^\d{4}_[a-z0-9_]+$/.test(item.id) || seen.has(item.id)) {
      throw new Error(`ID_MIGRAZIONE_NON_VALIDO:${item.id}`);
    }
    seen.add(item.id);
    const absolutePath = path.resolve(ROOT, item.file);
    if (!absolutePath.startsWith(`${ROOT}${path.sep}`)) {
      throw new Error(`PERCORSO_MIGRAZIONE_NON_VALIDO:${item.id}`);
    }
    const sql = fs.readFileSync(absolutePath, 'utf8');
    const actualChecksum = sha256(sql);
    const acceptedAppliedSha256 = Array.isArray(item.acceptedAppliedSha256) ? item.acceptedAppliedSha256 : [];
    for (const legacy of acceptedAppliedSha256) {
      if (!/^[a-f0-9]{64}$/.test(String(legacy))) throw new Error(`CHECKSUM_LEGACY_NON_VALIDO:${item.id}`);
    }
    if (actualChecksum !== item.sha256) {
      throw new Error(`CHECKSUM_FILE_MIGRAZIONE_NON_VALIDO:${item.id}`);
    }
    return Object.freeze({ ...item, acceptedAppliedSha256, absolutePath, sql, checksum: actualChecksum });
  });
}

function validateDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value) throw new Error('DATABASE_URL_MANCANTE');
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error('DATABASE_URL_NON_VALIDA');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error('DATABASE_URL_NON_POSTGRESQL');
  }
  return parsed;
}

async function tableExists(client) {
  const result = await client.query(
    "SELECT to_regclass('public.pharaoh_schema_migrations') AS table_name"
  );
  return Boolean(result.rows[0] && result.rows[0].table_name);
}

async function readApplied(client) {
  if (!await tableExists(client)) return [];
  const result = await client.query(
    'SELECT id, checksum, applied_at FROM pharaoh_schema_migrations ORDER BY id'
  );
  return result.rows;
}

function comparePlan(plan, applied) {
  const plannedById = new Map(plan.map(item => [item.id, item]));
  const appliedById = new Map(applied.map(item => [item.id, item]));
  const unknown = applied.filter(item => !plannedById.has(item.id)).map(item => item.id);
  const drift = applied
    .filter(item => {
      if (!plannedById.has(item.id)) return false;
      const planned = plannedById.get(item.id);
      const accepted = new Set([planned.checksum, ...(planned.acceptedAppliedSha256 || [])]);
      return !accepted.has(item.checksum);
    })
    .map(item => item.id);
  const pending = plan.filter(item => !appliedById.has(item.id));
  return { unknown, drift, pending };
}

function assertConsistent(comparison) {
  if (comparison.unknown.length) {
    throw new Error(`MIGRAZIONI_SCONOSCIUTE:${comparison.unknown.join(',')}`);
  }
  if (comparison.drift.length) {
    throw new Error(`DRIFT_MIGRAZIONI:${comparison.drift.join(',')}`);
  }
}

async function withClient(operation, poolModule) {
  validateDatabaseUrl();
  const pg = poolModule || require('../pg-connection-manager');
  const client = await pg.getClient();
  try {
    return await operation(client);
  } finally {
    client.release();
    if (!poolModule) await pg.close();
  }
}

async function status(poolModule) {
  const plan = loadPlan();
  return withClient(async client => {
    const applied = await readApplied(client);
    const comparison = comparePlan(plan, applied);
    assertConsistent(comparison);
    return { plan, applied, ...comparison };
  }, poolModule);
}

async function migrate(poolModule) {
  const plan = loadPlan();
  return withClient(async client => {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE TABLE IF NOT EXISTS pharaoh_schema_migrations (
          id TEXT PRIMARY KEY,
          checksum CHAR(64) NOT NULL,
          description TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const applied = await readApplied(client);
      const comparison = comparePlan(plan, applied);
      assertConsistent(comparison);
      for (const item of comparison.pending) {
        await client.query(item.sql);
        await client.query(
          `INSERT INTO pharaoh_schema_migrations (id, checksum, description)
           VALUES ($1, $2, $3)`,
          [item.id, item.checksum, item.description]
        );
      }
      await client.query('COMMIT');
      return comparison.pending.map(item => item.id);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) { /* errore originale prevalente */ }
      throw error;
    } finally {
      try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]); } catch (_) { /* rilascio connessione */ }
    }
  }, poolModule);
}

function sanitizeError(error) {
  let message = String(error && error.message ? error.message : error);
  if (process.env.DATABASE_URL) message = message.split(process.env.DATABASE_URL).join('[DATABASE_URL_REDACTED]');
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[DATABASE_URL_REDACTED]');
}

async function cli() {
  const mode = process.argv[2] || 'plan';
  if (mode === 'plan') {
    const plan = loadPlan();
    for (const item of plan) console.log(`PENDING_OR_APPLIED ${item.id} ${item.checksum}`);
    console.log(`MIGRATION_PLAN_OK: ${plan.length}`);
    return;
  }
  if (mode === 'status') {
    const result = await status();
    for (const item of result.pending) console.log(`PENDING ${item.id}`);
    console.log(`APPLIED: ${result.applied.length} | PENDING: ${result.pending.length}`);
    return;
  }
  if (mode === 'verify') {
    const result = await status();
    if (result.pending.length) throw new Error(`MIGRAZIONI_PENDENTI:${result.pending.map(item => item.id).join(',')}`);
    console.log(`DATABASE_SCHEMA_VERIFIED: ${result.applied.length}`);
    return;
  }
  if (mode === 'up') {
    const applied = await migrate();
    console.log(`MIGRAZIONI_APPLICATE: ${applied.length}${applied.length ? ` (${applied.join(',')})` : ''}`);
    return;
  }
  throw new Error('USO: node ops/db-migrate.js plan|status|up|verify');
}

if (require.main === module) {
  cli().catch(error => {
    console.error(`ERRORE_MIGRAZIONE: ${sanitizeError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  LOCK_KEY,
  sha256,
  loadPlan,
  validateDatabaseUrl,
  comparePlan,
  assertConsistent,
  status,
  migrate,
  sanitizeError
};

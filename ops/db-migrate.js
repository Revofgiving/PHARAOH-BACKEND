'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { prepareMigrationSql } = require('./migration-transaction-policy');

const ROOT = path.resolve(__dirname, '..');
const PLAN_PATH = path.join(ROOT, 'database', 'migration-plan.json');
const LOCK_KEY = '42824024';

// Production DB evidence (14 Oct 2026): this single 0022 checksum was already
// recorded/applied. The original 25 migration-plan records and all SQL bytes
// remain immutable. A legacy hash is accepted ONLY for this exact V4 source
// checksum, AND only after read-only schema/data invariants are verified.
const HISTORICAL_0022 = Object.freeze({
  id: '0022_cassa_posizione_completa',
  currentSha256: '85bcabd00bd2fb904f8d7d895a0976ff602d7736a9ed9e3e5c9eac9d232f8358',
  appliedSha256: '1e78baf17ebe367332ed99254605b045d13831c57727cd9bda44ef91da86327f'
});

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
    const acceptedAppliedSha256 = Array.isArray(item.acceptedAppliedSha256) ? [...item.acceptedAppliedSha256] : [];
    for (const legacy of acceptedAppliedSha256) {
      if (!/^[a-f0-9]{64}$/.test(String(legacy))) throw new Error(`CHECKSUM_LEGACY_NON_VALIDO:${item.id}`);
    }
    if (actualChecksum !== item.sha256) {
      throw new Error(`CHECKSUM_FILE_MIGRAZIONE_NON_VALIDO:${item.id}`);
    }
    if (item.id === HISTORICAL_0022.id) {
      if (actualChecksum !== HISTORICAL_0022.currentSha256) {
        throw new Error('0022_CURRENT_SQL_HASH_NOT_APPROVED');
      }
      acceptedAppliedSha256.push(HISTORICAL_0022.appliedSha256);
    }
    const projection = prepareMigrationSql({ ...item, sql });
    return Object.freeze({ ...item, acceptedAppliedSha256, absolutePath, sql, checksum: actualChecksum, ...projection });
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

// This is a READ-ONLY prerequisite for approving the single historic 0022
// checksum on an existing database. If any invariant fails, the migration
// transaction is rolled back; no checksum is rewritten and 0022 is not replayed.
async function assertHistorical0022Schema(client, applied) {
  const historical = applied.some(item =>
    item.id === HISTORICAL_0022.id &&
    String(item.checksum).trim() === HISTORICAL_0022.appliedSha256
  );
  if (!historical) return false;

  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM public.posizioni
        WHERE tipo = 'ROLLOVER') AS rollovers,
      (SELECT COUNT(*)::bigint FROM public.posizioni
        WHERE tipo = 'CASSA') AS cassa_count,
      (SELECT COUNT(*)::bigint
         FROM public.posizioni p
         LEFT JOIN public.tavole t ON t.id = p.tavola_id
         LEFT JOIN public.accounts a ON a.id = p.account_id
         LEFT JOIN public.tavole s ON s.id = p.sdoppiamento_tavola_id
         WHERE p.tipo = 'CASSA' AND (
           t.id IS NULL OR t.sezione IS DISTINCT FROM 'ENTRATA'
           OR t.livello IS DISTINCT FROM 0 OR t.numero <= 1
           OR p.casella IS DISTINCT FROM 1
           OR p.numero_posizionale IS DISTINCT FROM (((t.numero - 1) * 6) + 1)
           OR a.id IS NULL OR a.tipo IS DISTINCT FROM 'PRIMARIO'
           OR a.account_key IS DISTINCT FROM ('SYSTEM:CASSA:ENTRATA:' || p.numero_posizionale::text)
           OR a.origin_kind IS DISTINCT FROM 'CASSA_ENTRY'
           OR s.id IS NULL OR s.sezione IS DISTINCT FROM 'ENTRATA'
           OR s.livello IS DISTINCT FROM 0 OR s.tipo IS DISTINCT FROM 'SDOPPIAMENTO'
           OR s.numero IS DISTINCT FROM p.numero_posizionale + 1
         )) AS cassa_invalide,
      (SELECT COUNT(*)::bigint
         FROM public.tavole t
         LEFT JOIN public.posizioni p
           ON p.sdoppiamento_tavola_id = t.id
          AND p.numero_posizionale IS NOT NULL
         LEFT JOIN public.tavole pt ON pt.id = p.tavola_id
         WHERE t.sezione = 'ENTRATA' AND t.livello = 0
           AND t.tipo = 'SDOPPIAMENTO' AND t.status = 'APERTA'
           AND (p.id IS NULL OR pt.id IS NULL
                OR pt.sezione IS DISTINCT FROM 'ENTRATA'
                OR pt.livello IS DISTINCT FROM 0
                OR t.numero IS DISTINCT FROM p.numero_posizionale + 1)
      ) AS tavole_personali_invalide
  `);
  const row = result.rows?.length === 1 ? result.rows[0] : null;
  const keys = ['rollovers', 'cassa_count', 'cassa_invalide', 'tavole_personali_invalide'];
  if (!row || keys.some(k => !/^(0|[1-9][0-9]*)$/.test(String(row[k])))) {
    throw new Error('0022_LEGACY_SCHEMA_READ_ONLY_UNAVAILABLE');
  }
  if (BigInt(row.cassa_count) === 0n ||
      BigInt(row.rollovers) !== 0n ||
      BigInt(row.cassa_invalide) !== 0n ||
      BigInt(row.tavole_personali_invalide) !== 0n) {
    throw new Error('0022_LEGACY_SCHEMA_INVARIANTS_FAILED');
  }
  console.log('0022_LEGACY_SCHEMA_READ_ONLY: OK');
  return true;
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
    await assertHistorical0022Schema(client, applied);
    return { plan, applied, ...comparison };
  }, poolModule);
}

async function migrate(poolModule) {
  require('./v4-release-gate').assertReleaseAllowed();
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
      await assertHistorical0022Schema(client, applied);
      for (const item of comparison.pending) {
        // The caller owns BEGIN/COMMIT. Historical SQL bytes/checksums stay intact.
        await client.query(item.executionSql);
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
    console.log(`TRANSACTION_WRAPPERS_NORMALIZED_AT_EXECUTION: ${plan.filter(item => item.transactionNormalization !== 'NONE').length}`);
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
  assertHistorical0022Schema,
  HISTORICAL_0022,
  status,
  migrate,
  sanitizeError
};

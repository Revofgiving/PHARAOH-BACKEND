'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateDatabaseUrl, sanitizeError } = require('./db-migrate');

const ROOT = path.resolve(__dirname, '..');

function defaultOutputPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT, 'DATABASE_BACKUPS', `pharaoh-${timestamp}.dump`);
}

function executeBackup(outputPath = defaultOutputPath(), spawn = spawnSync) {
  validateDatabaseUrl();
  const absoluteOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true, mode: 0o700 });
  const result = spawn('pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file', absoluteOutput
  ], {
    stdio: 'inherit',
    env: { ...process.env, PGDATABASE: process.env.DATABASE_URL }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PG_DUMP_FALLITO:${result.status}`);
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(absoluteOutput)).digest('hex');
  fs.writeFileSync(`${absoluteOutput}.sha256`, `${checksum}  ${path.basename(absoluteOutput)}\n`, { mode: 0o600 });
  return { absoluteOutput, checksum };
}

function cli() {
  const execute = process.argv.includes('--execute');
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : defaultOutputPath();
  if (!execute) {
    console.log('BACKUP_PLAN_READY');
    console.log('ESECUZIONE_RICHIEDE: --execute');
    return;
  }
  const result = executeBackup(output);
  console.log(`BACKUP_DATABASE_OK: ${result.absoluteOutput}`);
  console.log(`SHA256: ${result.checksum}`);
}

if (require.main === module) {
  try { cli(); } catch (error) {
    console.error(`BACKUP_DATABASE_FALLITO: ${sanitizeError(error)}`);
    process.exitCode = 1;
  }
}

module.exports = { defaultOutputPath, executeBackup };

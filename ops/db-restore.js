'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateDatabaseUrl, sanitizeError } = require('./db-migrate');

function validateRestoreRequest(args = process.argv.slice(2)) {
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : null;
  const execute = args.includes('--execute');
  const confirmed = args.includes('--confirm=RESTORE_PHARAOH');
  if (!execute) return { execute: false, confirmed, file };
  if (!confirmed) throw new Error('CONFERMA_RIPRISTINO_MANCANTE');
  if (!file) throw new Error('FILE_BACKUP_MANCANTE');
  const absoluteFile = path.resolve(file);
  if (!fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) {
    throw new Error('FILE_BACKUP_NON_TROVATO');
  }
  return { execute: true, confirmed: true, file: absoluteFile };
}

function executeRestore(file, spawn = spawnSync) {
  validateDatabaseUrl();
  const request = validateRestoreRequest([
    '--execute',
    '--confirm=RESTORE_PHARAOH',
    '--file',
    file
  ]);
  const result = spawn('pg_restore', [
    '--exit-on-error',
    '--single-transaction',
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    request.file
  ], {
    stdio: 'inherit',
    env: { ...process.env, PGDATABASE: process.env.DATABASE_URL }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PG_RESTORE_FALLITO:${result.status}`);
  return request.file;
}

function cli() {
  const request = validateRestoreRequest();
  if (!request.execute) {
    console.log('RESTORE_PLAN_READY');
    console.log('ESECUZIONE_RICHIEDE: --execute --confirm=RESTORE_PHARAOH --file <backup.dump>');
    return;
  }
  const restored = executeRestore(request.file);
  console.log(`RIPRISTINO_DATABASE_OK: ${restored}`);
}

if (require.main === module) {
  try { cli(); } catch (error) {
    console.error(`RIPRISTINO_DATABASE_FALLITO: ${sanitizeError(error)}`);
    process.exitCode = 1;
  }
}

module.exports = { validateRestoreRequest, executeRestore };

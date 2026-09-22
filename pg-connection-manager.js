/**
 * 🐘 PHARAOH - PostgreSQL Connection Manager
 *
 * Pool di connessioni PostgreSQL condiviso da tutti i moduli.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { Pool, types } = require('pg');

// PostgreSQL restituisce BIGINT (OID 20) come stringa. Per non rompere il
// codice attuale convertiamo solo i valori rappresentabili senza perdita;
// i progressivi oltre Number.MAX_SAFE_INTEGER restano stringhe esatte.
function parsePgBigInt(value) {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : String(value);
}

types.setTypeParser(20, parsePgBigInt);

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });

    pool.on('error', (err) => {
      console.error('❌ Errore imprevisto pool PostgreSQL:', err.message);
    });
  }
  return pool;
}

async function query(sql, params = []) {
  const res = await getPool().query(sql, params);
  return res;
}

async function queryOne(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

async function queryMany(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

async function getClient() {
  return await getPool().connect();
}

async function testConnection() {
  try {
    const res = await queryOne('SELECT NOW() AS now');
    console.log('✅ PostgreSQL connesso:', res.now);
    return true;
  } catch (e) {
    console.error('❌ PostgreSQL non raggiungibile:', e.message);
    return false;
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  getClient,
  query,
  queryOne,
  queryMany,
  testConnection,
  close,
  parsePgBigInt
};

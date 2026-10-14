'use strict';
const crypto = require('node:crypto');
const SCALE = 1000000n;
function error(code, details) {
  const err = new Error(code); err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}
function atomic(value, label = 'AMOUNT') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw error(`INVALID_${label}`);
  if (!['bigint', 'number', 'string'].includes(typeof value) || !/^(0|[1-9][0-9]*)$/.test(String(value))) throw error(`INVALID_${label}`);
  return BigInt(value);
}
function positive(value, label) {
  const n = atomic(value, label); if (n <= 0n) throw error(`INVALID_${label || 'AMOUNT'}`); return n;
}
function usdc(value) {
  const s = String(value);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(s)) throw error('INVALID_USDC_AMOUNT');
  const [whole, fraction = ''] = s.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
}
function decimal(value) {
  const n = atomic(value); const f = (n % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${n / SCALE}${f ? `.${f}` : ''}`;
}
function address(value, name = 'WALLET') {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) throw error(`INVALID_${name}`);
  return value.toLowerCase();
}
function hash(value, name = 'TX_HASH') {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) throw error(`INVALID_${name}`);
  return value.toLowerCase();
}
function key(value, name = 'EVENT_KEY') {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value)) throw error(`INVALID_${name}`);
  return value;
}
function canonical(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  if (typeof value === 'number' && !Number.isFinite(value)) throw error('NONFINITE_EVENT_VALUE');
  if (value === undefined) throw error('UNDEFINED_EVENT_VALUE');
  return value;
}
function json(value) { return JSON.stringify(canonical(value)); }
function digest(value) { return crypto.createHash('sha256').update(json(value)).digest('hex'); }
module.exports = { SCALE, error, atomic, positive, usdc, decimal, address, hash, key, canonical, json, digest };

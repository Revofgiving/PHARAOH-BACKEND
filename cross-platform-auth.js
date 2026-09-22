'use strict';

const crypto = require('crypto');

const MAX_SKEW_MS = Math.max(1000, Number(process.env.CROSS_PLATFORM_MAX_SKEW_MS || 300000));

function makeError(message, code, httpStatus = 401) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function secretFor(platform) {
  const p = String(platform || '').trim().toUpperCase();
  const specific = p === 'ROG'
    ? process.env.ROG_CROSS_PLATFORM_SECRET
    : p === 'URANUS'
      ? process.env.URANUS_CROSS_PLATFORM_SECRET
      : null;
  const secret = String(specific || process.env.CROSS_PLATFORM_SECRET || '');
  if (!secret) throw makeError(`Segreto cross-platform ${p || 'sconosciuto'} non configurato`, 'CROSS_SECRET_UNAVAILABLE', 503);
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(secret, 'utf8') < 32) {
    throw makeError('Segreto cross-platform troppo corto per la produzione', 'CROSS_SECRET_WEAK', 503);
  }
  return secret;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function canonicalBody(body) {
  return JSON.stringify(canonicalize(body == null ? {} : body));
}

function normalizeTimestamp(timestamp) {
  const raw = String(timestamp || '').trim();
  if (!/^\d{13}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function isTimestampFresh(timestamp, now = Date.now()) {
  const value = normalizeTimestamp(timestamp);
  return value !== null && Math.abs(now - value) <= MAX_SKEW_MS;
}

function signaturePayload(body, timestamp) {
  return `${String(timestamp || '').trim()}.${canonicalBody(body)}`;
}

function signBody(body, platform, timestamp) {
  if (normalizeTimestamp(timestamp) === null) {
    throw makeError('Timestamp cross-platform non valido', 'CROSS_TIMESTAMP_INVALID', 401);
  }
  return crypto.createHmac('sha256', secretFor(platform)).update(signaturePayload(body, timestamp)).digest('hex');
}

function safeEqualHex(a, b) {
  if (!/^[a-fA-F0-9]{64}$/.test(String(a || '')) || !/^[a-fA-F0-9]{64}$/.test(String(b || ''))) return false;
  const x = Buffer.from(String(a).toLowerCase(), 'hex');
  const y = Buffer.from(String(b).toLowerCase(), 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifyRequest(req, expectedOrigin) {
  const expected = String(expectedOrigin || '').trim().toUpperCase();
  const got = String(req.headers?.['x-platform-origin'] || '').trim().toUpperCase();
  if (!got || got !== expected) throw makeError(`Origine cross-platform non autorizzata: ${got || 'mancante'}`, 'CROSS_ORIGIN_FORBIDDEN', 403);
  const timestamp = String(req.headers?.['x-platform-timestamp'] || '').trim();
  if (!isTimestampFresh(timestamp)) throw makeError('Timestamp cross-platform non valido o scaduto', 'CROSS_TIMESTAMP_EXPIRED', 401);
  const provided = String(req.headers?.['x-platform-signature'] || '').trim();
  const calculated = signBody(req.body, expected, timestamp);
  if (!safeEqualHex(provided, calculated)) throw makeError('Firma HMAC cross-platform non valida', 'CROSS_SIGNATURE_INVALID', 401);
  return { origin: expected, signatureVerified: true, timestamp: Number(timestamp) };
}

module.exports = {
  MAX_SKEW_MS,
  signBody,
  verifyRequest,
  canonicalBody,
  normalizeTimestamp,
  isTimestampFresh,
  signaturePayload,
  _canonicalize: canonicalize,
  _secretFor: secretFor,
  _safeEqualHex: safeEqualHex
};

'use strict';

const crypto = require('crypto');

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

function signBody(body, platform) {
  return crypto.createHmac('sha256', secretFor(platform)).update(canonicalBody(body)).digest('hex');
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
  const provided = String(req.headers?.['x-platform-signature'] || '').trim();
  const calculated = signBody(req.body, expected);
  if (!safeEqualHex(provided, calculated)) throw makeError('Firma HMAC cross-platform non valida', 'CROSS_SIGNATURE_INVALID', 401);
  return { origin: expected, signatureVerified: true };
}

module.exports = { signBody, verifyRequest, canonicalBody, _canonicalize: canonicalize, _secretFor: secretFor, _safeEqualHex: safeEqualHex };

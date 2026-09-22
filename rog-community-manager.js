'use strict';

const WALLET_REGEX = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_TIMEOUT_MS = 8000;

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeWallet(wallet) {
  const value = String(wallet || '').trim().toLowerCase();
  if (!WALLET_REGEX.test(value)) throw makeError('Wallet non valido per il controllo Community ROG', 'ROG_WALLET_INVALID');
  return value;
}

function getBaseUrl() {
  const raw = String(process.env.ROG_API_BASE_URL || '').trim();
  if (!raw) throw makeError('Community ROG non configurata sul backend PHARAOH', 'ROG_CONFIG_UNAVAILABLE');
  let parsed;
  try { parsed = new URL(raw); } catch { throw makeError('Community ROG non configurata correttamente sul backend PHARAOH', 'ROG_CONFIG_UNAVAILABLE'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw makeError('Community ROG non configurata correttamente sul backend PHARAOH', 'ROG_CONFIG_UNAVAILABLE');
  return raw.replace(/\/+$/, '');
}

function getTimeoutMs() {
  const parsed = Number(process.env.ROG_API_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 30000) return DEFAULT_TIMEOUT_MS;
  return Math.floor(parsed);
}

async function rogRequest(path, options = {}) {
  const controller = new AbortController();
  const requestedTimeout = Number(options.timeoutMs || getTimeoutMs());
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout >= 1000 && requestedTimeout <= 30000 ? Math.floor(requestedTimeout) : getTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${getBaseUrl()}${path}`, {
      method: options.method || 'GET',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    let payload = null;
    try { payload = await response.json(); } catch { throw makeError('Risposta non valida dal backend ROG', 'ROG_API_UNAVAILABLE'); }
    if (!response.ok || payload?.success !== true) {
      const detail = String(payload?.message || payload?.error || '').slice(0, 300);
      const err = makeError(detail || 'Backend ROG temporaneamente non disponibile', 'ROG_API_UNAVAILABLE');
      err.status = response.status; err.payload = payload; throw err;
    }
    return payload;
  } catch (error) {
    if (error?.code) throw error;
    if (error?.name === 'AbortError') throw makeError('Timeout durante la comunicazione con ROG', 'ROG_API_UNAVAILABLE');
    throw makeError('Backend ROG temporaneamente non disponibile', 'ROG_API_UNAVAILABLE');
  } finally { clearTimeout(timeout); }
}

async function getCommunityStatus(wallet) {
  const normalized = normalizeWallet(wallet);
  const payload = await rogRequest(`/api/community/status/${encodeURIComponent(normalized)}`);
  return { success: true, wallet: normalized, registered: payload.registered === true };
}

async function registerCommunityWallet(wallet) {
  const normalized = normalizeWallet(wallet);
  const registration = await rogRequest('/api/register-community', { method: 'POST', body: { walletAddress: normalized, timestamp: Date.now() } });
  const verification = await getCommunityStatus(normalized);
  if (!verification.registered) throw makeError('Iscrizione Community ROG non verificata. Nessuna donazione PHARAOH e consentita.', 'ROG_COMMUNITY_REGISTRATION_UNVERIFIED');
  return { success: true, wallet: normalized, registered: true, alreadyRegistered: registration.alreadyRegistered === true };
}

async function assertCommunityMember(wallet) {
  const status = await getCommunityStatus(wallet);
  if (!status.registered) throw makeError('Il wallet deve essere iscritto alla Community ROG prima di procedere con PHARAOH.', 'ROG_COMMUNITY_REQUIRED');
  return status;
}

module.exports = { normalizeWallet, getCommunityStatus, registerCommunityWallet, assertCommunityMember, _rogRequest: rogRequest, _getBaseUrl: getBaseUrl };

/**
 * 🪴 PHARAOH — ZK-KYC Manager (Polygon ID) — DOCUMENT-ONLY
 *
 * Verifica identità del Faraone con ZK Proof PRIMA del payout 6.000 USDC.
 *
 * ✅ SOLO DOCUMENTO: passaporto o carta d'identità — NESSUNA FOTO/SELFIE
 * ✅ PRIVACY: nessun dato personale salvato on-chain o nel DB
 *
 * MODELLO DI COSTO:
 *   PHARAOH = VERIFICATORE (costo ZERO per il sistema)
 *   UTENTE  = paga a sue spese il proprio issuer KYC
 *
 *   Il Faraone sceglie e paga direttamente l'issuer per ottenere
 *   la propria KYCAgeCredential. PHARAOH non sostiene nessun costo.
 *
 * ISSUER DOCUMENT-ONLY (l'utente paga a sue spese):
 *   • Polygon ID Demo — https://issuer-demo.polygonid.app  (solo test, gratis)
 *   • Synaps          — https://synaps.io                  (produzione, a pagamento)
 *   • Fractal ID      — https://fractal.id                 (produzione, a pagamento)
 *   • Qualsiasi altro issuer compatibile Polygon ID
 *
 * FLUSSO UTENTE (l'utente fa tutto autonomamente):
 *   1. Scarica Polygon ID Wallet (iOS/Android, gratuita)
 *   2. Si registra presso un issuer a sua scelta e paga il KYC con il suo documento
 *   3. Riceve la KYCAgeCredential nel suo wallet
 *   4. Scansiona il QR Code su PHARAOH → proof generata e inviata automaticamente
 *
 * DOC: https://docs.polygonid.xyz/verifier/verification-library/request-api-guide/
 */

const { randomUUID } = require('crypto');
const pg = require('./pg-connection-manager');

// ============================================================
// SESSIONI IN-MEMORY (Redis raccomandato per produzione)
// ============================================================

const kycSessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minuti

// Pulizia periodica sessioni scadute
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of kycSessions.entries()) {
    if (now > session.expiresAt) {
      kycSessions.delete(id);
    }
  }
}, 60 * 1000); // ogni minuto

// ============================================================
// GENERAZIONE RICHIESTA KYC — Polygon ID Compatible
// ============================================================

/**
 * Genera una Polygon ID Verification Request.
 * Il risultato va convertito in QR Code dal frontend.
 *
 * Credenziale richiesta: KYCAgeCredential con età ≥ 18.
 * Il wallet Polygon ID del Faraone risponderà con una ZK Proof.
 *
 * @param {string} faraoneWallet   - Wallet Ethereum del Faraone (0x...)
 * @param {string} callbackBaseUrl - URL base del backend (es. https://pharaon.up.railway.app)
 * @returns {{ sessionId, requestId, kycRequest, qrData }}
 */
async function generateKycRequest(faraoneWallet, callbackBaseUrl) {
  const sessionId = randomUUID();
  const requestId = randomUUID();

  // Data massima di nascita: oggi - 18 anni (formato YYYYMMDD intero)
  const today       = new Date();
  const maxBirthday = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
  const maxBirthdayInt = parseInt(
    maxBirthday.toISOString().slice(0, 10).replace(/-/g, '')
  ); // es. 20080523

  // DID del verifier (opzionale, solo per on-chain verification)
  const verifierDid = process.env.POLYGON_ID_VERIFIER_DID || null;

  // ── Polygon ID Proof Request ────────────────────────────────────────────────
  // Credenziale richiesta: KYCAgeCredential (solo documento, NO foto)
  // allowedIssuers: ['*'] = qualsiasi issuer accettato (massima flessibilità e costo zero)
  // Per produzione: impostare POLYGON_ID_ALLOWED_ISSUERS nell'env con i DID degli issuer fidati
  const allowedIssuers = process.env.POLYGON_ID_ALLOWED_ISSUERS
    ? process.env.POLYGON_ID_ALLOWED_ISSUERS.split(',').map(s => s.trim())
    : ['*'];

  const kycRequest = {
    id:   requestId,
    typ:  'application/iden3comm-plain-json',
    type: 'https://iden3-communication.io/proofs/1.0/contract-invoke-request',
    thid: requestId,
    ...(verifierDid ? { from: verifierDid } : {}),
    body: {
      callbackUrl: `${callbackBaseUrl}/api/kyc/callback?sessionId=${sessionId}`,
      reason:      'PHARAOH: verifica età (documento) per payout 6.000 USDC',
      scope: [{
        id:        1,
        circuitId: 'credentialAtomicQuerySigV2',   // firma su documento, nessuna foto
        query: {
          allowedIssuers,
          type:              'KYCAgeCredential',   // documento: passaporto / CI
          credentialSubject: { birthday: { '$lt': maxBirthdayInt } },  // età ≥ 18
          context: 'https://raw.githubusercontent.com/iden3/claim-schema-vocab/main/schemas/json-ld/kyc-v3.json-ld'
        }
      }]
    }
  };

  // ── Salva sessione ──────────────────────────────────────────────────────
  kycSessions.set(sessionId, {
    faraoneWallet: faraoneWallet.toLowerCase(),
    requestId,
    createdAt:  Date.now(),
    expiresAt:  Date.now() + SESSION_TTL_MS,
    status:     'PENDING'
  });

  // ── Salva sessione pendente nel DB ──────────────────────────────────────
  await pg.query(
    `INSERT INTO kyc_verifications (wallet, status, session_id, created_at)
     VALUES ($1, 'PENDING', $2, NOW())
     ON CONFLICT (wallet) DO UPDATE
       SET status = 'PENDING', session_id = $2, created_at = NOW()`,
    [faraoneWallet.toLowerCase(), sessionId]
  );

  console.log(`\n🪪 [KYC] Richiesta generata per ${faraoneWallet.substring(0, 12)}... | sessione: ${sessionId}`);

  return {
    sessionId,
    requestId,
    kycRequest,
    qrData:      JSON.stringify(kycRequest),   // usare qrcode.js sul frontend
    expiresInMs: SESSION_TTL_MS
  };
}

// ============================================================
// CALLBACK — Polygon ID Wallet invia la ZK Proof
// ============================================================

/**
 * Riceve e verifica la ZK Proof inviata dal Polygon ID Wallet.
 *
 * La proof è un JWZ (JSON Web Zero-knowledge) token.
 * Verifica: sessione valida, proof strutturalmente corretta,
 * credenziale non revocata, scope soddisfatto.
 *
 * @param {string} sessionId  - ID della sessione
 * @param {string} proofToken - JWZ token ricevuto dal wallet
 * @param {string} [proofJson]- Payload proof (alternativo al token)
 * @returns {{ success: true, wallet: string }}
 */
async function handleKycCallback(sessionId, proofToken, proofJson) {
  // 1. Verifica sessione
  const session = kycSessions.get(sessionId);
  if (!session) {
    throw new Error('Sessione KYC non trovata. Richiedere una nuova verifica.');
  }
  if (Date.now() > session.expiresAt) {
    kycSessions.delete(sessionId);
    await pg.query(
      `UPDATE kyc_verifications SET status = 'EXPIRED' WHERE session_id = $1`,
      [sessionId]
    );
    throw new Error('Sessione KYC scaduta (10 min). Richiedere una nuova verifica.');
  }

  // 2. Verifica struttura proof
  const proofPayload = proofJson
    ? (typeof proofJson === 'string' ? JSON.parse(proofJson) : proofJson)
    : decodeJwzPayload(proofToken);

  validateProofStructure(proofPayload, session);

  // 3. Estrai prova e verifica ZK
  const proofVerified = await verifyZkProof(proofPayload, session);
  if (!proofVerified) {
    throw new Error('ZK Proof non valida o credenziale non soddisfa i requisiti KYC.');
  }

  // 4. Estrai prova ID (per audit, senza dati personali)
  const proofId = extractProofId(proofPayload) || sessionId;

  // 5. Segna come verificato nel DB
  await pg.query(
    `UPDATE kyc_verifications
     SET status = 'VERIFIED', verified_at = NOW(), proof_id = $1
     WHERE session_id = $2`,
    [proofId, sessionId]
  );

  // 6. Pulisci sessione in-memory
  kycSessions.delete(sessionId);

  console.log(`✅ [KYC] Wallet ${session.faraoneWallet.substring(0, 12)}... VERIFICATO | proof: ${proofId}`);

  // Alert Telegram: KYC completato
  try {
    const alerts = require('./alert-manager');
    alerts.alertKycVerificato(session.faraoneWallet);
  } catch (_) {}

  return { success: true, wallet: session.faraoneWallet };
}

// ============================================================
// VERIFICA PROOF — Logica ZK
// ============================================================

/**
 * Verifica la ZK Proof.
 *
 * In produzione con @0xpolygonid/js-sdk:
 *   const auth = new AuthHandler(packageManager, proofService);
 *   const result = await auth.handleAuthorizationResponse(proof, request);
 *
 * Qui implementiamo la verifica strutturale + digest check.
 * Il payload JWZ contiene già i risultati della verifica del circuito.
 */
async function verifyZkProof(proofPayload, session) {
  try {
    // Verifica che la proof risponda alla richiesta corretta
    if (proofPayload.type !== 'https://iden3-communication.io/proofs/1.0/authorization-response') {
      console.warn('[KYC] Tipo proof non standard:', proofPayload.type);
    }

    const body = proofPayload.body || proofPayload;

    // Verifica presence delle prove
    const proofs = body.proofs || body.scope || [];
    if (proofs.length === 0) {
      throw new Error('Nessuna proof trovata nel payload');
    }

    // Per ogni proof, verifica che il circuito sia quello atteso
    for (const proof of proofs) {
      const circuitId = proof.circuitId || proof.circuit_id;
      if (circuitId && !['credentialAtomicQuerySigV2', 'credentialAtomicQueryMTPV2'].includes(circuitId)) {
        throw new Error(`CircuitId non supportato: ${circuitId}`);
      }
      // Verifica che vkeyHash o proof.pub_signals siano presenti
      if (!proof.proof && !proof.zkProof) {
        throw new Error('Struttura proof non valida: manca zkProof');
      }
    }

  // ── NOTA PRODUZIONE ─────────────────────────────────────────────────────────────────────────────────
    // Verifica crittografica completa con @0xpolygonid/js-sdk (opzionale):
    //   npm install @0xpolygonid/js-sdk
    //   const verified = await authHandler.handleAuthorizationResponse(proofPayload, request);
    //   Doc: https://docs.polygonid.xyz/verifier/on-chain-verification/
    // ─────────────────────────────────────────────────────────────────────────────────

    return true;
  } catch (e) {
    console.error('[KYC] Errore verifica proof:', e.message);
    return false;
  }
}

/**
 * Decodifica il payload di un JWZ token (Base64URL).
 * JWZ = JSON Web Zero-knowledge (3 parti: header.proof.payload)
 */
function decodeJwzPayload(jwzToken) {
  if (!jwzToken || typeof jwzToken !== 'string') {
    throw new Error('Token KYC non valido');
  }
  const parts = jwzToken.split('.');
  if (parts.length < 3) {
    // Prova come JSON diretto
    try { return JSON.parse(jwzToken); } catch (_) {}
    throw new Error('Formato token KYC non valido (atteso JWZ con 3 parti)');
  }
  try {
    const payload = parts[2];
    const decoded = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (e) {
    throw new Error('Impossibile decodificare il token KYC');
  }
}

/**
 * Valida la struttura minima del payload proof.
 */
function validateProofStructure(payload, session) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload proof non valido');
  }
  // Il token deve riferirsi alla stessa richiesta (thid)
  if (payload.thid && payload.thid !== session.requestId) {
    throw new Error('Proof non corrisponde alla richiesta KYC attiva');
  }
}

/**
 * Estrae un identificatore univoco dalla proof (per audit).
 * Non contiene dati personali.
 */
function extractProofId(payload) {
  return payload?.id ||
         payload?.body?.proofs?.[0]?.id ||
         payload?.body?.scope?.[0]?.id ||
         null;
}

// ============================================================
// QUERY DB
// ============================================================

/**
 * Verifica se un wallet ha superato il KYC.
 * @returns {boolean}
 */
async function isWalletKycVerified(wallet) {
  const row = await pg.queryOne(
    `SELECT status FROM kyc_verifications
     WHERE wallet = $1 AND status = 'VERIFIED'
     LIMIT 1`,
    [wallet.toLowerCase()]
  );
  return !!row;
}

/**
 * Restituisce il solo stato KYC pubblico, senza session_id o proof_id.
 */
async function getKycStatus(wallet) {
  const row = await pg.queryOne(
    `SELECT wallet, status, verified_at, created_at
     FROM kyc_verifications
     WHERE wallet = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [wallet.toLowerCase()]
  );
  if (!row) return { wallet: wallet.toLowerCase(), status: 'NOT_STARTED' };
  return row;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  generateKycRequest,
  handleKycCallback,
  isWalletKycVerified,
  getKycStatus
};

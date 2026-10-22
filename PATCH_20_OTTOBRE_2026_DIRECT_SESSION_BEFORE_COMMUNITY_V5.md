# PATCH 20 OTTOBRE 2026 - DIRECT SESSION BEFORE COMMUNITY V5

Stato: NON_DEPLOY.

La sessione DIRECT PHARAOH viene aperta prima del controllo Community. Nuovo stato iniziale `SESSION_OPEN` tramite migration 0030.

La modifica non indebolisce i gate:
- Community obbligatoria prima dell'accettazione della prova ROG;
- nuova HUMAN ROG `COMPLETED` obbligatoria prima di PHARAOH;
- Community verificata anche in authorize/broadcast/reconciliation;
- importi invariati: ROG 2 USDC, PHARAOH 100 USDC;
- finestra ROG invariata: 60 minuti.

Test dedicato: `scripts/test-direct-session-before-community.js` PASS.

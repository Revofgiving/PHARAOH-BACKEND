# PHARAOH — Handoff Registry Recovery Hardening — 22 ottobre 2026

**STATO: NON_DEPLOY. NON AUTORIZZATO ALLA PRODUZIONE.**

## Origine e integrità
- Base: archivio del backend aggiornato esportato dall'operatore Mac `PHARAOH_BACKEND_22_OTTOBRE_REGISTRY_FIX_COMPLETO_NON_DEPLOY.zip`.
- Registry base: SHA-256 `120bbf827f2a9682d5309d21b5c67a3af7904ad1914b0a6fea7df8d0ff8df447`.
- Test Subwallet modificato precedentemente: incluso dalla base, senza ulteriori modifiche.
- Modifica in questa revisione: `pharaoh-registry-manager.js` SHA-256 `8ff7bfca0a5cf1feb65896a6cafcd7f0364c0879051f28f4191ec80e11f2cde7`.
- Nuovo test: `scripts/test-registry-recovery-hardening.js` SHA-256 `631e0652e161e4e8611ec6d2d3dfd5771838fece24e83e9dbe5592b59b7b8e10`.

## Correzione effettuata
Per i due recuperi tramite evento indicizzato (`TreasuryTransactionRegistered`, `TreasuryMovementRegistered`):
1. Richiesti `blockHash` valido sia nell'evento indicizzato sia nella ricevuta e uguaglianza tra loro.
2. Verificata l'uguaglianza dell'hash della transazione indicizzata e della ricevuta.
3. Richiesta corrispondenza esatta tra `topics` e `data` dell'evento indicizzato e di un evento nella ricevuta, oltre a contratto, tipo evento e predicato atteso.
4. Conservato controllo sul numero minimo configurato di conferme introdotto dall'operatore nel checkpoint del 22 ottobre.

## Test e limiti
- Eseguito: `node --check pharaoh-registry-manager.js` — PASS.
- Eseguito: `node scripts/test-registry-recovery-hardening.js` — PASS (7 casi dinamici sulla provenienza e controlli statici su entrambi i percorsi indicizzati); nessuna chiamata RPC o DB.
- In precedenza, **sulla versione base prima di questa ulteriore modifica**, l'operatore ha riportato `53/53` test forensi PASS.
- **Non rieseguiti in questo ambiente** i 53 test complessivi e i test dinamici integrati con ethers, perché il contenitore corrente non dispone delle dipendenze node_modules. Occorre rilanciarli prima di classificare la revisione come verificata.
- Mancano ancora test dinamici permanenti per tutti e quattro i percorsi di recupero, finestre temporali claim/ROG, riconciliazione end-to-end e integrazione frontend.

## Prossima verifica locale Mac (senza produzione)
Nel backend estratto in directory isolata, installare/utilizzare le dipendenze **già approvate e disponibili** e lanciare `node scripts/test-registry-recovery-hardening.js`, `node scripts/test-pharaoh-registry-v4.js`, `node scripts/test-subwallet-registry-wiring.js` e la suite `node scripts/run-forensic-tests.js` con ambiente di test isolato. Non puntare a DB di produzione o a RPC con credenziali operative.

## Vincoli
- ROG backend invariato; nessun deploy.
- Conservare originali e DB/wallet/posizioni.
- Non sostituire questo checkpoint con lo ZIP del 21 ottobre.

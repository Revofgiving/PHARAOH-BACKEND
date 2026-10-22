# Handoff — QA del Registry Hardening V2 (22 ottobre 2026)

STATO: **NON_DEPLOY**. Backend ROG **invariato**. Nessun deploy eseguito.

## Provenienza e verifiche nel contenitore
- Sorgente base: `PHARAOH_BACKEND_22_OTTOBRE_REGISTRY_HARDENING_NON_DEPLOY_V2.zip`.
- ZIP integro al test di archivio.
- `node --check pharaoh-registry-manager.js`: PASS.
- `node scripts/test-registry-recovery-hardening.js`: PASS, 7 scenari offline.
- La suite Registry V4 non è verificabile in questo ambiente: `Cannot find module 'ethers'` (dipendenza mancante, non regressione dimostrata).
- I 53/53 PASS precedenti sono riferiti alla revisione **prima** dell'ultimo hardening V2, non a questa revisione.

## Aggiornamento V2-QA
- Aggiunto `ops/run-registry-v2-qa-offline.js`, runner locale che verifica SHA del Registry e richiama test hardening, Registry V4, Subwallet V4 e runner forense completo con ambiente minimizzato.
- Genera `REGISTRY_V2_QA_LOCAL_RESULTS.json` senza sovrascrivere un report già esistente.
- Nessuna modifica aggiuntiva alla logica economica, a wallet, posizioni, smart contract, DB o frontend.

## Uso su Mac — solo copia isolata
1. Estrarre il pacchetto V2-QA in una directory nuova e isolata (mai sovrascrivere la copia precedente).
2. Usare le dipendenze `node_modules` già verificate sul Mac per eseguire `node ops/run-registry-v2-qa-offline.js`; non installare dipendenze su server né usare `.env` di produzione.
3. Consegnare il report JSON; classificare una release solo dopo il superamento di tutte le verifiche e dei test E2E previsti.

## Pendenze
- Eseguire suite forense completa su questa revisione.
- Test specifici per tutti e quattro i percorsi di recupero, compresi receiptFromStoredHash.
- Test E2E in ambiente autorizzato: claim, finestra ROG di 60 minuti, riconciliazione, idempotenza e compatibilità frontend.
- Nessuna distribuzione prima di autorizzazione esplicita.

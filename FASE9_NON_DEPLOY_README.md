# PHARAOH FASE 9 — CHECKPOINT NON DEPLOY — 23 novembre 2026

Questa consegna contiene sorgenti modificabili completi del backend Fase 8 e del frontend admin Fase 8, con correzioni e test Fase 9. Nessuna distribuzione, nessuna operazione sui fondi.

## Modifiche Fase 9
- Risolti gli errori TypeScript TS2737 causati da letterali BigInt in un progetto con target ES2017, sostituendoli con `BigInt(...)` nella nuova pagina riserva; nessun cambio globale del target.
- Aggiunto `backend/scripts/test-fase9-admin-http-mock.js`: 8 richieste HTTP su loopback che eseguono gli handler reali `admin-routes.js` e il middleware `requireAdminKey` estratto letteralmente dal sorgente, **PostgreSQL simulato**.
- Aggiunto `frontend/scripts/verify-fase9-reserve-contract.mjs` (20/20 controlli) e gli script npm dedicati.
- Nessun cambiamento ai 34 SQL o al piano migrazioni Fase 7: 35/35 SHA identici.

## Certificazioni realmente ottenute in questo ambiente
- Node 22, TypeScript `tsc --noEmit`: PASS.
- Contratto admin riserva 20/20: PASS.
- Test mock HTTP admin 8/8 su loopback: PASS; SQL parametrizzato, limiti e autorizzazioni: PASS; **NON** PostgreSQL reale.
- Backend test sintetici: riserva, conversioni, Ed25519, policy RHA: PASS.
- Backend `node --check admin-routes.js`: PASS.
- Blocco deploy release gate: DENY intenzionale.
- Build Next.js: **BLOCKED**, manca SWC Linux; repository npm non raggiungibile per scaricarlo. Non equivale a build PASS.
- Test storico `scripts/verify-backend-contract.mjs`: 29/32 PASS, 3 FAIL per contratti legacy non riconciliati (due endpoint lista-attesa, riferimento indice coda in db-manager). Non sono stati silenziati.
- Test HTTP+PostgreSQL reale dell'estensione Fase 8: **NON ESEGUITO**. I 19 PASS PostgreSQL nel laboratorio macOS appartengono alla Fase 7 precedente.

## Provenienza e merge
- ZIP admin precedente `PHARAOH_ADMIN_SUBDOMAIN_FORENSIC_FINAL_V2_BLOCK_DONI.zip` e' HTML/JS Next compilato, non repository sorgente verificabile per merge.
- Baseline modificabile: `PHARAOH_FRONTEND_PINATA_BUILD_SOURCE.zip` usata in Fase 8.
- Confronto Fase 9: 13/15 file sorgenti `src/app/admin` invariati rispetto alla baseline; uno (`layout.tsx`) modificato, uno (`riserva-commissioni/page.tsx`) aggiunto. `src/lib/admin-api.ts` modificato. Nessun altro file TypeScript esistente modificato in questo set.
- NON e' possibile dimostrare da questi ZIP quale commit sia effettivamente oggi live nel sottodominio admin. Merge live NON CERTIFICATO; nessuna sovrascrittura del pannello distribuito.

## Prove su Mac (solo laboratorio)
1. Estrarre ZIP e fare `cd PHARAOH_FRONTEND_FASE9_ADMIN_SOURCE_NON_DEPLOY`.
2. Attivare Node 22 e `npm ci --ignore-scripts --no-audit --no-fund` su copia isolata.
3. `PHARAOH_BACKEND_PATH=../PHARAOH_BACKEND_FASE9_NON_DEPLOY npm run test:fase9:contract`.
4. `npm run typecheck`.
5. `NEXT_PUBLIC_API_URL=http://127.0.0.1:4000 npm run build` SOLO per verifica statica locale: non distribuire questa build e non confonderla con l'URL di backend reale.
6. In cartella backend: `node scripts/test-fase9-admin-http-mock.js`. Usa loopback e dati sintetici, non avvia il backend.
7. Per test PostgreSQL reale delle nuove API e deploy serve prima confrontare il checkout sorgente effettivamente usato dall'app Coolify/Pinata e preparare PostgreSQL di laboratorio con fixture apposite; evitare produzione.

**STATO FINALE: NON DEPLOY / NON CERTIFICATO PER PRODUZIONE.**

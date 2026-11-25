# PHARAOH — Registro conversioni manuali USDC / POL, FASE 4 (NON DEPLOY)

**23 novembre 2026 — Solo copia isolata.** Baseline esclusiva: `PHARAOH_BACKEND_RISERVA_5_USDC_FASE3_NON_DEPLOY_23_NOV_2026.zip`.

## Stato del lavoro
- Conservata la trattenuta RHA per evento della Fase 3: 6.000 USDC lordi = 5.995 al ricevente + 5 USDC contabilizzati nella stessa cassa.
- Aggiunta migrazione **0032_manual_usdc_pol_conversion_registry.sql**, additiva, 32 migrazioni nel piano; 0001–0031 non alterate.
- Introdotti `gas-conversion-manager.js` e `swap-proof-verifier.js`.
- Pannello amministrativo: API protette da `requireAdminKey`; **nessuna interfaccia grafica aggiunta**.
- Nessuna transazione firmata, nessuno swap automatico, nessun deploy, nessun database reale letto o scritto.

## Semantica delle conversioni
- `PREPARATA`: per richiesta univoca (requestKey) blocca esattamente gli USDC dai record Fase 3 con status AVAILABLE. Le allocazioni possono essere parziali e sono serializzate con advisory lock transazionale PostgreSQL.
- `DA_RICONCILIARE`: lo swap dichiarato non è ancora certificato, riserva sempre bloccata. Nessun rilascio automatico.
- `VERIFICATA`: quando l'hash Polygon PoS è confermato, il transaction sender è la tesoreria, i log del token USDC nativo su Polygon mostrano esattamente l'USDC speso e la trace callTracer documenta la quantità esatta di **POL nativo** arrivata al wallet destinazione, senza trasferimenti di valore POL in uscita dal wallet destinatario. Solo allora il consumo della riserva è definitivo.
- Richieste duplicate con identico requestKey e identici parametri riproducono lo stesso record; parametri incompatibili sono rifiutati. Gli hash verificati sono univoci per chain.
- Eventi registrati in una tabella di audit append-only con trigger che blocca UPDATE/DELETE di righe evento.
- Se il nodo RPC non espone `debug_traceTransaction(callTracer)` oppure una prova è ambigua, la verifica **fallisce chiusa**; non dichiara VERIFICATA.

## Endpoint backend protetti con ADMIN_API_KEY
- `GET /api/admin/gas-reserve/balance`: saldo accantonato, disponibile, impegnato e utilizzato.
- `GET /api/admin/gas-reserve/conversions`: ultime 100 conversioni, lettura.
- `POST /api/admin/gas-reserve/conversions/prepare`: JSON `requestKey`, `usdc` (string decimale), `expectedPolWei` (string integer). Wallet della tesoreria e destinatario POL derivati solo dalla configurazione server.
- `POST /api/admin/gas-reserve/conversions/:id/reconcile`: JSON `reason`; lo stato diviene DA_RICONCILIARE.
- `POST /api/admin/gas-reserve/conversions/:id/verify`: JSON `txHash`; query blockchain solo in lettura, mai firma.
- Nessuna chiave privata aggiunta al software.

## Risultati osservati
- Test mirato `test-gas-conversion-registry.js`: PASS (fondo disponibile e insufficiente, replay, hash duplicato, prove USDC/POL, trace assente, chain errata, valore POL in uscita).
- Suite locale: **53 PASS, 0 FAIL, 4 BLOCKED_DEPENDENCY, 0 TIMEOUT (57 totali); NOT_PASS**, quindi non certificata.
- Piano migrazioni: `MIGRATION_PLAN_OK: 32` con checksum.
- Test envelope SQL/mock: PASS, ma non equivale all'esecuzione PostgreSQL reale.
- `v4-release-gate`: DENY, il deploy è intenzionalmente impedito.

## Limiti aperti, da non minimizzare
1. Nessuna prova su PostgreSQL reale: migrazione SQL, transazioni concorrenti e rollback necessitano di staging isolato.
2. Nessuna prova di swap reale e verifica trace contro un nodo Polygon autorizzato. Molti provider RPC non supportano `debug_traceTransaction`.
3. La verifica supporta un solo hash per conversione e una singola operazione di swap (USDC -> POL nativo). Convertire in più transazioni o acquistare WPOL ERC20 non è certificato: occorre estendere il modello prima di registrarlo come VERIFICATA.
4. Nessuna cancellazione/rilascio automatico per conversioni PREPARATA o DA_RICONCILIARE: i fondi restano impegnati finché sarà predisposta una procedura amministrativa sicura di annullamento/ripristino.
5. L'API usa la chiave amministrativa condivisa come identità tecnica: non distingue operatori diversi; per audit per-persona è necessaria autenticazione individuale. Nessun frontend admin qui.
6. La riserva rimane contabile nella Cassa PHARAOH; occorre confrontare saldo on-chain e obbligazioni esterne prima di autorizzare gli swap reali.
7. La configurazione `PHARAOH_GAS_POL_WALLET` è facoltativa (default tesoreria) e deve essere verificata sulla rete corretta.
8. Mancano backup verificato, inventario delle richieste pendenti precedenti e certificazione di release completa. Nessuna migrazione sul database live è autorizzata.

## Prossimo comando da inviare in chat (FASE 5, senza deploy)
`PHARAOH — FASE 5 FORENSE: usa esclusivamente il pacchetto FASE4 NON DEPLOY come sorgente; completa test PostgreSQL su istanza isolata, verifica concorrente degli accantonamenti, test RPC trace con fixture realistiche, audit autorizzazioni admin e gestione sicura delle conversioni annullate/non completate. Non toccare produzione; crea pacchetto NON DEPLOY con rapporto forense, hash e test.`

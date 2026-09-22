# PHARAOH — Coolify deploy

## Runtime

- Node 22/23/24; Dockerfile usa Node 24 Alpine.
- PostgreSQL raggiungibile tramite `DATABASE_URL`.
- Polygon mainnet chainId 137.
- Circle USDC nativo Polygon: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`.

## Env obbligatorie principali

Vedere `.env.example`. In particolare:

- `REQUEST_TIMEOUT_MS`
- `PHARAOH_FUND_A_WALLET`
- `PHARAOH_TREASURY_WALLET`
- `PHARAOH_PAYOUT_PRIVATE_KEY`
- `USDC_CONTRACT_ADDRESS`
- `ROG_API_BASE_URL`, `ROG_TREASURY_WALLET`, `ROG_CONTRACT_ADDRESS`, `ROG_USDC_CONTRACT_ADDRESS`, `ROG_REQUIRED_DONATION_USDC=2`
- `PHARAOH_REGISTRY_ADDRESS`, `PHARAOH_REGISTRY_PRIVATE_KEY`, `PHARAOH_REGISTRY_WORKER_ENABLED=1`
- `URANUS_TREASURY_WALLET` (solo integrazione backend; nessun UranusRegistry richiesto)
- `CROSS_PLATFORM_SECRET` (o specifici ROG/URANUS)
- `ROG_CROSS_INGRESS_URL`
- `URANUS_CROSS_INGRESS_URL`
- `CROSS_OUTBOUND_WORKER_ENABLED`
- `CORS_ORIGIN`
- `ADMIN_API_KEY`

## Sequenza

1. Backup DB.
2. Caricare la release senza `.env` incluso nel repository.
3. Configurare env in Coolify.
4. Eseguire localmente/CI `npm test`, `npm run db:plan`, `npm run deploy:preflight:production`.
5. Deploy. Il container applica `npm run db:migrate` prima di avviare `api-server.js`.
6. Controllare healthcheck.
7. Eseguire `npm run db:verify`.
8. Eseguire `npm run deploy:preflight:integrations`.
9. Eseguire smoke DIRECT/Gift/URANUS con wallet controllati.
10. Verificare i receiver ROG/URANUS del protocollo RHA.
11. Impostare `CROSS_OUTBOUND_WORKER_ENABLED=1` soltanto dopo il punto 10.

## Nota ROG_TO_PHARAOH

Non configurare un sender ROG→PHARAOH verso `/api/cross/donation/entrata`: questa release accetta soltanto origine HMAC `URANUS`.

## Recovery 4 settembre — stato schema ENTRATA

Il piano corrente contiene **14 migration**, fino a `0014_rog_rha_registration_evidence`.

Prima del deploy verificare in particolare:

- `npm run db:plan` -> `MIGRATION_PLAN_OK: 14`;
- `npm run test:entry-rollover` -> PASS;
- nessuna variabile `PHARAOH_ENTRY_RESERVE_WALLET`: il riporto da 100 resta nella Cassa PHARAOH;
- se `0012` segnala `0012_ENTRY_ROLLOVER_RECONCILIATION_REQUIRED`, fermare il deploy e riconciliare gli eventuali stati legacy `RISERVA_ENTRATA` prima di riprovare;
- verificare `0013_pharaoh_treasury_registry_v3` + `0014_rog_rha_registration_evidence` e poi `npm run deploy:preflight:integrations`, che controlla CONTRACT_ID/versione, parent ROG, Cassa PHARAOH e BACKEND_ROLE in sola lettura. Il Registry PHARAOH non dipende da UranusRegistry.

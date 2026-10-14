# PHARAOH V4 — DEPLOYMENT CHECKLIST

## Pacchetto
- [ ] Verificare SHA-256 dello ZIP corretto e `SHA256_MANIFEST.txt`.
- [ ] `Dockerfile`, `package.json`, `api-server.js`, `release-state.json` sono alla radice del repository.
- [ ] Nessun `.env` reale o chiave privata nel repository.

## Database
- [ ] Backup/snapshot PostgreSQL corrente completato.
- [ ] NON resettare il database esistente.
- [ ] Piano migrazioni = 28; nessuna migration 0029.
- [ ] Migrazioni storiche, inclusa `0013_pharaoh_treasury_registry_v3`, restano immutate come storia DB.

## Smart Contract V4 — da distribuire/verificare PRIMA del backend
- [ ] `CONTRACT_ID == PHARAOH_TREASURY_REGISTRY_V4`.
- [ ] `CONTRACT_VERSION == 4.0.0`.
- [ ] `parentDAO == ROG_CONTRACT_ADDRESS`.
- [ ] `pharaohTreasury == PHARAOH_TREASURY_WALLET`.
- [ ] `projectsTreasury == PHARAOH_PROJECTS_WALLET`.
- [ ] PHARAOH / PROJECTS / ROG / URANUS treasury tutte distinte.
- [ ] BACKEND_ROLE presente sul signer `PHARAOH_REGISTRY_PRIVATE_KEY`.
- [ ] Registry non paused, emergency mode off, circuit breaker off.

## Cassa PROGETTI
- [ ] `PHARAOH_PROJECTS_WALLET=0x7Efb00d35Db624aDe83781B3eF0b67A74e49275c` salvo decisione formale diversa.
- [ ] Default `PHARAOH_PROJECTS_SIGNING_MODE=MANUAL`.
- [ ] Se `AUTOMATIC`, la chiave deve appartenere realmente al wallet PROJECTS.
- [ ] Verificare `PROJECTS:STRUCTURAL_CAPITAL` = 100 USDC prima di abilitare uscite PROJECTS.
- [ ] Massimo applicativo singola uscita PROJECTS = 50.000 USDC.

## Coolify env
- [ ] `NODE_ENV=production`.
- [ ] `DATABASE_URL` corretto.
- [ ] `POLYGON_CHAIN_ID=137`.
- [ ] Circle native USDC Polygon configurato per PHARAOH e ROG.
- [ ] `PHARAOH_TREASURY_WALLET`, `PHARAOH_GEMELLI_WALLET`, `PHARAOH_PROJECTS_WALLET` corretti.
- [ ] Signing mode GEMELLI/PROJECTS corretti.
- [ ] `PHARAOH_PAYOUT_PRIVATE_KEY` corrisponde alla Cassa PHARAOH.
- [ ] `PHARAOH_REGISTRY_PRIVATE_KEY` corrisponde al backend signer con BACKEND_ROLE.
- [ ] ROG API/contract/treasury/USDC corretti.
- [ ] `ROG_REQUIRED_DONATION_USDC=2`.
- [ ] Cross ingress URLs HTTPS e secrets >=32 byte.
- [ ] `CORS_ORIGIN` non wildcard.
- [ ] `ADMIN_API_KEY` casuale >=32 byte.

## Pipeline automatica del Dockerfile
Build:
`release gate -> static preflight`

Startup:
`release gate -> production preflight -> read-only integration preflight -> db:migrate -> api-server`

Qualunque incoerenza blocca l'avvio prima dell'API.

## Test locali prima del push
- [ ] `sh ops/certify-deployable-package.sh` = PASS.
- [ ] `npm test` = 52/52 PASS.
- [ ] Docker build = PASS.

## DIRECT
- [ ] 1 nuova donazione ROG -> 1 nuova HUMAN ROG -> 1 posizione PHARAOH.
- [ ] 2 USDC ROG esatti + `registerDonation` + COMPLETED.
- [ ] 100 USDC PHARAOH esatti.
- [ ] Registry V4 registra EXTERNAL -> PHARAOH con `rogRef` unica.

## Carta Regalo / Cross / RHA
- [ ] Carta Regalo conserva payer/beneficiary e registra incoming su Registry V4.
- [ ] URANUS -> PHARAOH resta backend-driven; nessuna dipendenza UranusRegistry.
- [ ] RHA outgoing verso ROG/URANUS resta registrato come uscita Cassa PHARAOH su Registry V4.

## Dopo deploy
- [ ] `/api/health` = 200.
- [ ] `npm run db:verify` = PASS.
- [ ] Verificare log preflight V4 e nessun errore Registry/DB.
- [ ] Eseguire smoke controllato senza bypassare Community/ROG/Registry.

## STOP CONDITIONS
STOP se: hash differente, Registry non V4, parent/treasury/role errati, DB non preservato, Projects structural capital incoerente, production/integration preflight fallito, chiave signer non corrispondente.

# PHARAOH BACKEND V4 — CERTIFICAZIONE FINALE DEPLOYABLE

Release aggiornata il 13 ottobre 2026 per rimuovere il blocco di rilascio obsoleto senza alterare la logica economica PHARAOH/ROG.

## Runtime
- Registry atteso: `PHARAOH_TREASURY_REGISTRY_V4`
- Versione Registry: `4.0.0`
- Migrazioni: 28; nessuna 0029; storico preservato
- DIRECT: 1 nuova donazione ROG -> 1 nuova HUMAN -> 1 posizione PHARAOH
- Cassa PROGETTI: wallet distinto, firma separata, 100 USDC strutturali, massimo applicativo 50.000 USDC per uscita

## Release gate
Il gate non e stato rimosso: e stato trasformato in controllo fail-closed della release. Non esiste override via env. Un package non marcato deployable, non V4, con test non 52/52 o con stato migrazioni incoerente viene bloccato.

## Docker/Coolify
Build: release gate + preflight statico.
Startup: release gate -> preflight produzione -> preflight integrazioni read-only -> migrazioni idempotenti -> API.

## Sicurezza operativa
Le chiavi private non sono incluse. Il database esistente non deve essere resettato. Prima dell'attivazione ISA deve avere backup/snapshot e configurare le env reali.

## Ambito della certificazione
La suite locale certifica sorgente, unit/mock/forensic e wiring. Le verifiche live di Polygon, Registry, ROG, URL cross e configurazione produzione sono eseguite dai preflight al deploy. Nessun deploy di produzione e nessun trasferimento reale e stato eseguito nella preparazione del pacchetto.

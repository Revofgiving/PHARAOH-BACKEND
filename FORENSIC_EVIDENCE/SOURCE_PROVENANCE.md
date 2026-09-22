# Source provenance

## Baseline PHARAOH

Baseline Sept3 dichiarata dai documenti di handoff:

`PHARAOH_BACKEND_3SETTEMBRE_DIRECT_CARTA_REGALO_MERGED_DEPLOY.zip`

SHA-256 dichiarato: `fb218bb1eb1f37be92850fcc95fc1c4b7a6288a7a44d7bd99dfe1add96e9f0d9`

**Limite di chain-of-custody:** lo ZIP Sept3 non era materializzato come file nel filesystem del runtime; erano disponibili i sorgenti scompattati indicizzati. Non si dichiara quindi una verifica indipendente byte-for-byte di quel checksum.

Per ricostruire un albero deployabile è stato usato come scheletro storico materializzato:

`PHARAOH_BACKEND_COOLIFY_DEPLOY.zip`  
SHA-256 `405e3abc1e3a91f7ac0c0f28717344a15883df4b9a7e064ac8333a6ca60735ba`

Su tale albero sono stati reintegrati i sorgenti Sept3 effettivamente ispezionati (DIRECT/Gift/Registry/ROG managers/verifier) e sono state applicate le modifiche nuove URANUS/RHA.

## ROG read-only

`ROG_BACKEND_20260831_USDC_LISTENER_TIMEOUT_NOBLOCK_V5.zip`  
SHA-256 `b9cf9bc8fab3764aa7eb261e05087c8249a24e76bd0ca90705c8c30f9b4b7017`

ROG non modificato.

## URANUS read-only

`SUPERURANUS_BACKEND_PATCH_CARTA_REGALO_DEFINITIVA_02_SETTEMBRE_2026.zip`  
SHA-256 `6b73f54f564cf79bf715e550a32c3c53a20aedcc0485e36c3d33e9d6588f791e`

Il pacchetto materializzato contiene solo patch/README Carta Regalo URANUS, non il backend URANUS completo e non un receiver cross. Il README conferma la semantica 20 USDC per posizione URANUS, coerente con 200 USDC = 10 posizioni, ma non consente un test E2E del receiver RHA.

URANUS non modificato.

## Migrazioni 0002/0003

Gli esatti file SQL Sept3 non erano materializzati. Sono stati ricostruiti in forma semanticamente compatibile con i sorgenti e le prove indicizzate. Per non produrre falso drift su un DB che abbia già applicato la release Sept3, `ops/db-migrate.js` accetta esclusivamente come checksum *già applicati*:

- 0002 legacy: `8228812230a6e84b51a492c5f850cb2b0b7015073501475de1812ab86bd4f003`
- 0003 legacy: `e14f0b7b69f98885375c3479f6841a4aef5796e7c7058650edd6d9560e48413a`

Una nuova installazione usa e registra i checksum correnti presenti nel manifest.

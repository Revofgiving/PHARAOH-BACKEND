# PHARAOH BACKEND - Gift Dynamic Final - 18 settembre 2026

Modifiche principali:
- Carta Regalo PHARAOH creata con solo wallet pagatore; beneficiario inizialmente NULL.
- Beneficiario e importo ROG vengono letti e verificati server-side dal gift ROG reale.
- Endpoint `POST /api/gift/:giftId/rog/external/verify` per verificare ritorno ROG esterno.
- Importo ROG Gift dinamico: minimo 2 USDC, intero, multiplo di 2.
- Numero HUMAN atteso = importo ROG / 2, tutte al beneficiario.
- RGX attesi = importo ROG / 2, attribuiti al pagatore.
- Importo PHARAOH resta esattamente 100 USDC e genera una posizione PHARAOH al beneficiario.
- Flusso DIRECT invariato: ROG resta esattamente 2 USDC per ogni posizione PHARAOH.
- Migration 0016: beneficiary_wallet nullable fino alla verifica ROG.
- Migration 0017: rog_amount_usdc nullable prima di ROG, poi >=2 e multiplo intero di 2.

Verifiche eseguite nel workspace di build:
- checksum di tutte le 17 migration coerenti con migration-plan.json;
- test statico DIRECT/GIFT: PASS;
- syntax check Node dei file modificati: PASS.

Nota ambiente build: la suite dinamica completa richiede le dipendenze npm installate. Nel container di packaging le dipendenze non erano disponibili integralmente, quindi non viene dichiarato un nuovo `FINAL_TESTS=PASS (17 suites)` per questa ricostruzione.

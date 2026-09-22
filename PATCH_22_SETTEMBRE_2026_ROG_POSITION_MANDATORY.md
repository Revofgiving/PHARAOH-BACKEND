# PHARAOH — PATCH 22 SETTEMBRE 2026 — ROG POSITION MANDATORY

## Regola
Ogni nuova posizione PHARAOH DIRECT richiede obbligatoriamente una NUOVA posizione HUMAN ROG, creata per la stessa nuova sessione PHARAOH.

## Gate
PHARAOH resta bloccato finche non sono presenti contemporaneamente:
- pagamento ROG 2 USDC verificato on-chain;
- registerDonation verificata on-chain;
- donationId ROG;
- fulfillment ROG = COMPLETED;
- rog_human_position > 0;
- posizione ROG verificata sul backend ROG per lo stesso wallet.

## Anti-replay
- tx ROG e registerDonation precedenti alla nuova sessione PHARAOH vengono rifiutate (tolleranza clock 120s);
- rog_human_position e univoca tra le sessioni DIRECT tramite migration 0020;
- wallet normalizzati lowercase;
- localStorage e solo cache client: lo stato backend e autorevole e sessioni concluse/cancellate vengono eliminate dal client.

## Redirect
PHARAOH apre `https://revolutionofgiving.eth.limo/progetti-new.html` con `source`, `sessionRef`, `returnUrl` e ancora `#economia-del-dono`, mostrando all'utente il percorso verso `SEND GIFT`.

## Smart contract
Nessuna modifica agli smart contract PHARAOH.

## Hotfix compatibilita migrazioni produzione 22 settembre 2026

Il database di produzione contiene gia `0019_direct_rog_position_recovery` applicata il 21 settembre 2026 con checksum storico `86a670e94f01a3ae2fbbd48156dc1ac36f73c520d48e22d79a46d49d62c12f1f`.

Per preservare la storia immutabile del database:
- `0019_direct_rog_position_recovery` e riconosciuta nel migration plan tramite `acceptedAppliedSha256`;
- la nuova migration che rende `rog_human_position` univoca e stata rinumerata in `0020_direct_rog_position_mandatory`;
- nessuna migration gia applicata in produzione viene cancellata o riscritta.

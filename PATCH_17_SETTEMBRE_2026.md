# PHARAOH BACKEND — PATCH 17 SETTEMBRE 2026

Release: `PHARAOH_BACKEND_20260917_ROG_EXTERNAL_VERIFY_GATE_V1_0016_DEPLOY_CANDIDATE`

## Scopo

Allineare il flusso DIRECT alla nuova coreografia PHARAOH -> ROG -> PHARAOH. I 100 USDC PHARAOH non sono piu sbloccati dal solo Transfer di 2 USDC ROG: serve una nuova donazione ROG completata con posizione HUMAN reale e verificata server-side.

## Modifiche

- Nuova rotta `POST /api/donazione/diretta/rog/external/verify`.
- Verifica server-side di `rogUsdcTxHash`, `rogRegisterTxHash` e `rogDonationId`; il valore `rogPosition` del browser e solo un hint e viene confrontato con il dato autorevole salvato dal backend.
- `recordRogFulfillmentCompleted()` rifiuta `COMPLETED` se ROG non restituisce una posizione HUMAN positiva appartenente allo stesso wallet.
- `assertReadyForPharaoh()` richiede `rog_fulfillment_status = COMPLETED`, prove ROG complete e `rog_human_position > 0` prima dei 100 USDC PHARAOH.
- Nessuna nuova colonna DB: la patch usa campi introdotti dalla migrazione `0015_direct_rog_async_gate`.

## Input rotta external/verify

```json
{
  "wallet": "0x...",
  "sessionRef": "0x...",
  "rogUsdcTxHash": "0x...",
  "rogRegisterTxHash": "0x...",
  "rogDonationId": "123",
  "rogPosition": 456
}
```

`rogPosition` e opzionale e non e mai usato come prova autorevole.

## Correzione finale test forensi

I test legacy DIRECT sono stati riallineati alla nuova regola: la sola conferma dei 2 USDC ROG non autorizza il pagamento PHARAOH. Il gate dei 100 USDC richiede `rog_fulfillment_status = COMPLETED`, prova ROG completa e `rog_human_position > 0`. Il test dinamico verifica esplicitamente che `ROG_PAYMENT_CONFIRMED` da solo venga rifiutato da `assertReadyForPharaoh()`.

Release candidate finale: `PHARAOH_BACKEND_20260917_ROG_EXTERNAL_VERIFY_GATE_V2_0016_DEPLOY_CANDIDATE`.

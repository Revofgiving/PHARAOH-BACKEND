# PHARAOH — Protocollo cross-platform

## Firma HMAC

`signature = HMAC_SHA256(secret, canonical_json(body))`

`canonical_json` ordina ricorsivamente le chiavi degli oggetti e mantiene l'ordine degli array. Digest: hex lowercase 64 caratteri.

Header:

- `X-Platform-Origin: <ORIGIN>`
- `X-Platform-Signature: <hex>`

Il receiver deve confrontare la firma in constant time e applicare idempotenza su `event_key` e `payment_tx_hash`.

Segreti condivisi: `URANUS_CROSS_PLATFORM_SECRET` e usato tra PHARAOH e URANUS; `ROG_CROSS_PLATFORM_SECRET` tra PHARAOH e ROG. Se assenti, entrambi ricadono su `CROSS_PLATFORM_SECRET`. Il nome identifica il peer con cui il segreto e condiviso, anche quando l'header `X-Platform-Origin` e `PHARAOH`.

## URANUS → PHARAOH

Endpoint PHARAOH:

`POST /api/cross/donation/entrata`

Header richiesto:

`X-Platform-Origin: URANUS`

Body canonico supportato:

```json
{
  "event_key": "URANUS:...",
  "origine": "URANUS",
  "wallet_origine": "0x<CASSA_URANUS>",
  "wallet_beneficiario": "0x<UTENTE_URANUS>",
  "wallet_cassa": "0x<CASSA_PHARAOH>",
  "importo_totale": 200,
  "num_ingressi": 2,
  "payment_tx_hash": "0x<64hex>"
}
```

PHARAOH verifica indipendentemente Polygon, Circle USDC, sender, recipient, importo, conferme, tx anti-replay ed evento anti-replay. `num_ingressi` deve essere `importo_totale / 100`.

**ROG non è accettato da questo endpoint in questa release.**

## PHARAOH → ROG dopo uscita RHA

Sequenza obbligatoria e recuperabile:

1. Cassa PHARAOH trasferisce l'importo esatto alla Cassa ROG.
2. Il payout viene ancorato al PharaohRegistry.
3. La **stessa Cassa PHARAOH** firma `ROG.registerDonation(importo)`; nonce, tx hash, donationId e receipt vengono persistiti.
4. Solo dopo PHARAOH invia il payload HMAC a ROG.
5. ROG verifica indipendentemente Transfer e `DonationRegistered`, poi esegue `completeDonation()`.
6. RGx restano alla Cassa PHARAOH; HUMAN/posizioni SMALL vanno al ricevente RHA; PILETTE restano tecniche ROG.

Body inviato dal backend PHARAOH:

```json
{
  "event_key": "<RHA_EVENT>:PHARAOH_TO_ROG",
  "origine": "PHARAOH",
  "wallet_origine": "0x<CASSA_PHARAOH>",
  "wallet_beneficiario": "0x<UTENTE_USCITO_RHA>",
  "wallet_cassa": "0x<CASSA_ROG>",
  "importo_totale": 300,
  "num_ingressi": 150,
  "payment_tx_hash": "0x<64hex>",
  "protocol_version": "RHA_300_ROG_200_URANUS_V2",
  "register_tx_hash": "0x<64hex>",
  "donation_id": "<uint256>"
}
```

Il receiver ROG deve creare **150 HUMAN + 150 PILETTE SMALL**: HUMAN a `wallet_beneficiario`, non alla Cassa PHARAOH. Gli **150 RGx** appartengono invece alla Cassa PHARAOH che ha firmato `registerDonation()`.

## PHARAOH → URANUS dopo uscita RHA

```json
{
  "event_key": "<RHA_EVENT>:PHARAOH_TO_URANUS",
  "origine": "PHARAOH",
  "wallet_origine": "0x<CASSA_PHARAOH>",
  "wallet_beneficiario": "0x<UTENTE_USCITO_RHA>",
  "wallet_cassa": "0x<CASSA_URANUS>",
  "importo_totale": 200,
  "num_ingressi": 10,
  "payment_tx_hash": "0x<64hex>"
}
```

Il receiver URANUS deve creare **10 posizioni dual CASSA URANUS + HUMAN** per `wallet_beneficiario`.

## Idempotenza e recovery

Il sender PHARAOH non reinvia fondi quando la notifica remota fallisce. Stati principali:

- `PENDING`
- `TRANSFER_SUBMITTING`
- `FUNDS_CONFIRMED`
- `NOTIFY_PENDING`
- `COMPLETED`
- `RECONCILIATION_REQUIRED`

Se `payment_tx_hash` esiste, il retry verifica quella tx e prosegue. Per il target ROG vale la stessa regola anche per `rog_register_tx_hash`: il backend non invia una seconda `registerDonation()` se conosce gia la tx. Se e stato riservato un nonce (payout o register ROG) ma la relativa tx hash non e stata persistita, l'operazione entra in `RECONCILIATION_REQUIRED` e richiede associazione manuale della tx prima di proseguire.

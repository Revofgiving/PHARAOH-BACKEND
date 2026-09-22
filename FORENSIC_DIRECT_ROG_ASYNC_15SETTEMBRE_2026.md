# PHARAOH DIRECT — Gate ROG asincrono e non bloccante

Data: 15 settembre 2026

## Regola approvata

Per il DIRECT PHARAOH il solo gate economico che abilita il pagamento dei 100 USDC PHARAOH e' la verifica on-chain di un trasferimento di esattamente 2 USDC dal wallet del donatore alla Cassa ROG, con receipt riuscita e conferme richieste.

La successiva elaborazione ROG non puo' bloccare il donatore:

- `registerDonation()` resta invariata e lo smart contract ROG NON viene modificato;
- il mint RGx, la creazione della posizione HUMAN e ogni lavorazione backend ROG proseguono in modo asincrono;
- il worker PHARAOH persiste e ritenta il fulfillment ROG senza richiedere un secondo pagamento;
- la chiave economica e' il txHash dei 2 USDC realmente verificato verso la Cassa ROG;
- il tasto RIPRENDI IL DONO resta recovery eccezionale, non percorso normale.

## Una sola conferma wallet ROG

Il frontend usa `wallet_sendCalls` EIP-5792 con `atomicRequired=true` per inserire nella stessa autorizzazione wallet:

1. transfer di 2 USDC alla Cassa ROG;
2. `registerDonation(2)` sul contratto ROG esistente.

Il batch id viene salvato immediatamente nel checkpoint locale. Se il browser mobile viene sospeso dopo l'invio, il recovery interroga lo stesso batch e non genera un nuovo transfer.

Se il wallet dichiara esplicitamente di non supportare il batch atomico, il percorso normale fallisce prima di inviare fondi: non viene effettuato un fallback automatico che possa creare una seconda donazione. Le vecchie sessioni gia' pagate mantengono invece un percorso di recovery separato per completare la `registerDonation()` mancante.

## Gate e fulfillment separati

Stato economico DIRECT:

`COMMUNITY_CONFIRMED -> ROG_PAYMENT_CONFIRMED -> PHARAOH_VERIFIED -> ... -> POSITION_ASSIGNED`

Stato fulfillment ROG parallelo:

`WAITING_PAYMENT -> WAITING_REGISTRATION -> REGISTERED -> PROCESSING -> COMPLETED`

In caso di errore temporaneo:

`PROCESSING/REGISTERED -> RETRY -> ...`

Il conteggio retry e l'ultimo errore sono audit tecnico backend. Non sono criteri economici e non sono mostrati al donatore.

## Recovery durevole della registerDonation

Quando il batch wallet fornisce gia' tx hash e donationId tecnico della `registerDonation`, PHARAOH li salva come candidate insieme alla conferma del pagamento. La risposta del gate non attende la verifica della registrazione.

Il worker separato:

1. verifica la candidate on-chain;
2. la promuove a registrazione ROG verificata;
3. chiama il backend ROG per il completamento;
4. persiste solo la posizione HUMAN dell'utente.

Se il processo PHARAOH si riavvia fra uno step e il successivo, le candidate e lo stato retry restano nel database.

## Visualizzazione finale

La schermata di successo PHARAOH mostra:

- posizione PHARAOH;
- `Posizione ROG SMALL #<numero HUMAN>` appena disponibile;
- fino a quel momento: `Posizione ROG in assegnazione automatica`.

La PILETTA non viene mai esposta nella sessione pubblica e non viene mai mostrata dal frontend.

## File backend modificati

- `database/0015_direct_rog_async_gate.sql`
- `database/migration-plan.json`
- `direct-donation-session-manager.js`
- `direct-donation-manager.js`
- `rog-donation-manager.js`
- `api-server.js`
- `donation-flow-manager.js`
- `.env.example`
- test DIRECT/migration aggiornati

## Validazioni eseguite in questo ambiente

- `node --check` sui file runtime modificati: PASS;
- test statico DIRECT/GIFT: PASS;
- test checksum/migration plan con 15 migration: PASS.

Non e' stato possibile eseguire `npm ci` completo nell'ambiente di lavoro per timeout del registry; prima del deploy reale eseguire `npm ci`, `npm test`, migration/preflight e smoke su Coolify.

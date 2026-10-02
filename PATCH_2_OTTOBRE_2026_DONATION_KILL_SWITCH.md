# PHARAOH — Donation Kill Switch — 2 ottobre 2026

## Obiettivo
Aggiungere un controllo amministrativo dedicato che blocchi soltanto i nuovi flussi di donazione, senza spegnere Area Personale, consultazioni, contenuti pubblici o pannello admin.

## Stato persistente
Chiave `state_persistence`: `donazioni_blocco`.

Valore attivo:
```json
{"bloccate":true,"motivo":"...","timestamp":"..."}
```

Il valore resta valido anche dopo restart/redeploy del container finché non viene riattivato esplicitamente.

## API admin
- `GET /api/admin/donazioni/stato`
- `POST /api/admin/donazioni/blocca`
- `POST /api/admin/donazioni/riattiva`

Tutte richiedono `X-Admin-Key`.

## API pubblica di sola lettura
- `GET /api/donazioni/stato`

Serve al frontend per mostrare lo stato senza avviare un flusso di pagamento.

## Flussi bloccati
Quando `bloccate=true`, le nuove richieste ricevono HTTP 503 con `code=DONATIONS_BLOCKED`:
- apertura sessione DIRECT;
- passaggi ROG della sessione DIRECT;
- conferma pagamento PHARAOH DIRECT;
- creazione e pagamento Carta Regalo;
- ingresso cross URANUS -> PHARAOH;
- route legacy/admin che processano un nuovo dono Entrata/PHARAOH.

## Flussi NON bloccati
- Area Personale e API account in sola lettura;
- dashboard e pannello admin;
- contenuti, eventi, risorse, comunicazioni;
- operazioni amministrative di recovery/reconciliation già esistenti;
- payout/outbound già dovuti da operazioni precedentemente confermate.

## Nota operativa
Il pulsante impedisce nuove richieste che arrivano dopo l'attivazione. Una transazione blockchain già firmata/inviata o una richiesta già entrata nella sua sezione critica prima del blocco non può essere annullata retroattivamente dal backend.

## Verifiche eseguite
- `node --check api-server.js`: PASS
- `node --check db-manager.js`: PASS
- `node scripts/test-donation-kill-switch-static.js`: PASS

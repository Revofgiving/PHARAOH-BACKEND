# PHARAOH - CHECKPOINT FORENSE TRATTENUTA RHA DA 5 USDC

**Stato: NON DEPLOY.** Copia derivata dall'archivio GitHub del 22 ottobre 2026. Nessun intervento su database o servizi reali.

## Implementato nella copia isolata

- Regola `planExitNet`: su uscita RHA primaria (PRIMARIO/FONDO) con ricevente non PILETTA, 6000 USDC lordi diventano 5995 USDC al beneficiario e 5 USDC al fondo gas.
- Separazione dei fondi all'interno della medesima allocazione contabile: bucket `EXIT:<hash>:NET` e `EXIT:<hash>:GAS_RESERVE` con purpose `GAS_RESERVE_PENDING`. Nessun trasferimento a un wallet differente.
- `donation-flow-manager.js` genera la richiesta di pagamento da 5995 e registra i dettagli della commissione. Il controllo di quadratura interrompe la transazione se l'importo lordo non corrisponde.
- Non sono modificati doni RHA secondari da 1000, THOT, ISIDE o reinvestimenti PILETTA. Una nuova uscita RHA primaria può generare una nuova quota da 5, senza utilizzare un flag globale per wallet.

## Verifiche effettuate

- `test-rha-gas-reserve-policy.js`: PASS
- `test-confirmed-economics.js`: 23 PASS
- `test-economic-progression-runtime.js`: 19 scenari PASS
- `test-funded-multiturn-model.js`: 63 scenari PASS, bilanci aggiornati e quadrati
- Suite completa: **50 PASS, 0 FAIL, 4 BLOCKED_DEPENDENCY, 0 TIMEOUT**. Non certificata al 100%.

## BLOCCANTI PRIMA DEL DEPLOY

1. Il bucket di 5 USDC viene creato come `GAS_RESERVE_PENDING` nella ripartizione, NON è ancora promosso a saldo disponibile dopo conferma reale del pagamento. È necessario riconciliare invio, conferma, fallimento, scadenza e retry, senza riclassificare quote non pagate.
2. La sezione admin 'Riserva commissioni per transazione', i totali disponibili/vincolati, lo storico conversioni, il controllo on-chain degli swap USDC/POL e le autorizzazioni amministrative **NON SONO IMPLEMENTATI**.
3. Manca il collegamento con il frontend amministrativo ed è da verificare la visualizzazione del netto nelle altre UI.
4. I test PostgreSQL reali, gli E2E e il confronto con il codice effettivo Coolify non sono stati eseguiti.
5. Suite completa bloccata da quattro dipendenze ambientali mancanti: non dichiarare pronto al deploy.
6. Necessario test storico: payout creati prima della patch, pending e con transazioni firmate. La patch va attivata solo dopo definizione di politica di cutover esplicita.

## Prossimo intervento

Implementare il ciclo di vita della riserva collegato al pagamento, poi migrazione append-only per conversioni, endpoint admin protetti e riconciliazione on-chain. Dopo test PostgreSQL e prova staging produrre ZIP DEPLOY dedicato, senza usare questo checkpoint.

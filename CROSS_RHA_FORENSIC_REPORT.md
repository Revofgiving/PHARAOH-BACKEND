# PHARAOH — Report forense URANUS / RHA / cleanup legacy

## 1. DIRECT exact 100

**REQUISITO →** 2 USDC ROG + 100 USDC PHARAOH = 1 posizione; nuova posizione = nuovo ciclo.  
**STATO REALE DEL CODICE →** `direct-donation-session-manager.js` fissa 2; `donation-flow-manager.js` passa `maxPosizioni: 1` e rifiuta tutto ciò che non è 100/1. Registry mantenuto.  
**PROVA FORENSE →** suite statica + dinamica; il verifier accetta 100, rifiuta 200 con max=1 e rifiuta 150.  
**RISCHIO →** bypass via endpoint diretto.  
**MODIFICA PROPOSTA/APPLICATA →** `sessionRef` obbligatorio e gate Community+ROG ricontrollato server-side.

## 2. URANUS_TO_PHARAOH

**REQUISITO →** Cassa URANUS paga, utente URANUS riceve N posizioni; niente deduzione del beneficiario dalla Cassa.  
**STATO REALE DEL CODICE →** receiver dedicato `cross-entry-manager.js`, unico source ammesso `URANUS_TO_PHARAOH`.  
**PROVA FORENSE →** HMAC negativo/positivo, treasury binding, multipli 100, mapping beneficiario separato, tx/event uniqueness e verifier on-chain.  
**RISCHIO →** evento falso o replay potrebbe creare posizioni senza devoluzione reale.  
**MODIFICA PROPOSTA/APPLICATA →** HMAC, `event_key`, tx hash univoca, proof Polygon/Circle USDC, lock e commit atomico posizioni+donazione+evento.

## 3. PHARAOH→ROG / PHARAOH→URANUS all'uscita RHA

**REQUISITO →** 300 USDC→ROG/150 dual e 200 USDC→URANUS/10 dual, sempre a nome dell'utente uscito da RHA.  
**STATO REALE DEL CODICE →** l'uscita RHA crea due `cross_outbound_operations` atomiche con il beneficiario del turno.  
**PROVA FORENSE →** test statici sulle due specifiche e test dinamico di proof Transfer + payload HMAC con beneficiario separato.  
**RISCHIO →** collisione nonce tra payout e cross, doppio invio dopo timeout, fondi inviati ma receiver non notificato.  
**MODIFICA PROPOSTA/APPLICATA →** lock globale `PHARAOH:PAYOUT:SIGNER`; stato durevole; guard applicativa e CHECK DB versionato su 300/150 ROG e 200/10 URANUS; verifica `receipt.from = Cassa PHARAOH`; no-retry-funds dopo tx nota; `NOTIFY_PENDING`; `RECONCILIATION_REQUIRED` se nonce riservato ma tx hash ignota.

## 4. Rimozione definitiva Crediti / Dono al Volo

**REQUISITO →** non deve esistere alcun Dono a Credito o Dono al Volo, inclusi omaggi staff. I 500 USDC RHA correnti restano interamente 300 ROG + 200 URANUS.  
**STATO REALE DEL CODICE →** nessuna funzione runtime crea/distribuisce crediti; i contenitori 5.1 e 5.3 non esistono più nel runtime; gli endpoint lista d'attesa/assegnazione sono rimossi; `rha_exit_allocations` non espone più campi `staff_omaggi_*`.  
**PROVA FORENSE →** `scripts/test-no-credit-no-dono-al-volo.js` verifica l'assenza dei simboli runtime e la presenza delle migration `0008`/`0009`; il piano migration è di 9 step con checksum validi.  
**RISCHIO →** le migration storiche `0001`, `0004` e `0005` contengono ancora terminologia legacy perché non possono essere riscritte senza checksum drift.  
**MODIFICA PROPOSTA/APPLICATA →** `0008_remove_doni_credito` elimina tabella/colonna/tipi credito e 5.3; `0009_remove_dono_al_volo_staff_legacy` elimina 5.1, lista d'attesa e campi omaggi staff. Lo schema effettivo post-migrazione non conserva tali funzioni.

## 5. ROG_TO_PHARAOH

**REQUISITO →** non implementarlo adesso perché il lato ROG è rinviato.  
**STATO REALE DEL CODICE →** nessun gate HMAC `ROG` sul receiver cross.  
**PROVA FORENSE →** test/preflight falliscono se viene introdotto `crossAuth.verifyRequest(req, 'ROG')`.  
**RISCHIO →** abilitazione prematura di un protocollo senza trigger autorevole ROG.  
**MODIFICA PROPOSTA/APPLICATA →** flusso esplicitamente disabilitato in questa release.

## Verdetto

**PASS LOCALE/STATICO** per le modifiche implementate.  
**NON LIVE-CERTIFIED**: DB Coolify, USDC reali, receiver ROG/URANUS e mainnet smoke non sono stati eseguiti in questo runtime.

# Handoff corrente PHARAOH - 9 ottobre 2026

## Istruzione al prossimo agente

Proseguire l'implementazione reale SOLO dal BACKEND di questo pacchetto. Prima backend,
smart contract dopo. Non cambiare database: e' PostgreSQL su Coolify, stessa istanza e
stessi dati. Conservare wallet, account, posizioni, numeri e storico. Baseline dichiarata
5 ottobre. Non riaprire decisioni economiche gia' confermate. Non attivare una release
incompleta. Nessun workaround che imposti ACTIVE/H/P/saldi per far partire il server.

Leggere in ordine: 00_INIZIA_QUI.md, questo handoff, release-state.json, rapporto QA,
registro decisioni storico con ultime integrazioni del presente handoff, codice e log.
Il vecchio archivio e' un riferimento, non sostituisce il codice corrente.

## Nuove precisazioni utente

Utente dichiara 13 persone reali e zero Carte Regalo pendenti: non verificato da query.
Persone != wallet != account != posizioni. H conta materializzazioni HUMAN esterne.
La domanda ROG riguarda PHARAOH -> ROG dopo RHA, non apertura del receiver inbound.
Vuole npm/test al 100% e PostgreSQL/receiver reali. Non sono stati ancora ottenuti.

## Modifiche concrete di questa consegna

1. Origini canoniche URANUS_TO_PHARAOH/ROG_TO_PHARAOH uniformate in flusso, hold e
materializzatore. Prima il collegamento reale URANUS era respinto. Alias canonico/corto
non duplicano fondi, radici o H. ROG inbound resta deliberatamente chiuso.
2. Notifiche outbound: COMPLETED obbligatorio anche per URANUS, controlli dei campi
presenti, timeout, no redirect, rete ritentabile senza secondo pagamento. Verificare
compatibilita della risposta del receiver reale, non assumere che il modello sia il peer.
3. Runner migrazioni: 0016/17/18 avevano BEGIN/COMMIT propri. Solo i tre hash noti vengono
normalizzati nella proiezione executionSql; SQL e checksum originali immutati. Usare
executionSql nei rehearsal e nel runner. Non eliminare questa protezione.
4. Modello economico finanziato 10 RHA / 3 THOT / 1 ISIDE, loopback HTTP reale del sender
con peer modello, assessment inventory e suite PostgreSQL/runner QA isolato aggiunti.

## Prove e limiti

50 suite: 47 PASS, 0 FAIL, 3 BLOCKED_DEPENDENCY, npm test exit 1. Sintassi116/116.
31 file protetti identici all'input; 27SQL/piano/lock/ABI invariati. Zero nuove migrazioni.
Ethers/dotenv bloccano gli stessi tre test; pg e altre dipendenze assenti (111 mancanti).
Online npm ci fallisce EAI_AGAIN, offline ENOTCACHED. Npm era gia' installato10.9.2.
Non usare ethers6.16 dello ZIP smart-contract al posto del lock6.17 per dichiarare PASS.
Nessun PostgreSQL/Docker disponibile: tentativi nativi bloccati prima di connessione.
La copia selettiva per QA e' testata; runner Docker non eseguito end-to-end.

Modello monetario: 68.100 entrati =57.000 usciti +11.100 riservati; 681HUMAN+65PILETTE,
13 wallet sintetici. Non e' la produzione. Placement/eredi e prove di saldo sono fixture,
non simulazione completa donation-flow-manager, PostgreSQL o riceventi effettivi.

## Lavoro ancora reale da completare

A. Adozione/versionamento classificazioni, H/P dimostrabili, riserve di apertura e
obbligazioni dallo stato esistente. Non nuovo DB, non replay dei primi sei doni.
B. Associazione delle CASSA storiche e operazioni post-commit, senza cambiare proprietari.
C. Coda persistente per lotto iniziale multi-ingresso oltre tavola1 prima di settlement.
D. Installare dipendenze esatte in ambiente con rete; eseguire runner QA nativo e risolvere
ogni eventuale errore SQL/concorrenza, non fermarsi ai test delle protezioni.
E. Full progression strutturale su clone isolato, receiver ROG/URANUS attuali completi,
backup/ripristino, config pubblica/commit e riconciliazione saldi/impegni prima del deploy.

ROG31agosto e patchURANUS2settembre non sono i receiver completi correnti. Non inventare
postcondizioni certificate. Contratto, ABI e massimale50000 sono fase successiva.
Non chiedere nuovamente se i rientri devono appartenere al ricevente: NO, decisione chiusa.

## Continuita del pacchetto

Il BACKEND corrente e' completo nei sorgenti, non nei lavori residui. Input runtime8ottobre
conservato come ZIP e contenente a sua volta handoff/114baseline/decisioni precedenti.
Registro38decisioni copiato per lettura diretta. Vecchi rapporti e manifest dentroBACKEND
sono storici; il manifest corrente e' solo MANIFEST_SHA256.txt alla radice del pacchetto.
Questo ZIP e' sufficiente per recuperare il lavoro disponibile, non per inventare
accessi/evidenze operative di produzione che non sono mai stati forniti.

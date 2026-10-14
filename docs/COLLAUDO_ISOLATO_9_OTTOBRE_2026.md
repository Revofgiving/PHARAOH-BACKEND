> **NOTA STORICA — SUPERATO.** Questo documento descrive un checkpoint precedente dell'8/9 ottobre 2026. Non rappresenta lo stato della release corrente. La release corrente e documentata in `00_DEPLOYABLE_RELEASE_README_13_OTTOBRE_2026.md` e governata da `release-state.json` + `ops/v4-release-gate.js`.

# Collaudo isolato PHARAOH - NON deploy - 9 ottobre 2026

## Comando host

Eseguire soltanto su un computer/host di test separato, con Node 22 o 24, npm,
Docker funzionante, shell POSIX, openssl e accesso ai registry npm/Docker.
Non eseguire nel container applicativo di produzione e non puntare al DB Coolify.
Non serve fornire DATABASE_URL, chiavi, seed, password reali o file .env.
Dalla directory BACKEND del pacchetto:

```sh
PHARAOH_QA_HOST_ACK=ISOLATED_TEST_HOST npm run test:isolated:host
```

Il comando usa una nuova directory di uscita `PHARAOH_QA_<id casuale>`, senza
sovrascrivere percorsi esistenti. Copia soltanto sorgenti permessi, registra gli hash,
installa il package-lock senza lifecycle scripts, crea una rete Docker interna,
un PostgreSQL temporaneo e i dati sintetici. Non modifica il backend sorgente.
Le risorse temporanee con nome casuale vengono rimosse; i log restano nella directory
di uscita con permessi restrittivi. Non vengono pubblicate porte PostgreSQL.

Default: node:22-bookworm-slim e postgres:16-bookworm. Sono immagini di prova, non
un'affermazione sulla versione Coolify. Gli ID/digest reali sono salvati. Per il
collaudo di compatibilita scegliere la stessa major PostgreSQL osservata nell'inventario
reale; questa versione non e' ancora nota. Il runner e' predisposto per il layout
dati delle immagini PostgreSQL 16/17. Altre immagini richiedono verifica del mount.

Variabili opzionali: PHARAOH_QA_NODE_IMAGE, PHARAOH_QA_PG_IMAGE, PHARAOH_QA_OUTPUT
(percorso nuovo). Non inserire URL applicative o credenziali di produzione.

## Esito interpretabile

`npm-ci.log`: installazione reale. `tests.json` e `unit.log`: tutte le suite.
`postgres-conservation.log`: schema e conservazione su dati sintetici, rollback.
`postgres-concurrency.log`: concorrenza PostgreSQL reale, schema privato temporaneo.
`qa-summary.json`: singoli exit code, allExecutedChecksPassed e deployable=false.
`image-digests.txt`, `QA_INPUT_MANIFEST.json`: identita delle immagini e sorgenti testati.

Se manca una dipendenza/immagine/permesso, l'esecuzione fallisce: non e' un PASS.
Un esito 0 non prova adozione della produzione, receiver reali, transazioni reali o
progressione strutturale completa. Questi richiedono prove ulteriori. Il comando non
rimuove il blocco di rilascio e non esegue `npm start` o `db:migrate` sulla produzione.
Il runner Docker NON e' stato provato integralmente in questa lavorazione.

## Inventario del DB esistente: fase distinta

Non confondere i dati sintetici del collaudo con i 13 utenti reali. L'utility
`ops/economic-cutover-inventory.js` legge solo colonne ammesse in transazione READ ONLY;
va usata con un ruolo di sola lettura in un contesto controllato. Non usa chiavi di
firma, non inizializza tabelle, non crea riserve. Il suo output non e' un backup.
Il successivo `ops/economic-cutover-assessment.js` opera offline senza connessione DB.

Esempio offline dopo aver ottenuto l'inventario in modo controllato:

```sh
node ops/economic-cutover-assessment.js inventory.json assessment-nuovo.json 13
```

L'output include dati operativi dei wallet/posizioni: condividere solo nel contesto
autorizzato del progetto. Non condividere dump non verificati, .env o segreti.
L'inventario e la dichiarazione dell'utente non autorizzano ad impostare H=13.

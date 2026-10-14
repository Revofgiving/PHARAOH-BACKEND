> **NOTA STORICA — SUPERATO.** Questo documento descrive un checkpoint precedente dell'8/9 ottobre 2026. Non rappresenta lo stato della release corrente. La release corrente e documentata in `00_DEPLOYABLE_RELEASE_README_13_OTTOBRE_2026.md` e governata da `release-state.json` + `ops/v4-release-gate.js`.

# Handoff corrente - implementazione runtime 8 ottobre 2026

## Istruzione prioritaria
Continuare lo sviluppo reale del BACKEND da questa directory. NON tornare ai
calcolatori isolati del checkpoint precedente. Prima backend, poi smart contract.
Preservare ogni dato/identita'/wallet/posizione/storia esistente. Non cambiare ABI,
Solidity o dati di produzione. NON distribuire questo checkpoint.

## Lettura iniziale
1. Leggere `release-state.json` e il rapporto `docs/RAPPORTO_INTEGRAZIONE_RUNTIME_8_OTTOBRE_2026.md`.
2. Leggere le 38 decisioni riportate in DOCUMENTAZIONE del pacchetto superiore:
sono confermate, non vanno riaperte. Ultima priorita': solo backend.
3. Leggere il sorgente corrente e i log `evidence/implementation-pass/final-run`.
4. Usare il patch rispetto all'input per capire cosa e' stato realmente modificato.

## Stato preciso
42 suite: 39 PASS/0 FAIL/3 dipendenze, npm test exit 1. Sintassi 102/102.
Due nuove migrazioni (26/27), NON eseguite contro PostgreSQL. 25 SQL originarie,
primi 25 record del piano e package-lock invariati. Nessun accesso alla produzione.
ABI/registry manager interamente invariati dal checkpoint.

Il runtime finanziato e' collegato agli ingressi, alla progressione economica,
alle chiusure, ai pagamenti e ai worker. Nuove Carte Regalo riservano i 100 anche
prima del redeem. Non sono prove E2E di database/API/contratti: i test usano doppioni
espliciti del repository/RPC. La parametrizzazione di test non e' una funzione API.

## Primo blocco ancora da implementare
Adozione di DB e obbligazioni preesistenti, NON nuova definizione dei doni. Occorre
un backfill dimostrabile, riserve di apertura e legami idempotenti per storico,
pagamenti/gift/cross/progressioni. Nuove tabelle restano PENDING e H/P unseeded:
non impostarli ad ACTIVE/zero per avviare il servizio. `economic-cutover-inventory`
e' solo lettura. Le prove pre-cutover sono bloccate finche' non riconciliate.

Legacy CASSA non deve essere riassegnata automaticamente. Il codice interrompe la
sua chiusura finche' non e' risolta nella transizione. Anche le operazioni post-commit
legacy richiedono adozione, non un semplice cambio di etichetta nel payload.
Da completare anche la coda del primo ingresso multiplo da sistema vuoto che supera
la tavola 1 prima del settlement del bootstrap. Il codice attuale fa rollback chiuso.

## Protezioni da mantenere
- Raw transaction/hash/nonce salvati prima dell'invio, tentativo prima del broadcast.
- Esito incerto = riconciliazione; niente nuova transazione per un hash noto.
- Nessun saldo libero ricavato soltanto da un balanceOf ignorando gli impegni.
- Prove ERC20 univoche, riserve per gift gia' pagati, P <= H cumulativo sotto lock.
- CONTINUITA senza account/wallet/numero/sdoppiamento; quote next-Gemello separate.
- Capitale Progetti unico da 100, CASSA completa, numeri Gemelli 26+14n riservati.
- Nessun rientro automatico HUMAN del ricevente, netti A ordinari, P reinvestiti.
- Non riscrivere le 25 SQL o cambiare le dipendenze per far passare i test.

## Dati tecnici non disponibili, da non inventare
Commit attivo, stato PostgreSQL reale, snapshot di clone/ripristino, saldi/impegni,
modalita' operativa del signer Gemelli, provvista di avvio autorizzata, receiver completi
ROG/URANUS. Sono necessarie evidenze; non chiavi o password in chat. I wallet G/P
sono confermati; A/T/Registry nei template non provano la configurazione di produzione.

## Confine contratto
50.000 e registrazione ufficiale Progetti->terzi sono fase successiva. Il gate e'
stato aggiornato per NON confondere questi requisiti rinviati con le incompletezze
backend. Non ricominciare la discussione sull'architettura Registry adesso.

## Prossima certificazione
Testare il codice corrente con tutte le dipendenze esatte, PostgreSQL vero,
migrazione di un clone conservativo, concorrenza/crash e simulazione completa dei
turni. Rivedere intenzionalmente le modifiche DDL della CONTINUITA: lo strumento
`economic-schema-review` non le approva, mostra soltanto se le righe dei due snapshot
sono conservate e quali vincoli sono cambiati. Non e' un backup.

La successiva consegna deve riportare test effettivamente eseguiti, differenze,
hash e limiti. Non sostituire il lavoro con una roadmap; non chiamare deployabile
un insieme di moduli soltanto perche' tutti i test locali disponibili sono verdi.

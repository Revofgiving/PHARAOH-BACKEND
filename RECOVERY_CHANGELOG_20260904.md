# PHARAOH Recovery Changelog — 4 settembre 2026

## Baseline

Checkpoint di partenza: `PHARAOH_BACKEND_RECOVERY_4SETTEMBRE_LATEST.zip` con THOT `0006` e ISIDE `0007` già recuperati.

## Modifica recuperata: rimozione Doni a Credito

- rimosse funzioni runtime di creazione/distribuzione/assegnazione credito;
- rimosso collegamento `credito_id` dai contenitori runtime;
- rimosso contenitore `5.3`;
- rimossi tipi `CREDITO` dal modello runtime;
- rimossi riferimenti API/admin ai crediti;
- aggiunta migration `0008_remove_doni_credito.sql`.
- hardening migration `0008`: eventuali FK nullable `prenotazioni_funzioni.funzione_id` verso funzioni `CREDITO` vengono neutralizzate prima della cancellazione, evitando errori su database storici non perfettamente puliti.

## Correzione successiva: nessun Dono al Volo, inclusi omaggi staff

- rimossa lista `5.1` e relativo manager/API;
- rimossa dichiarazione `NON_HA_DONO` dal modello account;
- rimossi campi RHA runtime/schema `staff_omaggi_reserved_usdc` e `staff_omaggi_status`;
- RHA corrente invariato: 300 USDC ROG / 150 dual + 200 USDC URANUS / 10 dual;
- aggiunta migration `0009_remove_dono_al_volo_staff_legacy.sql`.

## Regole economiche preservate

- THOT: 10.000 L5 + 500 progetti umanitari + 500/5 rientri Entrata + 4.000 netto;
- ISIDE: 5.000/50 rientri Entrata + 19.000 netto base + 6.000 quota diretta = 25.000 payout;
- DIRECT, Carta Regalo e cross URANUS/ROG non modificati economicamente.

## Nota migration

`database/init.sql`, `0004_cross_movements.sql` e `0005_rha_dual_300_200.sql` mantengono riferimenti legacy perché sono migration storiche checksumate. Non rappresentano lo schema finale: `0008` e `0009` eseguono la rimozione definitiva.

## Correzione identita condivisa e rientri autonomi — migration 0010

- PERPETUO e GEMELLO non possiedono wallet separati: usano sempre lo stesso wallet Ethereum reale del Primario proprietario.
- L'identita operativa e distinta tramite `accounts.id` + `sigla`; gli pseudo-wallet `_P<n>` / `_G<n>` non sono piu ammessi.
- Nomenclatura genealogica: Perpetuo `A.1`, `A.2`, ...; Gemello `1-A`, `2-A`, ...; Perpetuo di Gemello `1-A.1`, ecc.
- Ogni rientro al livello ENTRATA e una nuova radice autonoma: nuovo `account_id`, nuovo ticket ordinario, nuova sigla radice uguale al ticket, nuova posizione e propria tavola personale/sdoppiamento, pur conservando lo stesso wallet MetaMask del ricevente.
- ISIDE: i 50 rientri producono 50 nuove radici autonome e non riusano l'`account_id` del Secondario sorgente.
- THOT: i 5 rientri producono 5 nuove radici autonome con la stessa regola; il Secondario sorgente resta solo come provenienza audit (`source_account_id` / `source_event_key`).
- L'identita esatta viene propagata attraverso tavole, turni, storico, payout e cross RHA per evitare ambiguita quando piu percorsi condividono lo stesso wallet.
- Aggiunta migration `0010_secondary_identity_wallets.sql`; piano migration aggiornato a 10 step.

## Protezione Funzioni e riporto strutturale ENTRATA — migration 0011/0012

- `0011_entry_function_reservation_guard.sql` aggiunge indici/guard per ticket e caselle prenotate alle Funzioni.
- L'allocator ticket dei rientri salta ticket gia assegnati e ticket prenotati/materializzati per Funzioni/Gemelli.
- L'allocator delle caselle ENTRATA salta caselle riservate alle Funzioni e fallisce chiuso se non esiste una casella lecita.
- `0012_entry_rollover_100.sql` formalizza la regola definitiva ENTRATA:
  - Tavola 1 Fondo A: 6 donatori reali x100 = 600;
  - 500 per progressione;
  - 100 restano in Cassa PHARAOH e vengono riportati nella Tavola 2;
  - dalla Tavola 2: 1 `ROLLOVER` Cassa PHARAOH da 100 + 5 nuovi ingressi = 600;
  - rollover senza account/ticket/sdoppiamento, auditato e idempotente;
  - nessun rollover/rientro puo occupare prenotazioni Funzioni.
- Eliminata dal runtime la precedente idea di un `ENTRY_RESERVE_WALLET` e del payout separato `RISERVA_ENTRATA`.
- La migration 0012 neutralizza solo vecchie richieste RISERVA_ENTRATA sicuramente non inviate e fallisce chiuso sugli stati PROCESSING/ACCEPTED che richiedono riconciliazione.
- `test-entry-rollover-100.js` aggiunto; `test-autonomous-reentry-roots.js` riallineato al rollover.
- Piano migration aggiornato a 12 step.

## Allineamento full-stack frontend/backend

- Modello UI/API chiarito: una persona = un wallet MetaMask; molte posizioni/percorso numerate sullo stesso wallet.
- `/api/config/public` espone anche la configurazione pubblica ROG necessaria ai flussi browser.
- API Area Personale arricchite con associazione percorso/sigla e operazioni cross RHA.
- Frontend DIRECT riallineato alla sequenza Community ROG -> 2 USDC ROG -> registerDonation -> conferma ROG -> 100 USDC PHARAOH -> sessionRef -> una posizione.
- Aggiunta pagina Carta Regalo PHARAOH completa e riprendibile.
- Tempio Personale aggiornato a stesso wallet/multipli percorsi, rientri, cross ROG/URANUS e gate Community ROG.
- Rimossi dal sorgente attivo Doni a Credito, Dono al Volo, dono in prestito/lista attesa; riaperti Papiro e Tempio.
- Test cucitura aggiornato alle API reali; 58 controlli correnti.

## 5 settembre 2026 - RHA -> ROG receipt-backed bridge

Aggiunta la fase ROG.registerDonation per le operazioni RHA con target ROG.
La sequenza diventa:
1. Transfer USDC Cassa PHARAOH -> Cassa ROG.
2. PharaohRegistry registra il movimento PHARAOH.
3. La stessa Cassa PHARAOH firma ROG.registerDonation(importo).
4. Nonce e tx hash di registerDonation vengono persistiti prima/dopo il broadcast.
5. Il receipt DonationRegistered viene verificato senza usare getDonation(uint256).
6. Solo dopo viene inviata la notifica HMAC a ROG con register_tx_hash e donation_id.
7. PHARAOH accetta COMPLETED solo se ROG conferma RGx owner=Cassa PHARAOH e HUMAN owner=ricevente RHA.

Nuova migrazione: 0014_rog_rha_registration_evidence.
Errori di notifica non retryable passano a RECONCILIATION_REQUIRED invece di essere ritentati indefinitamente.

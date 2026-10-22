# PHARAOH - Compatibilita checksum storico 0022 (22 ottobre 2026)

Stato: NON_DEPLOY. Nessun accesso a PostgreSQL di produzione o blockchain effettuato.

## Evidenze fornite dal controllo Mac sul backup di produzione

- 0022 checksum registrato: `1e78baf17ebe367332ed99254605b045d13831c57727cd9bda44ef91da86327f`.
- File storico recuperato sotto `PHARAOH_BACKEND_VECCHI_FILE_13_OTTOBRE/0022_cassa_posizione_completa.sql`, SHA256 coincidente.
- SQL corrente SHA256 `85bcabd00bd2fb904f8d7d895a0976ff602d7736a9ed9e3e5c9eac9d232f8358`.
- Diff: due condizioni relative a `t.faraone_account_id = p.account_id` eliminate nei due join su `p.sdoppiamento_tavola_id = t.id`; altri cambiamenti solo commenti.
- Backup: 3 CASSA complete, zero ROLLOVER, zero CASSA senza account/sdoppiamento/numero, zero errori nella numerazione; 18 tavole personali aperte, zero mancanti/ambigue/errate/account differenti.

## Modifiche locali

- `database/migration-plan.json`: aggiunto unicamente `acceptedAppliedSha256` a 0022. Il checksum del file SQL resta invariato.
- `scripts/test-migration-compat.js`: consente solo l'impronta storica provata e rifiuta impronte non autorizzate.
- `scripts/test-v4-release-and-source.js`: baseline immutabile salvo l'unica eccezione 0022 esplicitamente verificata.

## Limiti di certificazione

Test in memoria/statici non dimostrano esecuzione su PostgreSQL reale. 0029 e 0030 restano da collaudare su clone isolato del backup con audit dati prima/dopo. Non eseguire deploy o migration su produzione senza consenso esplicito, backup verificato e prova restore isolata.

## Test svolti nel runtime di costruzione

- `node scripts/test-migration-compat.js`: PASS.
- `node scripts/test-v4-release-and-source.js`: PASS.
- Suite completa: `PASS=49`, `FAIL=0`, `BLOCKED_DEPENDENCY=4`; mancavano le dipendenze `ethers` e `dotenv` in questo runtime. Non equivale a 53/53 PASS. L'utente aveva ottenuto 53/53 nella propria installazione Mac prima di questa patch. Richiesta riesecuzione locale dopo patch.
- Preflight statico OK, database reale non contattato.
- Piano migrazioni OK: 30.
- Le evidenze/manifest della release precedente sono conservate come documenti storici: non certificano la nuova ZIP. Il manifest aggiornato di consegna e `SHA256_MANIFEST_0022_COMPAT_22_OTTOBRE_2026.txt`.

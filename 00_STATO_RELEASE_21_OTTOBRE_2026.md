# PHARAOH BACKEND V6 — stato release 21 ottobre 2026

STATO: RELEASE PACKAGE PRONTO PER COOLIFY, senza deploy produzione eseguito.

Gate consolidati:
- sorgente V6 canonico;
- migration plan: 30 migration;
- 0029 SHA256: 0d6e03012ba99bbb6a4ff7b062930d4257a319bff9e714013b405ac8b26c0ce3;
- 0030 SHA256: 5a6864758175cf99d4e7e38705e978722bff9d1ecbca270292ea286572c3dd6a;
- staging PostgreSQL: restore PASS; 0029/0030 PASS; 44 tabelle post-migration;
- dati applicativi preservati; pharaoh_schema_migrations 28 -> 30 atteso; nuova direct_pharaoh_tx_candidates con 18 righe attese;
- produzione PHARAOH non migrata; backend ROG non modificato.

Metadata release riallineati a 30 migration / 53 test.

Prima del deploy produzione: eseguire i preflight production/integration inclusi nel pacchetto e verificare le variabili Coolify.

# PHARAOH — merge chirurgico pannello amministrativo / blocco donazioni — 5 ottobre 2026

Baseline: `PHARAOH_BACKEND_FULL_SOURCE_1_OTTOBRE_PROGRESSIVO_GLOBALE_V4`.

Importato dalla versione Isa del 2 ottobre **solo** il controllo amministrativo dedicato alle donazioni:
- stato persistente `donazioni_blocco` in `state_persistence`;
- GET pubblico `/api/donazioni/stato`;
- GET admin `/api/admin/donazioni/stato`;
- POST admin `/api/admin/donazioni/blocca`;
- POST admin `/api/admin/donazioni/riattiva`;
- middleware fail-closed che rifiuta i nuovi flussi di dono con `DONATIONS_BLOCKED`;
- stato donazioni incluso in `/api/admin/stato`;
- test statico dedicato.

Adattamento chirurgico alla baseline V4:
- protetto anche `/api/donazione/diretta/authorize`;
- protetti i nuovi finanziamenti Carta Regalo Smartbox (`create`, ROG payment/register, PHARAOH payment);
- **NON** viene bloccato `/api/gift/smartbox/redeem`, perche e attivazione di un regalo gia interamente pagato;
- nessuna modifica a numerazione globale, CASSA, Funzioni, RHA/THOT/ISIDE, DIRECT 60m, Smartbox 3 mesi, cross outbound o altre logiche.

Non e stata introdotta alcuna nuova migration: viene riusata la tabella `state_persistence` gia esistente.

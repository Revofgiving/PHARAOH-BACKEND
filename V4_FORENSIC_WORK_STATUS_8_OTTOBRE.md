> **NOTA STORICA — SUPERATO.** Questo documento descrive un checkpoint precedente dell'8/9 ottobre 2026. Non rappresenta lo stato della release corrente. La release corrente e documentata in `00_DEPLOYABLE_RELEASE_README_13_OTTOBRE_2026.md` e governata da `release-state.json` + `ops/v4-release-gate.js`.

# PHARAOH - integrazione runtime dell'8 ottobre 2026

**NON DEPLOYABILE.** Codice integrato e testato localmente, ma non certificato
su PostgreSQL, dati preesistenti, servizi cross o blockchain reale.

42 suite: 39 PASS, 0 FAIL, 3 BLOCKED_DEPENDENCY. `npm test` termina con exit 1.
Sintassi JavaScript: 102/102. Piano migrazioni: 27 (25 originarie invariate + 2 nuove).
Nessuna migrazione eseguita contro un server PostgreSQL. Nessun pagamento reale.

La procedura di adozione del database preesistente e delle riserve iniziali NON
esiste ancora in forma completa: l'inventario read-only non la sostituisce.
Restano anche la riconciliazione CASSA/operazioni legacy e la gestione persistente
del primo lotto multiplo che attraversa il bootstrap S0.

Solo backend. Contratto e ABI invariati. Il massimale contrattuale e le uscite
dirette Progetti restano alla fase successiva, non sono domande da riaprire ora.

Fonti di stato correnti: `release-state.json`,
`docs/RAPPORTO_INTEGRAZIONE_RUNTIME_8_OTTOBRE_2026.md`,
`docs/HANDOFF_RUNTIME_8_OTTOBRE_2026.md`,
`evidence/implementation-pass/final-run/`.
I precedenti rapporti e manifest restano evidenze storiche, non certificano questo albero.

PHARAOH BACKEND V4 - DEPLOYABLE RELEASE

LEGGERE PRIMA: 00_DEPLOYABLE_RELEASE_README_13_OTTOBRE_2026.md

Questa release sostituisce i checkpoint storici NON DEPLOY dell'8-9 ottobre.
Il release gate corrente e fail-closed ma ALLOW per questa release certificata V4.
Docker build: gate + preflight statico.
Container startup: gate -> preflight produzione -> preflight integrazioni read-only -> migrazioni -> API.

NON resettare il database esistente. NON inserire chiavi private nel repository.

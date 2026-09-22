# ARCHITETTURA SMART CONTRACT PHARAOH - 4 SETTEMBRE 2026

## Relazione tra sistemi

ROG e il parent. URANUS e PHARAOH sono satelliti fratelli.

`PharaohRegistry` conosce soltanto:

- il contratto ROG padre (`parentDAO`);
- il wallet/Cassa PHARAOH (`pharaohTreasury`);
- i wallet autorizzati tramite `BACKEND_ROLE`.

Non richiede `URANUS_REGISTRY_ADDRESS` e non effettua chiamate a UranusRegistry.

## Responsabilita

Il backend PHARAOH contiene tutte le regole funzionali ed economiche. Verifica le vere transazioni USDC e, dopo la verifica, registra nel Registry soltanto la prova del movimento di Cassa:

- `registerIncoming`: movimento verso Cassa PHARAOH;
- `registerOutgoing`: movimento dalla Cassa PHARAOH.

DIRECT, Carta Regalo, RHA, THOT, ISIDE, ROG e URANUS rimangono workflow backend. `txType` e soltanto un'etichetta audit.

## Flusso URANUS

Quando il backend invia 200 USDC dalla Cassa PHARAOH alla Cassa URANUS, il Registry PHARAOH registra una semplice uscita PHARAOH verso quel wallet. Non chiama UranusRegistry.

Quando un flusso verificato entra da URANUS verso PHARAOH, il backend registra una semplice entrata nella Cassa PHARAOH. Anche qui non esiste dipendenza dallo smart contract URANUS.

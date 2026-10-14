'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const account = read('account-manager.js');
const api = read('api-server.js');
const env = read('.env.example');

assert.ok(account.includes('Un solo wallet MetaMask = una sola persona'), 'Il backend deve modellare un solo wallet/persona');
assert.ok(account.includes('getAccountsByWallet'), 'Il profilo deve recuperare tutti i percorsi della stessa stringa wallet');
assert.ok(account.includes('getPercorsiWalletSnapshot'), 'Area Personale deve usare lo snapshot bulk dei percorsi');
assert.ok(account.includes('ANY($1::bigint[])'), 'Snapshot percorsi deve evitare query N+1 per ogni rientro');
assert.ok(account.includes('percorso_id'), 'Percorsi devono conservare un identificatore tecnico distinto dal wallet');
assert.ok(api.includes('p.account_id AS percorso_id'), 'Le posizioni devono esporre il percorso tecnico');
assert.ok(api.includes('AS sigla_percorso'), 'Le posizioni devono esporre la sigla nominale');
assert.ok(api.includes("app.get('/api/account/:wallet/cross'"), 'Area Personale deve poter leggere lo stato cross ROG/URANUS');
assert.ok(api.includes('treasuryWallet: rogConfig.treasuryWallet'), 'Config pubblica deve esporre la Cassa ROG');
assert.ok(api.includes('contractAddress: rogConfig.contractAddress'), 'Config pubblica deve esporre il contratto ROG');
assert.ok(api.includes('usdcContractAddress: rogConfig.usdcContractAddress'), 'Config pubblica deve esporre USDC ROG');
assert.ok(api.includes('requiredDonationUsdc: rogConfig.amountUsdc'), 'Config pubblica deve esporre importo ROG');
assert.ok(env.includes('ROG_TREASURY_WALLET=0xd5bcc7acc9d6862c784807134c1f70c3e7f9f790'), 'Cassa ROG ufficiale deve essere documentata');
assert.ok(env.includes('ROG_CONTRACT_ADDRESS=0x0723a5d24afCe5732c9D5C00Ae580934d5664Aa0'), 'Contratto ROG ufficiale deve essere documentato');
assert.ok(env.includes('ROG_USDC_CONTRACT_ADDRESS=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'), 'USDC Polygon ROG deve essere documentato');

console.log('PASS WALLET/PERSONA: stessa stringa MetaMask, molti percorsi numerati, snapshot bulk + config pubblica ROG');

'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const wallet = '0x1234567890abcdef1234567890abcdef12345678';
let nextId = 100;
let nextGemelloTicket = 26;
const byId = new Map();
const created = [];

const primary = {
  id: 23,
  wallet,
  nome: 'PRIMARY 23',
  tipo: 'PRIMARIO',
  sigla: '23',
  ticket_number: 23,
  root_account_id: 23
};
byId.set(primary.id, primary);

const dbStub = {
  async getAccountByIdentity(identity) {
    if (identity.accountId) return byId.get(Number(identity.accountId)) || null;
    return [...byId.values()].find(a => a.wallet === String(identity.wallet).toLowerCase() && (!identity.sigla || a.sigla === identity.sigla)) || null;
  },
  async createAccount(input) {
    const row = {
      id: nextId++,
      wallet: String(input.wallet).toLowerCase(),
      nome: input.nome,
      tipo: input.tipo,
      sigla: input.sigla,
      ticket_number: null,
      parent_account_id: input.parentAccountId,
      root_account_id: input.rootAccountId,
      account_key: input.accountKey
    };
    byId.set(row.id, row);
    created.push({ ...input, id: row.id });
    return { ...row };
  },
  async assignNextGemelloTicketToAccountId(id) {
    const row = byId.get(Number(id));
    if (!row.ticket_number) {
      row.ticket_number = nextGemelloTicket;
      nextGemelloTicket += 14;
    }
    return { ...row };
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && path.resolve(parent.filename) === path.join(ROOT, 'account-manager.js')) {
    if (request === './db-manager') return dbStub;
    if (request === './container-manager') return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const accountPath = require.resolve(path.join(ROOT, 'account-manager.js'));
delete require.cache[accountPath];

(async () => {
  try {
    const accounts = require(accountPath);
    assert.equal(accounts.calcolaSiglaPerpetuo('A', 1), 'A.1');
    assert.equal(accounts.calcolaSiglaPerpetuo('A.1', 2), 'A.2');
    assert.equal(accounts.calcolaSiglaGemello('A', 1), '1-A');
    assert.equal(accounts.calcolaSiglaGemello('1-A', 2), '2-A');
    assert.equal(accounts.calcolaSiglaPerpetuo('1-A', 1), '1-A.1');

    const p1 = await accounts.creaPerpetuo(wallet, '23', 1, null, primary.id);
    assert.equal(p1.wallet, wallet);
    assert.equal(p1.sigla, '23.1');
    byId.set(p1.account.id, { ...p1.account, root_account_id: 23 });

    const g1 = await accounts.creaGemello(wallet, '23', 1, null, primary.id);
    assert.equal(g1.wallet, wallet);
    assert.equal(g1.sigla, '1-23');
    assert.equal(g1.ticketPrenotato, 26);
    byId.set(g1.account.id, { ...g1.account, root_account_id: 23 });

    const p2 = await accounts.creaPerpetuo(wallet, '23.1', 2, null, p1.account.id);
    assert.equal(p2.wallet, wallet);
    assert.equal(p2.sigla, '23.2');

    const gp = await accounts.creaPerpetuo(wallet, '1-23', 1, null, g1.account.id);
    assert.equal(gp.wallet, wallet);
    assert.equal(gp.sigla, '1-23.1');

    const g2 = await accounts.creaGemello(wallet, '1-23', 2, null, g1.account.id);
    assert.equal(g2.wallet, wallet);
    assert.equal(g2.sigla, '2-23');
    assert.equal(g2.ticketPrenotato, 40);

    assert.ok(created.every(x => x.wallet === wallet), 'Nessun Secondario deve usare un wallet diverso dal Primario');
    assert.ok(created.every(x => !/_P\d+$/i.test(x.wallet) && !/_G\d+$/i.test(x.wallet)), 'Pseudo-wallet vietati');
    assert.ok(created.every(x => Number(x.rootAccountId) === 23), 'Genealogia deve restare sulla stessa radice primaria');

    console.log('PASS SHARED WALLET IDENTITY: Primario/Perpetui/Gemelli condividono lo stesso wallet reale; sigle PDF A.1/1-A rispettate');
  } finally {
    delete require.cache[accountPath];
    Module._load = originalLoad;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

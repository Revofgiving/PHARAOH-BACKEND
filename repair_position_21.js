'use strict';
// PHARAOH position 21: one-time guarded repair. Run from backend root.
// Default: DRY RUN (ROLLBACK); set PHARAOH_21_COMMIT=YES to commit.
const pg = require('./pg-connection-manager');
const WALLET = '0x0dcbf14ea10242440085619a024cb1ac1f920a4e';
const COMMIT = process.env.PHARAOH_21_COMMIT === 'YES';
const KEY = 'RECOVERY:LEGACY:POSITION:21:RECORD:25';
function ensure(v, msg) { if (!v) throw new Error('ABORT: ' + msg); }
(async () => {
  const c = await pg.getClient();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '5s'");
    await c.query("SET LOCAL statement_timeout = '30s'");
    await c.query("SELECT pg_advisory_xact_lock(210025)");
    const q = (sql,p=[])=>c.query(sql,p);
    const original = (await q(`SELECT p.*, t.numero AS tavola_numero, t.sezione, t.livello FROM posizioni p JOIN tavole t ON t.id=p.tavola_id WHERE p.id=25 FOR UPDATE OF p`)).rows[0];
    ensure(original && String(original.numero_posizionale)==='21' && String(original.account_id)==='8' && original.wallet.toLowerCase()===WALLET && original.status==='ATTIVO' && String(original.tavola_numero)==='4' && Number(original.casella)===3 && original.sezione==='ENTRATA' && Number(original.livello)===0,'position 21 no longer matches certified state');
    const a8 = (await q('SELECT * FROM accounts WHERE id=8 FOR UPDATE')).rows[0];
    ensure(a8 && a8.wallet.toLowerCase()===WALLET && String(a8.numero_posizionale)==='6' && a8.tipo==='PRIMARIO', 'account 8 changed');
    const p6 = (await q('SELECT * FROM posizioni WHERE id=6 FOR UPDATE')).rows[0];
    ensure(p6 && String(p6.account_id)==='8' && String(p6.numero_posizionale)==='6', 'position 6 changed');
    const membership = (await q('SELECT * FROM pharaoh_s0_memberships WHERE posizione_id=25 FOR UPDATE')).rows[0];
    ensure(membership && String(membership.account_id)==='8' && String(membership.numero_posizionale)==='21' && membership.position_class==='HUMAN' && membership.origin==='LEGACY', 'S0 membership changed');
    const economy = (await q('SELECT * FROM pharaoh_account_economics WHERE account_id=8 FOR UPDATE')).rows[0];
    ensure(economy && economy.position_class==='HUMAN' && economy.origin==='LEGACY' && economy.owner_wallet.toLowerCase()===WALLET, 'legacy economy changed');
    const conflict = await q('SELECT id FROM accounts WHERE numero_posizionale=21 OR account_key=$1', [KEY]);
    ensure(conflict.rowCount===0,'position 21 already has an account or recovery key');
    const countBefore = Number((await q('SELECT count(*)::int AS n FROM accounts WHERE lower(wallet)=$1',[WALLET])).rows[0].n);
    ensure(countBefore===4, 'expected exactly four existing wallet accounts');
    const refs = await q(`SELECT conrelid::regclass::text AS dependent_table, att.attname AS dependent_column
      FROM pg_constraint cst JOIN pg_attribute att ON att.attrelid=cst.conrelid AND att.attnum=ANY(cst.conkey)
      WHERE cst.contype='f' AND cst.confrelid='accounts'::regclass AND att.attname='account_id'
      ORDER BY dependent_table`);
    const otherNames = refs.rows.map(x=>x.dependent_table).filter(x=>!['posizioni','pharaoh_s0_memberships','pharaoh_account_economics'].includes(x));
    console.log('BEFORE', JSON.stringify({position25:original, account8:a8, s0:membership, economy8:economy, referencing_tables:otherNames}));
    // Identity creation is not a new donation and does not mutate historical ledger events.
    const created=(await q(`INSERT INTO accounts
      (wallet,nome,numero_posizionale,tipo,sigla,parent_wallet,status,created_at,
       account_key,parent_account_id,root_account_id,source_account_id,source_event_key,origin_kind)
      VALUES ($1,$2,21,'PRIMARIO','21',NULL,'REGISTRATO',$3,$4,NULL,NULL,NULL,NULL,'LEGACY') RETURNING *`,
      [WALLET, original.nome || a8.nome, original.created_at, KEY])).rows[0];
    await q(`UPDATE posizioni SET account_id=$1, account_sigla='21' WHERE id=25 AND account_id=8 AND numero_posizionale=21`,[created.id]);
    await q(`UPDATE pharaoh_s0_memberships SET account_id=$1 WHERE posizione_id=25 AND account_id=8`,[created.id]);
    // Economic identity metadata only; no balances, events, proofs, movements, or counters are changed.
    await q(`INSERT INTO pharaoh_account_economics
      (account_id,root_account_id,position_class,owner_wallet,custody_wallet,origin,source_event_key,created_at)
      VALUES ($1,$1,$2,$3,$4,$5,$6,$7)`,[created.id,economy.position_class,economy.owner_wallet,economy.custody_wallet,economy.origin,economy.source_event_key,economy.created_at]);
    const check=(await q(`SELECT p.id,p.account_id,p.account_sigla,p.numero_posizionale,
      a.numero_posizionale AS account_numero,a.wallet, s.account_id AS s0_account_id,
      e.account_id AS economic_account_id
      FROM posizioni p JOIN accounts a ON a.id=p.account_id
      LEFT JOIN pharaoh_s0_memberships s ON s.posizione_id=p.id
      LEFT JOIN pharaoh_account_economics e ON e.account_id=p.account_id
      WHERE p.id IN (6,25) ORDER BY p.id`)).rows;
    ensure(check.length===2 && String(check[0].account_id)==='8' && String(check[0].numero_posizionale)==='6'
      && String(check[1].numero_posizionale)==='21' && String(check[1].account_numero)==='21'
      && String(check[1].s0_account_id)===String(created.id) && String(check[1].economic_account_id)===String(created.id), 'postcondition failed');
    const paths=(await q(`SELECT numero_posizionale FROM accounts WHERE lower(wallet)=$1 ORDER BY numero_posizionale`,[WALLET])).rows.map(x=>Number(x.numero_posizionale));
    ensure(JSON.stringify(paths)===JSON.stringify([6,21,22,65,66]), 'wrong wallet paths: '+paths);
    console.log('AFTER', JSON.stringify({newAccount:created.id,check,paths}));
    if (COMMIT) { await q('COMMIT'); console.log('COMMITTED: position 21 repaired; verify /api/account/:wallet'); }
    else { await q('ROLLBACK'); console.log('DRY RUN PASSED: no data changed. To commit set PHARAOH_21_COMMIT=YES'); }
  } catch(e) {try {await c.query('ROLLBACK');} catch(_) {} console.error(e.stack||e);process.exitCode=1;}
  finally {c.release();await pg.close();}
})().catch(e=>{console.error(e);process.exitCode=1});

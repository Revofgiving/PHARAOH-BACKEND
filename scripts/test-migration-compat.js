'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const migrations = require('../ops/db-migrate');
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'database/migration-plan.json'), 'utf8'));

assert.equal(plan.migrations.length, 18);
for (const m of plan.migrations) {
  const data = fs.readFileSync(path.join(ROOT, m.file));
  const got = crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(got, m.sha256, `Checksum corrente non coerente per ${m.id}`);
}
const m2 = plan.migrations.find(x => x.id === '0002_direct_donation_sessions');
const m3 = plan.migrations.find(x => x.id === '0003_gift_sessions');
const m4 = plan.migrations.find(x => x.id === '0004_cross_movements');
const m5 = plan.migrations.find(x => x.id === '0005_rha_dual_300_200');
const m6 = plan.migrations.find(x => x.id === '0006_thot_humanitarian_reentry');
const m7 = plan.migrations.find(x => x.id === '0007_iside_reentry_receiver_gift');
const m8 = plan.migrations.find(x => x.id === '0008_remove_doni_credito');
const m9 = plan.migrations.find(x => x.id === '0009_remove_dono_al_volo_staff_legacy');
const m10 = plan.migrations.find(x => x.id === '0010_secondary_identity_wallets');
const m11 = plan.migrations.find(x => x.id === '0011_entry_function_reservation_guard');
const m12 = plan.migrations.find(x => x.id === '0012_entry_rollover_100');
const m13 = plan.migrations.find(x => x.id === '0013_pharaoh_treasury_registry_v3');
const m14 = plan.migrations.find(x => x.id === '0014_rog_rha_registration_evidence');
const m15 = plan.migrations.find(x => x.id === '0015_direct_rog_async_gate');
const m16 = plan.migrations.find(x => x.id === '0016_gift_pending_rog_beneficiary');
const m17 = plan.migrations.find(x => x.id === '0017_gift_dynamic_rog_amount');
const m18 = plan.migrations.find(x => x.id === '0018_gift_rog_exact_2');
assert.ok(m2.acceptedAppliedSha256.includes('8228812230a6e84b51a492c5f850cb2b0b7015073501475de1812ab86bd4f003'));
assert.ok(m3.acceptedAppliedSha256.includes('e14f0b7b69f98885375c3479f6841a4aef5796e7c7058650edd6d9560e48413a'));
assert.ok(!m4.acceptedAppliedSha256, '0004 e nuova e non deve accettare checksum legacy');
assert.ok(m5 && !m5.acceptedAppliedSha256, '0005 deve essere una migration nuova e immutabile');
assert.ok(m6 && !m6.acceptedAppliedSha256, '0006 deve essere una migration nuova e immutabile');
assert.ok(m7 && !m7.acceptedAppliedSha256, '0007 deve essere una migration nuova e immutabile');
assert.ok(m8 && !m8.acceptedAppliedSha256, '0008 deve essere una migration nuova e immutabile');
assert.ok(m9 && !m9.acceptedAppliedSha256, '0009 deve essere una migration nuova e immutabile');
assert.ok(m10 && !m10.acceptedAppliedSha256, '0010 deve essere una migration nuova e immutabile');
assert.ok(m11 && !m11.acceptedAppliedSha256, '0011 deve essere una migration nuova e immutabile');
assert.ok(m12 && !m12.acceptedAppliedSha256, '0012 deve essere una migration nuova e immutabile');
assert.ok(m13 && !m13.acceptedAppliedSha256, '0013 deve essere una migration nuova e immutabile');
assert.ok(m14 && !m14.acceptedAppliedSha256, '0014 deve essere una migration nuova e immutabile');
assert.ok(m15 && !m15.acceptedAppliedSha256, '0015 deve essere una migration nuova e immutabile');
assert.ok(m16 && !m16.acceptedAppliedSha256, '0016 deve essere una migration nuova e immutabile');
assert.ok(m17 && !m17.acceptedAppliedSha256, '0017 deve essere una migration nuova e immutabile');
assert.ok(m18 && !m18.acceptedAppliedSha256, '0018 deve essere una migration nuova e immutabile');

const runner = fs.readFileSync(path.join(ROOT, 'ops/db-migrate.js'), 'utf8');
assert.ok(runner.includes('acceptedAppliedSha256'), 'Migration runner deve riconoscere checksum legacy autorizzati');
assert.ok(runner.includes('const accepted = new Set([planned.checksum'), 'Migration runner deve costruire allowlist esplicita');
const legacyApplied = [
  { id: '0001_baseline', checksum: plan.migrations[0].sha256 },
  { id: '0002_direct_donation_sessions', checksum: '8228812230a6e84b51a492c5f850cb2b0b7015073501475de1812ab86bd4f003' },
  { id: '0003_gift_sessions', checksum: 'e14f0b7b69f98885375c3479f6841a4aef5796e7c7058650edd6d9560e48413a' }
];
const comparison = migrations.comparePlan(migrations.loadPlan(), legacyApplied);
assert.deepEqual(comparison.drift, [], 'Checksum 0002/0003 gia applicati devono essere accettati esplicitamente');
assert.deepEqual(comparison.pending.map(x => x.id), ['0004_cross_movements', '0005_rha_dual_300_200', '0006_thot_humanitarian_reentry', '0007_iside_reentry_receiver_gift', '0008_remove_doni_credito', '0009_remove_dono_al_volo_staff_legacy', '0010_secondary_identity_wallets', '0011_entry_function_reservation_guard', '0012_entry_rollover_100', '0013_pharaoh_treasury_registry_v3', '0014_rog_rha_registration_evidence', '0015_direct_rog_async_gate', '0016_gift_pending_rog_beneficiary', '0017_gift_dynamic_rog_amount', '0018_gift_rog_exact_2']);
const bad = migrations.comparePlan(migrations.loadPlan(), [{ id: '0002_direct_donation_sessions', checksum: '0'.repeat(64) }]);
assert.deepEqual(bad.drift, ['0002_direct_donation_sessions']);

console.log('PASS MIGRATIONS: 18 checksum correnti validi + 0010 identita/rientri + 0011 guard Funzioni + 0012 rollover Entrata + 0013 Pharaoh Treasury Registry V3 + 0014 ROG RHA registration evidence + 0015 DIRECT ROG async gate + 0016 beneficiary pending ROG + 0017 gift ROG dynamic amount + 0018 gift ROG fixed 2 USDC + compatibilita 0002/0003 legacy');

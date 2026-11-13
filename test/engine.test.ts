import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENARIOS, getScenario } from '../src/scenarios/index.ts';
import { InProcessTarget } from '../src/engine/targets.ts';
import { runScenario } from '../src/engine/runner.ts';
import { readFixture, replay, writeFixture } from '../src/engine/fixture.ts';
import { userImpact } from '../src/engine/impact.ts';
import { type Bugs, createReferenceApp, NO_BUGS } from '../examples/reference-app.ts';
import { TYPICAL_BUGS } from '../examples/naive-adapter.ts';
import type { Transaction } from '../src/types.ts';

const target = (bugs: Partial<Bugs> = {}) => new InProcessTarget(({ plaid }) => createReferenceApp(plaid, bugs));

/** Which scenario must catch each bug when it is the only bug present. */
const DETECTION_MATRIX: Record<keyof Bugs, string> = {
  ignoreRemoved: 'pending-to-posted',
  nonIdempotentWrites: 'duplicate-webhook-delivery',
  trustWebhookOrder: 'out-of-order-item-events',
  ignoreHasMore: 'paginated-sync',
  noRestartOnMutation: 'mutation-during-pagination',
  ignoreLoginRepaired: 'login-required-then-repaired',
  clearDataOnSyncError: 'login-required-then-repaired',
  noReconcile: 'missed-webhook-reconcile',
};

test('scenario catalog: 8 scenarios, unique ids, every bug has a detecting scenario', () => {
  assert.equal(SCENARIOS.length, 8);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 8);
  assert.deepEqual(Object.keys(DETECTION_MATRIX).sort(), Object.keys(NO_BUGS).sort());
  for (const s of SCENARIOS) {
    assert.ok(s.docs.length && s.summary && s.whyItMatters, `${s.id} is documented`);
    const script = s.build(1);
    assert.deepEqual(JSON.parse(JSON.stringify(script)), script, `${s.id} script is JSON-serializable`);
  }
});

test('the robust reference app passes every scenario for seeds 1–25 (no false positives)', async () => {
  const t = target();
  for (const s of SCENARIOS) {
    for (let seed = 1; seed <= 25; seed++) {
      const r = await runScenario(t, s, seed);
      assert.ok(
        r.passed && r.invariants.every((i) => i.passed),
        `${s.id} seed ${seed}: ${r.invariants.filter((i) => !i.passed).map((i) => i.message).join('; ')}`,
      );
    }
  }
});

for (const [bug, scenarioId] of Object.entries(DETECTION_MATRIX)) {
  test(`bug "${bug}" alone is caught by ${scenarioId} on every seed 1–10`, async () => {
    const t = target({ [bug]: true });
    for (let seed = 1; seed <= 10; seed++) {
      const r = await runScenario(t, getScenario(scenarioId), seed);
      assert.equal(r.passed, false, `seed ${seed} did not catch ${bug}`);
      assert.ok(r.timeline.length > 0);
    }
  });
}

test('typical naive app: fails every scenario except the cursor catch-up control', async () => {
  const t = target(TYPICAL_BUGS);
  for (const s of SCENARIOS) {
    const r = await runScenario(t, s, 1);
    assert.equal(r.passed, s.id === 'missed-webhook-catchup', s.id);
  }
});

test('targeted invariants and user impact are reported for each failure', async () => {
  const cases: Array<[keyof Bugs, string, string, RegExp]> = [
    ['ignoreRemoved', 'pending-to-posted', 'no-pending-posted-double-count', /listed twice: once as pending/],
    ['nonIdempotentWrites', 'duplicate-webhook-delivery', 'no-duplicate-transactions', /appears 2 times/],
    ['trustWebhookOrder', 'out-of-order-item-events', 'item-status-matches', /told to reconnect/],
    ['noRestartOnMutation', 'mutation-during-pagination', 'sync-restarts-from-original-cursor', /no longer exists at the bank/],
    ['clearDataOnSyncError', 'login-required-then-repaired', 'no-missing-transactions', /^\[during outage\]/],
  ];
  for (const [bug, scenarioId, invariant, impact] of cases) {
    const r = await runScenario(target({ [bug]: true }), getScenario(scenarioId), 1);
    assert.ok(r.invariants.some((i) => i.id === invariant && !i.passed), `${bug} → ${invariant}`);
    assert.ok(r.impact.some((l) => impact.test(l)), `${bug} impact: ${r.impact.join(' / ')}`);
  }
});

test('mutation scenario actually triggers the mid-pagination error and the robust app restarts from the original cursor', async () => {
  const r = await runScenario(target(), getScenario('mutation-during-pagination'), 3);
  assert.ok(r.timeline.some((e) => e.kind === 'mutation-fired'));
  assert.ok(r.timeline.some((e) => e.kind === 'api' && e.errorCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'));
  const restart = r.invariants.find((i) => i.id === 'sync-restarts-from-original-cursor');
  assert.match(restart!.message, /restarted correctly/);
});

test('same seed ⇒ identical result (determinism)', async () => {
  for (const s of SCENARIOS) {
    const a = await runScenario(target(TYPICAL_BUGS), s, 7);
    const b = await runScenario(target(TYPICAL_BUGS), s, 7);
    assert.equal(JSON.stringify(a), JSON.stringify(b), s.id);
  }
});

test('fixtures replay to the same verdict, invariants and timeline; a fixed app passes the fixture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chaos-fixture-'));
  try {
    for (const s of SCENARIOS.filter((x) => x.id !== 'missed-webhook-catchup')) {
      const original = await runScenario(target(TYPICAL_BUGS), s, 4);
      const path = join(dir, `${s.id}.json`);
      await writeFixture(path, original);
      const fixture = await readFixture(path);
      assert.equal(fixture.observed.passed, false);
      const again = await replay(fixture, target(TYPICAL_BUGS));
      assert.deepEqual(again.invariants, original.invariants, s.id);
      assert.deepEqual(again.timeline, original.timeline, s.id);
      const fixed = await replay(fixture, target());
      assert.equal(fixed.passed, true, `${s.id} fixed app passes the fixture`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('impact: no lines when the app is correct; spend delta when double-counted', () => {
  const t: Transaction = {
    transaction_id: 't',
    account_id: 'a',
    amount: 10,
    iso_currency_code: 'USD',
    date: '2026-10-01',
    name: 'X',
    merchant_name: 'X',
    pending: false,
    pending_transaction_id: 'p',
  };
  const seen = new Map<string, Transaction>([['t', t], ['p',{ ...t, transaction_id: 'p', pending: true, pending_transaction_id: null }]]);
  const ok = userImpact({ app: { transactions: [{ transaction_id: 't', amount: 10 }] }, truth: [t], truthStatus: 'healthy', seen, replacements: new Map([['t', 'p']]) });
  assert.deepEqual(ok, []);
  const bad = userImpact({
    app: { transactions: [{ transaction_id: 't', amount: 10 }, { transaction_id: 'p', amount: 10 }] },
    truth: [t],
    truthStatus: 'healthy',
    seen,
    replacements: new Map([['t', 'p']]),
  });
  assert.match(bad[0], /overstated by \$10\.00/);
});

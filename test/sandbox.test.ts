// Offline tests for the Sandbox layer. A stub backed by the fake bank stands in for
// Plaid Sandbox so the recorder, runner and replay path run without network access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction, TransactionsSyncRequest } from '../src/types.ts';
import { FakeBank } from '../src/fake-plaid/bank.ts';
import { FakePlaidError } from '../src/fake-plaid/errors.ts';
import { InProcessTarget } from '../src/engine/targets.ts';
import { runScenario } from '../src/engine/runner.ts';
import { replay, toFixture } from '../src/engine/fixture.ts';
import { getScenario, SCENARIOS } from '../src/scenarios/index.ts';
import { DataFactory } from '../src/scenarios/helpers.ts';
import { diffToOps, runSandboxScenario } from '../src/sandbox/runner.ts';
import { readCassette } from '../src/sandbox/cassette.ts';
import { PlaidHttpError, type SandboxApi } from '../src/sandbox/api.ts';
import { SANDBOX_SCENARIOS } from '../src/sandbox/scenarios.ts';
import { type Bugs, createReferenceApp } from '../examples/reference-app.ts';

const target = (bugs: Partial<Bugs> = {}) => new InProcessTarget(({ plaid }) => createReferenceApp(plaid, bugs));
const CASSETTE = 'examples/fixtures/sandbox-cassette.json';

const txn = (id: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id,
  account_id: 'acc',
  amount,
  iso_currency_code: 'USD',
  date: '2026-11-01',
  name: id,
  merchant_name: id,
  pending: false,
  pending_transaction_id: null,
  ...extra,
});

test('diffToOps turns a real refresh into posts, adds, modifies and removes', () => {
  const before = [txn('p1', 4.5, { pending: true }), txn('a', 10), txn('b', 20), txn('gone', 1)];
  const after = [txn('t1', 5.4, { pending_transaction_id: 'p1' }), txn('a', 12), txn('b', 20), txn('new', 3, { pending: true })];
  const ops = diffToOps(before, after);
  assert.deepEqual(
    ops.map((o) => o.op + ':' + ('pending_id' in o ? o.pending_id : 'txn' in o ? o.txn.transaction_id : o.transaction_id)),
    ['post:p1', 'add:new', 'modify:a', 'remove:gone'],
  );
  // Replaying the ops on a bank reproduces `after` exactly.
  const bank = new FakeBank(100);
  bank.createItem('i', 't');
  bank.apply('i', before.map((t) => ({ op: 'add' as const, txn: t })));
  bank.apply('i', ops);
  const sort = (x: Transaction[]) => [...x].sort((m, n) => m.transaction_id.localeCompare(n.transaction_id));
  assert.deepEqual(sort(bank.truth('i')), sort(after));
});

test('the checked-in cassette is real Sandbox data with real pending→posted pairs', async () => {
  const c = await readCassette(CASSETTE);
  assert.ok(c.transactions.length > 200);
  assert.ok(c.stats.pendingPosted > 0);
  assert.ok(c.transactions.some((t) => (t as unknown as Record<string, unknown>).personal_finance_category), 'full Plaid field set');
  const json = JSON.stringify(c);
  assert.doesNotMatch(json, /access-sandbox-[0-9a-f-]{20,}/, 'no access tokens');
});

test('DataFactory draws unique recorded transactions and keeps their real fields', async () => {
  const { transactions } = await readCassette(CASSETTE);
  const f = new DataFactory(3, transactions);
  const drawn = f.many(20);
  assert.equal(new Set(drawn.map((t) => t.transaction_id)).size, 20);
  const ids = new Set(transactions.map((t) => t.transaction_id));
  assert.ok(drawn.every((t) => ids.has(t.transaction_id)));
  assert.ok(drawn.every((t) => t.pending === false && t.pending_transaction_id === null));
  const p = f.txn({ pending: true });
  assert.equal(p.pending, true);
});

test('on recorded Sandbox data: robust passes every scenario, each bug is still caught', async () => {
  const { transactions } = await readCassette(CASSETTE);
  for (const s of SCENARIOS) {
    for (const seed of [1, 2, 3]) {
      const r = await runScenario(target(), s, seed, transactions);
      assert.equal(r.source, 'recorded');
      assert.ok(r.passed, `${s.id} seed ${seed}: ${r.invariants.filter((i) => !i.passed).map((i) => i.message).join('; ')}`);
    }
  }
  const matrix: Array<[keyof Bugs, string]> = [
    ['ignoreRemoved', 'pending-to-posted'],
    ['noRestartOnMutation', 'mutation-during-pagination'],
    ['trustWebhookOrder', 'out-of-order-item-events'],
    ['ignoreLoginRepaired', 'login-required-then-repaired'],
  ];
  for (const [bug, id] of matrix) {
    const r = await runScenario(target({ [bug]: true }), getScenario(id), 1, transactions);
    assert.equal(r.passed, false, `${bug} on recorded data`);
  }
});

/** Plaid Sandbox stand-in backed by the fake bank. */
function stubSandbox(seedTxns: Transaction[]) {
  const bank = new FakeBank(100);
  let n = 0;
  let refreshes = 0;
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof FakePlaidError) throw new PlaidHttpError('/stub', e.body);
      throw e;
    }
  };
  const api = {
    async createItem() {
      n += 1;
      const itemId = `real_item_${n}`;
      const accessToken = `access-sandbox-real-${n}`;
      bank.createItem(itemId, accessToken);
      bank.apply(itemId, seedTxns.map((t) => ({ op: 'add' as const, txn: t })));
      return { itemId, accessToken };
    },
    async transactionsSync(req: TransactionsSyncRequest) {
      return wrap(() => bank.transactionsSync(req));
    },
    async itemGet(token: string) {
      return wrap(() => bank.itemGet({ access_token: token }));
    },
    async drain(token: string) {
      const byId = new Map<string, Transaction>();
      let cursor = '';
      for (;;) {
        const p = wrap(() => bank.transactionsSync({ access_token: token, cursor, count: 500 }));
        for (const t of [...p.added, ...p.modified]) byId.set(t.transaction_id, t);
        for (const r of p.removed) byId.delete(r.transaction_id);
        cursor = p.next_cursor;
        if (!p.has_more) return { transactions: [...byId.values()], status: 'HISTORICAL_UPDATE_COMPLETE', cursor, pages: 1 };
      }
    },
    async refreshAndWait(token: string, before: Transaction[]) {
      refreshes += 1;
      const itemId = bank.itemIds().find((id) => bank.itemGet({ access_token: token }).item.item_id === id)!;
      const pending = before.filter((t) => t.pending);
      bank.apply(itemId, [
        ...pending.map((p) => ({ op: 'post' as const, pending_id: p.transaction_id, posted: { ...p, transaction_id: `${p.transaction_id}_posted` } })),
        { op: 'add', txn: txn(`created_${refreshes}`, 9.99) },
      ]);
      return { transactions: bank.truth(itemId), changed: true, attempts: 1 };
    },
    async createTransactions() {
      return {};
    },
    async resetLogin(token: string) {
      const itemId = bank.itemGet({ access_token: token }).item.item_id;
      bank.setItemError(itemId, 'ITEM_LOGIN_REQUIRED');
      return { reset_login: true };
    },
    async removeItem() {
      return {};
    },
  };
  return api as unknown as SandboxApi;
}

const seedTxns = [txn('s1', 12), txn('s2', 40), txn('s3', 7.5, { pending: true }), txn('s4', 3.2, { pending: true })];

test('sandbox runner: robust app passes every Sandbox scenario (stubbed Sandbox)', async () => {
  for (const scenario of SANDBOX_SCENARIOS) {
    const r = await runSandboxScenario({ api: stubSandbox(seedTxns), target: target(), scenario, seed: 1 });
    assert.equal(r.source, 'sandbox');
    assert.ok(r.passed, `${scenario.id}: ${r.invariants.filter((i) => !i.passed).map((i) => i.message).join('; ')}`);
  }
});

test('sandbox runner: each targeted bug is caught by its Sandbox scenario (stubbed Sandbox)', async () => {
  const matrix: Array<[keyof Bugs, string]> = [
    ['ignoreRemoved', 'sandbox-pending-to-posted'],
    ['nonIdempotentWrites', 'sandbox-duplicate-webhook'],
    ['trustWebhookOrder', 'sandbox-login-required'],
    ['clearDataOnSyncError', 'sandbox-login-required'],
    ['noReconcile', 'sandbox-missed-webhook'],
  ];
  for (const [bug, id] of matrix) {
    const scenario = SANDBOX_SCENARIOS.find((s) => s.id === id)!;
    const r = await runSandboxScenario({ api: stubSandbox(seedTxns), target: target({ [bug]: true }), scenario, seed: 1 });
    assert.equal(r.passed, false, `${bug} not caught by ${id}`);
  }
});

test('a Sandbox run records a fixture that replays offline with the same verdicts and no real ids', async () => {
  for (const [bugs, id] of [[{ ignoreRemoved: true }, 'sandbox-pending-to-posted'], [{}, 'sandbox-login-required']] as const) {
    const scenario = SANDBOX_SCENARIOS.find((s) => s.id === id)!;
    const live = await runSandboxScenario({ api: stubSandbox(seedTxns), target: target(bugs), scenario, seed: 1 });
    const fixture = toFixture(live, scenario);
    const json = JSON.stringify(fixture);
    assert.doesNotMatch(json, /real_item_|access-sandbox-real-/, 'real item ids and access tokens are replaced');
    assert.equal(fixture.source, 'sandbox');
    const offline = await replay(fixture, target(bugs));
    const verdicts = (r: typeof live) => r.invariants.map((i) => `${i.at}/${i.id}/${i.passed}`);
    assert.deepEqual(verdicts(offline), verdicts(live), id);
    assert.equal(offline.source, 'recorded');
  }
});

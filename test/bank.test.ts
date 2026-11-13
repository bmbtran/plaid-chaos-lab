import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeBank, decodeCursor, encodeCursor } from '../src/fake-plaid/bank.ts';
import { FakePlaidClient } from '../src/fake-plaid/client.ts';
import { FakePlaidError } from '../src/fake-plaid/errors.ts';
import type { Transaction } from '../src/types.ts';

const TOKEN = 'access-sandbox-test';
const ITEM = 'item_test';

function txn(id: string, amount: number, extra: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: id,
    account_id: 'acc',
    amount,
    iso_currency_code: 'USD',
    date: '2026-10-01',
    name: id,
    merchant_name: id,
    pending: false,
    pending_transaction_id: null,
    ...extra,
  };
}

function bank(pageSize = 100) {
  const b = new FakeBank(pageSize);
  b.createItem(ITEM, TOKEN);
  return b;
}

/** Drain a full sync loop from `cursor`. */
function drain(b: FakeBank, cursor = '') {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  let pages = 0;
  for (;;) {
    const r = b.transactionsSync({ access_token: TOKEN, cursor });
    pages += 1;
    added.push(...r.added.map((t) => t.transaction_id));
    modified.push(...r.modified.map((t) => t.transaction_id));
    removed.push(...r.removed.map((t) => t.transaction_id));
    cursor = r.next_cursor;
    if (!r.has_more) return { added, modified, removed, cursor, pages };
  }
}

test('sync from "" returns full history; from a version cursor returns the exact diff', () => {
  const b = bank();
  b.apply(ITEM, [{ op: 'add', txn: txn('a', 1) }, { op: 'add', txn: txn('b', 2) }]);
  const first = drain(b);
  assert.deepEqual(first.added.sort(), ['a', 'b']);

  b.apply(ITEM, [
    { op: 'modify', transaction_id: 'a', changes: { amount: 5 } },
    { op: 'remove', transaction_id: 'b' },
    { op: 'add', txn: txn('c', 3) },
  ]);
  const second = drain(b, first.cursor);
  assert.deepEqual(second, { added: ['c'], modified: ['a'], removed: ['b'], cursor: second.cursor, pages: 1 });
  assert.deepEqual(drain(b, second.cursor), { added: [], modified: [], removed: [], cursor: second.cursor, pages: 1 });
});

test('pending → posted is a removal plus an addition with pending_transaction_id', () => {
  const b = bank();
  b.apply(ITEM, [{ op: 'add', txn: txn('p', 4.5, { pending: true }) }]);
  const c1 = drain(b).cursor;
  b.apply(ITEM, [{ op: 'post', pending_id: 'p', posted: txn('t', 5.4) }]);
  const r = b.transactionsSync({ access_token: TOKEN, cursor: c1 });
  assert.equal(r.added[0].transaction_id, 't');
  assert.equal(r.added[0].pending_transaction_id, 'p');
  assert.equal(r.added[0].pending, false);
  assert.deepEqual(r.removed, [{ transaction_id: 'p', account_id: 'acc' }]);
  assert.equal(b.replacements.get('t'), 'p');
});

test('pagination honors min(count, pageSize) and only the last page returns a version cursor', () => {
  const b = bank(2);
  b.apply(ITEM, ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ op: 'add' as const, txn: txn(id, i + 1) })));
  const p1 = b.transactionsSync({ access_token: TOKEN, cursor: '', count: 100 });
  assert.equal(p1.added.length, 2);
  assert.equal(p1.has_more, true);
  assert.equal(decodeCursor(p1.next_cursor).kind, 'page');
  const all = drain(b);
  assert.equal(all.pages, 3);
  assert.deepEqual(decodeCursor(all.cursor), { kind: 'version', version: 1 });
  const small = b.transactionsSync({ access_token: TOKEN, cursor: '', count: 1 });
  assert.equal(small.added.length, 1, 'requested count smaller than the cap wins');
});

test('mutation while paginating invalidates page cursors; the original cursor still works', () => {
  const b = bank(1);
  b.apply(ITEM, [{ op: 'add', txn: txn('a', 1) }, { op: 'add', txn: txn('b', 2) }, { op: 'add', txn: txn('c', 3) }]);
  const p1 = b.transactionsSync({ access_token: TOKEN, cursor: '' });
  b.apply(ITEM, [{ op: 'remove', transaction_id: 'a' }]);
  assert.throws(
    () => b.transactionsSync({ access_token: TOKEN, cursor: p1.next_cursor }),
    (e: unknown) => e instanceof FakePlaidError && e.body.error_code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && e.body.status === 400,
  );
  const restarted = drain(b, '');
  assert.deepEqual(restarted.added.sort(), ['b', 'c'], 'restart sees the new truth; the removed txn never appears');
});

test('armed mutation fires after the configured page and only while more pages remain', () => {
  const b = bank(1);
  b.apply(ITEM, [{ op: 'add', txn: txn('a', 1) }, { op: 'add', txn: txn('b', 2) }, { op: 'add', txn: txn('c', 3) }]);
  b.arm(ITEM, 2, [{ op: 'add', txn: txn('z', 9) }]);
  const p1 = b.transactionsSync({ access_token: TOKEN, cursor: '' });
  assert.equal(b.version(ITEM), 1);
  const p2 = b.transactionsSync({ access_token: TOKEN, cursor: p1.next_cursor });
  assert.equal(b.version(ITEM), 2, 'fires right after page 2 is served');
  assert.equal(b.hasArmed(ITEM), false);
  assert.throws(() => b.transactionsSync({ access_token: TOKEN, cursor: p2.next_cursor }), /MUTATION_DURING_PAGINATION/);
});

test('ITEM_LOGIN_REQUIRED makes sync fail and is reflected by /item/get', () => {
  const b = bank();
  b.setItemError(ITEM, 'ITEM_LOGIN_REQUIRED');
  assert.throws(() => b.transactionsSync({ access_token: TOKEN, cursor: '' }), /ITEM_LOGIN_REQUIRED/);
  assert.equal(b.itemGet({ access_token: TOKEN }).item.error?.error_code, 'ITEM_LOGIN_REQUIRED');
  assert.equal(b.itemStatus(ITEM), 'login_required');
  b.setItemError(ITEM, null);
  assert.equal(b.itemGet({ access_token: TOKEN }).item.error, null);
  assert.doesNotThrow(() => b.transactionsSync({ access_token: TOKEN, cursor: '' }));
});

test('unknown access token and malformed cursor produce Plaid errors', () => {
  const b = bank();
  assert.throws(() => b.transactionsSync({ access_token: 'nope', cursor: '' }), /INVALID_ACCESS_TOKEN/);
  assert.throws(() => b.transactionsSync({ access_token: TOKEN, cursor: 'garbage!!' }), /INVALID_FIELD/);
  assert.throws(() => b.transactionsSync({ access_token: TOKEN, cursor: encodeCursor({ kind: 'version', version: 99 }) }), /INVALID_FIELD/);
});

test('in-process client throws axios-shaped errors like plaid/legacy', async () => {
  const b = bank();
  b.setItemError(ITEM, 'ITEM_LOGIN_REQUIRED');
  const client = new FakePlaidClient(b, 1);
  await assert.rejects(client.transactionsSync({ access_token: TOKEN, cursor: '' }), (err: any) => {
    assert.equal(err.isAxiosError, true);
    assert.equal(err.response.status, 400);
    assert.equal(err.response.data.error_code, 'ITEM_LOGIN_REQUIRED');
    assert.equal(err.response.data.error_type, 'ITEM_ERROR');
    return true;
  });
  assert.equal(b.inflight, 0);
});

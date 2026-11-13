/**
 * A small but realistic Plaid Transactions integration, the kind you'd find
 * behind a budgeting app's webhook endpoint. Every common mistake the Chaos Lab
 * looks for can be switched on individually, which lets the test suite prove
 * that each scenario catches the bug it targets.
 *
 * With no bugs enabled this is a correct reference implementation:
 *   - per-Item serialization of sync work (duplicate webhooks are harmless)
 *   - upsert by transaction_id, apply `removed`
 *   - drain every page, commit the cursor only after the whole loop succeeds
 *   - restart from the original cursor on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION
 *   - derive Item health from /item/get, not from webhook arrival order
 *   - keep data during ITEM_LOGIN_REQUIRED; honor LOGIN_REPAIRED
 *   - a reconcile() job for missed webhooks
 */
import type {
  AppStateSnapshot,
  IntegrationAdapter,
  ItemStatus,
  PlaidClientLike,
  PlaidWebhook,
  RemovedTransaction,
  Transaction,
} from '../src/types.ts';

export interface Bugs {
  /** Only handles `added`/`modified`; ignores `removed`. */
  ignoreRemoved: boolean;
  /** Processes webhooks for the same Item concurrently and appends rows instead of upserting. */
  nonIdempotentWrites: boolean;
  /** Sets Item health from whichever ITEM webhook arrived last. */
  trustWebhookOrder: boolean;
  /** Reads only the first page of /transactions/sync. */
  ignoreHasMore: boolean;
  /** Applies + commits each page as it arrives and retries the failed page on a mutation error. */
  noRestartOnMutation: boolean;
  /** Never clears the "reconnect your bank" state on LOGIN_REPAIRED. */
  ignoreLoginRepaired: boolean;
  /** Wipes stored transactions and cursor when sync fails, planning to "resync from scratch". */
  clearDataOnSyncError: boolean;
  /** Has no periodic reconciliation job. */
  noReconcile: boolean;
}

export const BUG_DESCRIPTIONS: Record<keyof Bugs, string> = {
  ignoreRemoved: 'ignores `removed` from /transactions/sync',
  nonIdempotentWrites: 'handles duplicate webhooks concurrently and appends instead of upserting',
  trustWebhookOrder: 'derives Item health from webhook arrival order',
  ignoreHasMore: 'reads only the first sync page',
  noRestartOnMutation: 'commits per page and retries the failed page on mutation errors',
  ignoreLoginRepaired: 'ignores LOGIN_REPAIRED',
  clearDataOnSyncError: 'wipes data when sync fails',
  noReconcile: 'has no reconciliation job',
};

export const NO_BUGS: Bugs = {
  ignoreRemoved: false,
  nonIdempotentWrites: false,
  trustWebhookOrder: false,
  ignoreHasMore: false,
  noRestartOnMutation: false,
  ignoreLoginRepaired: false,
  clearDataOnSyncError: false,
  noReconcile: false,
};

export const ALL_BUGS: Bugs = Object.fromEntries(Object.keys(NO_BUGS).map((k) => [k, true])) as unknown as Bugs;

const MUTATION = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
const LOGIN_REQUIRED = 'ITEM_LOGIN_REQUIRED';

interface Row {
  transaction_id: string;
  amount: number;
  date: string;
  pending: boolean;
  name: string;
}

interface StoredItem {
  itemId: string;
  accessToken: string;
  cursor: string;
  status: ItemStatus;
  rows: Row[];
}

/** Works with both SDK styles: legacy axios errors and the v51 `PlaidError` (`.body`). */
export function plaidErrorCode(err: unknown): string | undefined {
  const e = err as { response?: { data?: { error_code?: string } }; body?: { error_code?: string } };
  return e?.response?.data?.error_code ?? e?.body?.error_code;
}

const toRow = (t: Transaction): Row => ({
  transaction_id: t.transaction_id,
  amount: t.amount,
  date: t.date,
  pending: t.pending,
  name: t.merchant_name ?? t.name,
});

export function createReferenceApp(plaid: PlaidClientLike, bugs: Partial<Bugs> = {}): IntegrationAdapter {
  const b: Bugs = { ...NO_BUGS, ...bugs };
  const items = new Map<string, StoredItem>();
  const queues = new Map<string, Promise<unknown>>();

  /** Serialize work per Item (unless the bug is on). */
  function serialized<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
    if (b.nonIdempotentWrites) return fn();
    const prev = queues.get(itemId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    queues.set(itemId, run.catch(() => undefined));
    return run;
  }

  function getItem(itemId: string): StoredItem {
    const item = items.get(itemId);
    if (!item) throw new Error(`webhook for unknown item ${itemId}`);
    return item;
  }

  function upsert(item: StoredItem, t: Transaction): void {
    const row = toRow(t);
    const i = item.rows.findIndex((r) => r.transaction_id === row.transaction_id);
    if (b.nonIdempotentWrites || i === -1) item.rows.push(row);
    else item.rows[i] = row;
  }

  function update(item: StoredItem, t: Transaction): void {
    const i = item.rows.findIndex((r) => r.transaction_id === t.transaction_id);
    if (i === -1) item.rows.push(toRow(t));
    else item.rows[i] = toRow(t);
  }

  function apply(item: StoredItem, added: Transaction[], modified: Transaction[], removed: RemovedTransaction[]): void {
    for (const t of added) upsert(item, t);
    for (const t of modified) update(item, t);
    if (!b.ignoreRemoved) {
      const gone = new Set(removed.map((r) => r.transaction_id));
      item.rows = item.rows.filter((r) => !gone.has(r.transaction_id));
    }
  }

  function onLoginRequired(item: StoredItem): void {
    item.status = 'login_required';
    if (b.clearDataOnSyncError) {
      item.rows = [];
      item.cursor = '';
    }
  }

  async function syncCorrectly(item: StoredItem): Promise<void> {
    const original = item.cursor;
    for (let attempt = 0; attempt < 5; attempt++) {
      let cursor = original;
      const added: Transaction[] = [];
      const modified: Transaction[] = [];
      const removed: RemovedTransaction[] = [];
      try {
        for (;;) {
          const { data } = await plaid.transactionsSync({ access_token: item.accessToken, cursor, count: 100 });
          added.push(...data.added);
          modified.push(...data.modified);
          removed.push(...data.removed);
          cursor = data.next_cursor;
          if (!data.has_more || b.ignoreHasMore) break;
        }
      } catch (err) {
        const code = plaidErrorCode(err);
        if (code === MUTATION) continue; // restart the whole loop from `original`
        if (code === LOGIN_REQUIRED) return onLoginRequired(item);
        throw err;
      }
      apply(item, added, modified, removed);
      item.cursor = cursor;
      return;
    }
    throw new Error('transactions sync kept mutating during pagination');
  }

  /** The buggy variant: commit each page immediately; retry the page that failed. */
  async function syncPageByPage(item: StoredItem): Promise<void> {
    let retries = 0;
    for (;;) {
      let data;
      try {
        ({ data } = await plaid.transactionsSync({ access_token: item.accessToken, cursor: item.cursor, count: 100 }));
      } catch (err) {
        const code = plaidErrorCode(err);
        if (code === MUTATION && retries < 2) {
          retries += 1;
          continue;
        }
        if (code === LOGIN_REQUIRED) return onLoginRequired(item);
        throw err;
      }
      apply(item, data.added, data.modified, data.removed);
      item.cursor = data.next_cursor;
      if (!data.has_more || b.ignoreHasMore) return;
    }
  }

  const sync = (item: StoredItem) => (b.noRestartOnMutation ? syncPageByPage(item) : syncCorrectly(item));

  async function refreshStatus(item: StoredItem): Promise<void> {
    const { data } = await plaid.itemGet({ access_token: item.accessToken });
    item.status = data.item.error?.error_code === LOGIN_REQUIRED ? 'login_required' : 'healthy';
  }

  const app: IntegrationAdapter = {
    async registerItem({ itemId, accessToken }) {
      items.set(itemId, { itemId, accessToken, cursor: '', status: 'healthy', rows: [] });
    },

    async handleWebhook(body: PlaidWebhook) {
      const item = getItem(body.item_id);
      if (body.webhook_type === 'TRANSACTIONS' && body.webhook_code === 'SYNC_UPDATES_AVAILABLE') {
        await serialized(item.itemId, () => sync(item));
        return;
      }
      if (body.webhook_type === 'ITEM') {
        if (body.webhook_code === 'LOGIN_REPAIRED' && b.ignoreLoginRepaired) return;
        if (b.trustWebhookOrder) {
          if (body.webhook_code === 'ERROR' && body.error.error_code === LOGIN_REQUIRED) item.status = 'login_required';
          if (body.webhook_code === 'LOGIN_REPAIRED') item.status = 'healthy';
          return;
        }
        // Webhooks are hints; /item/get is the source of truth.
        await serialized(item.itemId, () => refreshStatus(item));
      }
    },

    async getState(itemId): Promise<AppStateSnapshot> {
      const item = getItem(itemId);
      return { transactions: item.rows.map((r) => ({ ...r })), itemStatus: item.status, cursor: item.cursor };
    },
  };

  if (!b.noReconcile) {
    app.reconcile = async (itemId) => {
      const item = getItem(itemId);
      await serialized(itemId, async () => {
        await refreshStatus(item);
        if (item.status === 'healthy') await sync(item);
      });
    };
  }

  return app;
}

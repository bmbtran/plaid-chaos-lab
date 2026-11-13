import type { BankOp, Scenario, Step } from '../types.ts';
import { LEDGER_CHECKS } from '../engine/invariants.ts';
import {
  adds,
  DataFactory,
  initialSync,
  ITEM_ID,
  itemErrorWebhook,
  loginRepairedWebhook,
  syncWebhook,
} from './helpers.ts';

const DOCS = {
  pendingPosted: 'https://plaid.com/docs/transactions/transactions-data/#pending-and-posted-transactions',
  sync: 'https://plaid.com/docs/api/products/transactions/#transactionssync',
  mutation: 'https://plaid.com/docs/errors/transactions/#transactions_sync_mutation_during_pagination',
  webhooks: 'https://plaid.com/docs/api/webhooks/',
  itemErrors: 'https://plaid.com/docs/api/items/#error',
  loginRepaired: 'https://plaid.com/docs/api/items/#login_repaired',
  itemGet: 'https://plaid.com/docs/api/items/#itemget',
};

const pendingToPosted: Scenario = {
  id: 'pending-to-posted',
  title: 'Pending → posted replacement',
  summary:
    'Pending transactions post. Plaid removes the pending transaction and adds a new posted one (new id, pending_transaction_id set, amount may change, e.g. a tip). A small page size pushes the removal onto a later page than the addition.',
  whyItMatters: 'Apps that only handle `added` show the purchase twice and overstate spending.',
  docs: [DOCS.pendingPosted, DOCS.sync],
  finalChecks: LEDGER_CHECKS,
  build(seed, pool) {
    const f = new DataFactory(seed, pool);
    const posted = f.many(f.rng.int(2, 4));
    const pending = f.many(f.rng.int(1, 2), { pending: true });
    const postOps: BankOp[] = pending.map((p) => ({
      op: 'post',
      pending_id: p.transaction_id,
      posted: f.posted(p, { amountChange: f.rng.next() < 0.5 }),
    }));
    const extra = f.many(f.rng.int(0, 2));
    return {
      pageSize: f.rng.int(1, 3),
      steps: [
        ...initialSync([...posted, ...pending]),
        { type: 'bank', item_id: ITEM_ID, ops: [...postOps, ...adds(extra)], note: 'pending transactions post' },
        { type: 'webhook', payload: syncWebhook() },
      ],
    };
  },
};

const duplicateWebhook: Scenario = {
  id: 'duplicate-webhook-delivery',
  title: 'Duplicate webhook delivery',
  summary:
    'The same SYNC_UPDATES_AVAILABLE webhook is delivered twice at the same time (Plaid retried because the first delivery looked slow), then once more as a late retry.',
  whyItMatters:
    'Plaid tells you to handle duplicate webhooks. Handlers that run concurrently and append rows end up with the same transactions twice.',
  docs: [DOCS.webhooks],
  finalChecks: LEDGER_CHECKS,
  build(seed, pool) {
    const f = new DataFactory(seed, pool);
    const initial = f.many(f.rng.int(2, 4));
    const fresh = f.many(f.rng.int(2, 5));
    return {
      pageSize: f.rng.int(1, 4),
      steps: [
        ...initialSync(initial),
        { type: 'bank', item_id: ITEM_ID, ops: adds(fresh), note: 'new transactions' },
        {
          type: 'concurrent',
          note: 'Plaid redelivers while the first delivery is still being handled',
          steps: [
            { type: 'webhook', payload: syncWebhook(), note: 'delivery #1' },
            { type: 'webhook', payload: syncWebhook(), note: 'delivery #2 (duplicate)' },
          ],
        },
        { type: 'webhook', payload: syncWebhook(), note: 'late retry (duplicate)' },
      ],
    };
  },
};

const outOfOrderItemEvents: Scenario = {
  id: 'out-of-order-item-events',
  title: 'Stale / out-of-order Item events',
  summary:
    'The Item breaks (ITEM_LOGIN_REQUIRED) and is repaired. The LOGIN_REPAIRED webhook arrives first and the older ERROR webhook arrives after it.',
  whyItMatters:
    'Plaid does not guarantee webhook order. An app that sets Item health from whichever webhook came last tells a healthy user to reconnect their bank. Re-read the state with /item/get instead.',
  docs: [DOCS.webhooks, DOCS.itemGet],
  finalChecks: [...LEDGER_CHECKS, 'item-status-matches'],
  build(seed, pool) {
    const f = new DataFactory(seed, pool);
    const initial = f.many(f.rng.int(2, 4));
    const concurrent = seed % 3 === 0;
    const deliveries: Step[] = [
      { type: 'webhook', payload: loginRepairedWebhook(), note: 'LOGIN_REPAIRED (newer event)' },
      { type: 'webhook', payload: itemErrorWebhook(), note: 'ERROR ITEM_LOGIN_REQUIRED (stale, delivered late)' },
    ];
    return {
      pageSize: f.rng.int(2, 4),
      steps: [
        ...initialSync(initial),
        { type: 'item-error', item_id: ITEM_ID, error_code: 'ITEM_LOGIN_REQUIRED', note: 'user changed their bank password' },
        { type: 'item-error', item_id: ITEM_ID, error_code: null, note: 'login repaired' },
        ...(concurrent
          ? [{ type: 'concurrent', steps: deliveries, note: 'both webhooks arrive together' } as Step]
          : deliveries),
      ],
    };
  },
};

const paginatedSync: Scenario = {
  id: 'paginated-sync',
  title: 'SYNC_UPDATES_AVAILABLE with paginated /transactions/sync',
  summary:
    'The initial history and a later update each span several pages (has_more=true). The update modifies amounts, removes a reversed charge, and adds new transactions.',
  whyItMatters: 'Code that reads one page drops transactions and keeps stale amounts.',
  docs: [DOCS.sync],
  finalChecks: LEDGER_CHECKS,
  build(seed, pool) {
    const f = new DataFactory(seed, pool);
    const initial = [...f.many(f.rng.int(6, 10)), ...f.many(f.rng.int(1, 2), { pending: true })];
    const settled = initial.filter((t) => !t.pending);
    const modified = settled.slice(0, f.rng.int(1, 2));
    const reversed = settled[settled.length - 1];
    const fresh = f.many(f.rng.int(3, 6));
    return {
      pageSize: f.rng.int(2, 3),
      steps: [
        ...initialSync(initial),
        {
          type: 'bank',
          item_id: ITEM_ID,
          note: 'amounts corrected, a charge reversed, new activity',
          ops: [
            ...modified.map((t): BankOp => ({ op: 'modify', transaction_id: t.transaction_id, changes: { amount: Math.round((t.amount + 1.25) * 100) / 100 } })),
            { op: 'remove', transaction_id: reversed.transaction_id },
            ...adds(fresh),
          ],
        },
        { type: 'webhook', payload: syncWebhook() },
      ],
    };
  },
};

const mutationDuringPagination: Scenario = {
  id: 'mutation-during-pagination',
  title: 'Sync mutation during pagination',
  summary:
    "The data changes after page k of a paginated sync, and the next page returns TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION. One transaction already served on page 1 has since been removed. The app has to throw away the partial pages and restart the loop from the loop's original cursor.",
  whyItMatters:
    'Retrying only the failed page loops on the error. Keeping the partial pages leaves phantom transactions that no longer exist.',
  docs: [DOCS.mutation, DOCS.sync],
  finalChecks: [...LEDGER_CHECKS, 'sync-restarts-from-original-cursor'],
  build(seed, pool) {
    const f = new DataFactory(seed, pool);
    const initial = f.many(f.rng.int(2, 3));
    const batch = f.many(f.rng.int(4, 7));
    const pageSize = f.rng.int(1, Math.floor(batch.length / 2));
    const pages = Math.ceil(batch.length / pageSize);
    const afterPage = f.rng.int(1, pages - 1);
    const [removedLater, modifiedLater] = batch;
    const late = f.txn();
    return {
      pageSize,
      steps: [
        ...initialSync(initial),
        { type: 'bank', item_id: ITEM_ID, ops: adds(batch), note: 'new activity' },
        {
          type: 'arm-mutation',
          item_id: ITEM_ID,
          after_page: afterPage,
          note: `bank data changes after page ${afterPage} is served`,
          ops: [
            { op: 'remove', transaction_id: removedLater.transaction_id },
            { op: 'modify', transaction_id: modifiedLater.transaction_id, changes: { amount: Math.round((modifiedLater.amount + 2.5) * 100) / 100 } },
            { op: 'add', txn: late },
          ],
        },
        { type: 'webhook', payload: syncWebhook() },
      ],
    };
  },
};

const loginRequiredThenRepaired: Scenario = {
  id: 'login-required-then-repaired',
  title: 'ITEM_LOGIN_REQUIRED → LOGIN_REPAIRED',
  summary:
    'The Item needs re-authentication, so /transactions/sync returns ITEM_LOGIN_REQUIRED, and a stale sync webhook arrives during the outage. The login is then repaired outside the app (LOGIN_REPAIRED) and new transactions arrive.',
  whyItMatters:
    'During the outage the user should see a reconnect prompt and keep their existing data. Afterwards the prompt should clear and syncing should resume.',
  docs: [DOCS.itemErrors, DOCS.loginRepaired],
  finalChecks: [...LEDGER_CHECKS, 'item-status-matches'],
  build(seed, pool) {
    const f = new DataFactory(seed, pool);
    const initial = f.many(f.rng.int(3, 5));
    const fresh = f.many(f.rng.int(2, 4));
    return {
      pageSize: f.rng.int(2, 4),
      steps: [
        ...initialSync(initial),
        { type: 'item-error', item_id: ITEM_ID, error_code: 'ITEM_LOGIN_REQUIRED', note: 'bank requires re-authentication' },
        { type: 'webhook', payload: itemErrorWebhook() },
        { type: 'webhook', payload: syncWebhook(), note: 'stale SYNC_UPDATES_AVAILABLE retried during the outage' },
        { type: 'checkpoint', label: 'during outage', checks: [...LEDGER_CHECKS, 'item-status-matches'] },
        { type: 'item-error', item_id: ITEM_ID, error_code: null, note: 'user re-authenticated outside your app' },
        { type: 'bank', item_id: ITEM_ID, ops: adds(fresh), note: 'activity resumes' },
        { type: 'webhook', payload: loginRepairedWebhook() },
        { type: 'webhook', payload: syncWebhook() },
      ],
    };
  },
};

const missedWebhookReconcile: Scenario = {
  id: 'missed-webhook-reconcile',
  title: 'Missed webhook → reconciliation job',
  summary:
    'A SYNC_UPDATES_AVAILABLE webhook is never delivered (endpoint down past the retry window) and no further webhook arrives. The only way to recover is the app\'s own periodic sync, `reconcile()`.',
  whyItMatters:
    'Webhooks can go missing. An app with no scheduled catch-up sync never shows those transactions.',
  docs: [DOCS.webhooks, DOCS.sync],
  finalChecks: LEDGER_CHECKS,
  build(seed, pool) {
    const f = new DataFactory(seed, pool);
    const initial = f.many(f.rng.int(2, 4));
    const fresh = f.many(f.rng.int(2, 5));
    return {
      pageSize: f.rng.int(1, 4),
      steps: [
        ...initialSync(initial),
        { type: 'bank', item_id: ITEM_ID, ops: adds(fresh), note: 'new activity' },
        { type: 'drop-webhook', payload: syncWebhook(), note: 'delivery failed for 24h; Plaid gave up' },
        { type: 'reconcile', item_id: ITEM_ID, note: 'scheduled sync job runs' },
      ],
    };
  },
};

const missedWebhookCatchup: Scenario = {
  id: 'missed-webhook-catchup',
  title: 'Missed webhook → cursor catch-up',
  summary:
    'One SYNC_UPDATES_AVAILABLE is dropped and a later one is delivered. Syncing from the stored cursor picks up both batches, including a pending transaction that posted in between. This is the control case: it shows the recovery that cursor-based sync gives you for free.',
  whyItMatters: 'Apps that sync from their stored cursor recover from missed webhooks automatically. Apps that do anything else do not.',
  docs: [DOCS.sync],
  finalChecks: LEDGER_CHECKS,
  build(seed, pool) {
    const f = new DataFactory(seed, pool);
    const initial = f.many(f.rng.int(2, 3));
    const pending = f.txn({ pending: true });
    const batchA = f.many(f.rng.int(1, 3));
    const batchB = f.many(f.rng.int(1, 3));
    return {
      pageSize: f.rng.int(2, 4),
      steps: [
        ...initialSync(initial),
        { type: 'bank', item_id: ITEM_ID, ops: adds([...batchA, pending]), note: 'batch A' },
        { type: 'drop-webhook', payload: syncWebhook(), note: 'batch A webhook lost' },
        {
          type: 'bank',
          item_id: ITEM_ID,
          note: 'batch B (includes A\'s pending transaction posting)',
          ops: [...adds(batchB), { op: 'post', pending_id: pending.transaction_id, posted: f.posted(pending) }],
        },
        { type: 'webhook', payload: syncWebhook(), note: 'batch B webhook delivered' },
      ],
    };
  },
};

export const SCENARIOS: Scenario[] = [
  pendingToPosted,
  duplicateWebhook,
  outOfOrderItemEvents,
  paginatedSync,
  mutationDuringPagination,
  loginRequiredThenRepaired,
  missedWebhookReconcile,
  missedWebhookCatchup,
];

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scenario "${id}". Known: ${SCENARIOS.map((x) => x.id).join(', ')}`);
  return s;
}

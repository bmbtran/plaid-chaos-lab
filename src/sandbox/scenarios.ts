import type { InvariantId, ScenarioMeta } from '../types.ts';
import { LEDGER_CHECKS } from '../engine/invariants.ts';

/** Steps that drive real Plaid Sandbox. */
export type SandboxStep =
  | { type: 'create-item'; note?: string }
  | { type: 'create-transactions'; count: number; note?: string }
  | { type: 'refresh'; note?: string }
  | { type: 'reset-login'; note?: string }
  | { type: 'webhook'; code: 'SYNC_UPDATES_AVAILABLE' | 'ERROR' | 'LOGIN_REPAIRED'; note?: string }
  | { type: 'drop-webhook'; code: 'SYNC_UPDATES_AVAILABLE'; note?: string }
  | { type: 'concurrent'; steps: SandboxStep[]; note?: string }
  | { type: 'reconcile'; note?: string }
  | { type: 'checkpoint'; label: string; checks: InvariantId[] };

export interface SandboxScenario extends ScenarioMeta {
  steps: SandboxStep[];
}

const DOCS = {
  sync: 'https://plaid.com/docs/api/products/transactions/#transactionssync',
  pendingPosted: 'https://plaid.com/docs/transactions/transactions-data/#pending-and-posted-transactions',
  webhooks: 'https://plaid.com/docs/api/webhooks/',
  resetLogin: 'https://plaid.com/docs/api/sandbox/#sandboxitemreset_login',
  itemGet: 'https://plaid.com/docs/api/items/#itemget',
};

const setup: SandboxStep[] = [
  { type: 'create-item', note: 'user_transactions_dynamic' },
  { type: 'webhook', code: 'SYNC_UPDATES_AVAILABLE', note: 'initial update' },
  { type: 'checkpoint', label: 'after initial sync', checks: LEDGER_CHECKS },
];

/**
 * Scenarios Plaid Sandbox can reproduce for real. The rest of the catalog
 * runs on the fake bank, using transactions recorded from Sandbox.
 */
export const SANDBOX_SCENARIOS: SandboxScenario[] = [
  {
    id: 'sandbox-initial-sync',
    title: 'Initial sync of a real Sandbox Item',
    summary:
      'A real Item with a few hundred transactions over several accounts. With count=100, /transactions/sync really paginates.',
    whyItMatters: 'The first sync is the largest. Code that reads one page loses most of the history.',
    docs: [DOCS.sync],
    finalChecks: LEDGER_CHECKS,
    steps: [...setup],
  },
  {
    id: 'sandbox-pending-to-posted',
    title: 'Real pending → posted transitions',
    summary:
      '/transactions/refresh on user_transactions_dynamic posts the pending transactions. Plaid removes each pending one and adds a posted one with pending_transaction_id set, and also adds new pending transactions.',
    whyItMatters: 'If the app ignores `removed`, every posted purchase shows up twice.',
    docs: [DOCS.pendingPosted],
    finalChecks: LEDGER_CHECKS,
    steps: [...setup, { type: 'refresh', note: 'pending transactions post' }, { type: 'webhook', code: 'SYNC_UPDATES_AVAILABLE' }],
  },
  {
    id: 'sandbox-duplicate-webhook',
    title: 'Duplicate delivery after real new activity',
    summary:
      'New transactions are created with /sandbox/transactions/create and refreshed in. The webhook is then delivered twice at once, followed by a late retry.',
    whyItMatters: 'Two concurrent syncs from the same cursor return the same updates. Writes that are not idempotent duplicate them.',
    docs: [DOCS.webhooks],
    finalChecks: LEDGER_CHECKS,
    steps: [
      ...setup,
      { type: 'create-transactions', count: 3 },
      { type: 'refresh' },
      {
        type: 'concurrent',
        note: 'redelivery while the first delivery is still being handled',
        steps: [
          { type: 'webhook', code: 'SYNC_UPDATES_AVAILABLE', note: 'delivery #1' },
          { type: 'webhook', code: 'SYNC_UPDATES_AVAILABLE', note: 'delivery #2 (duplicate)' },
        ],
      },
      { type: 'webhook', code: 'SYNC_UPDATES_AVAILABLE', note: 'late retry' },
    ],
  },
  {
    id: 'sandbox-login-required',
    title: 'Real ITEM_LOGIN_REQUIRED with a stale LOGIN_REPAIRED',
    summary:
      '/sandbox/item/reset_login really breaks the Item: sync returns ITEM_LOGIN_REQUIRED and /item/get reports it. A stale sync webhook arrives during the outage. Then a LOGIN_REPAIRED from an earlier recovery arrives late, even though the Item is still broken.',
    whyItMatters:
      'The app should keep the user\'s data, show a reconnect prompt, and believe /item/get over a webhook that arrives out of order.',
    docs: [DOCS.resetLogin, DOCS.itemGet, DOCS.webhooks],
    finalChecks: [...LEDGER_CHECKS, 'item-status-matches'],
    steps: [
      ...setup,
      { type: 'reset-login', note: 'bank requires re-authentication' },
      { type: 'webhook', code: 'ERROR' },
      { type: 'webhook', code: 'SYNC_UPDATES_AVAILABLE', note: 'stale retry during the outage' },
      { type: 'checkpoint', label: 'during outage', checks: [...LEDGER_CHECKS, 'item-status-matches'] },
      { type: 'webhook', code: 'LOGIN_REPAIRED', note: 'from an earlier recovery, delivered late' },
    ],
  },
  {
    id: 'sandbox-missed-webhook',
    title: 'Missed webhook after real new activity',
    summary: 'Real new activity arrives, the webhook is lost, and only the app\'s reconcile() job can recover it.',
    whyItMatters: 'Without a scheduled catch-up sync, these transactions never appear.',
    docs: [DOCS.webhooks, DOCS.sync],
    finalChecks: LEDGER_CHECKS,
    steps: [
      ...setup,
      { type: 'create-transactions', count: 2 },
      { type: 'refresh' },
      { type: 'drop-webhook', code: 'SYNC_UPDATES_AVAILABLE', note: 'delivery failed' },
      { type: 'reconcile', note: 'scheduled sync job runs' },
    ],
  },
];

/** Catalog scenarios Sandbox cannot reproduce deterministically; they run on recorded Sandbox data. */
export const RECORDED_FALLBACKS = [
  'mutation-during-pagination',
  'out-of-order-item-events',
  'login-required-then-repaired',
  'missed-webhook-catchup',
  'paginated-sync',
];

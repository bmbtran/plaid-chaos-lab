// ───────────────────────── Plaid-shaped data ─────────────────────────

/** Subset of Plaid's Transaction object that the lab models. */
export interface Transaction {
  transaction_id: string;
  account_id: string;
  /** Plaid convention: positive = money leaving the account (spend). */
  amount: number;
  iso_currency_code: string;
  date: string;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
}

export interface RemovedTransaction {
  transaction_id: string;
  account_id: string;
}

export interface TransactionsSyncRequest {
  access_token: string;
  cursor?: string | null;
  count?: number;
}

export interface TransactionsSyncResponse {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  next_cursor: string;
  has_more: boolean;
  transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE';
  accounts: Array<{ account_id: string; name: string; type: string; subtype: string }>;
  request_id: string;
}

export interface PlaidApiError {
  error_type: string;
  error_code: string;
  error_message: string;
  display_message: string | null;
  status: number;
  request_id?: string;
  documentation_url?: string;
  suggested_action?: string | null;
  causes?: unknown[];
}

export interface ItemGetResponse {
  item: {
    item_id: string;
    institution_id: string;
    webhook: string;
    error: PlaidApiError | null;
    available_products: string[];
    billed_products: string[];
    products: string[];
    consent_expiration_time: string | null;
    update_type: 'background';
  };
  request_id: string;
}

export type SyncUpdatesAvailableWebhook = {
  webhook_type: 'TRANSACTIONS';
  webhook_code: 'SYNC_UPDATES_AVAILABLE';
  item_id: string;
  initial_update_complete: boolean;
  historical_update_complete: boolean;
  environment: 'sandbox';
};

export type ItemErrorWebhook = {
  webhook_type: 'ITEM';
  webhook_code: 'ERROR';
  item_id: string;
  error: PlaidApiError;
  environment: 'sandbox';
};

export type LoginRepairedWebhook = {
  webhook_type: 'ITEM';
  webhook_code: 'LOGIN_REPAIRED';
  item_id: string;
  environment: 'sandbox';
};

export type PlaidWebhook = SyncUpdatesAvailableWebhook | ItemErrorWebhook | LoginRepairedWebhook;

/**
 * Call shape of `PlaidApi` from `plaid/legacy` (the classic axios-based SDK
 * that most production integrations use). Errors are thrown axios-style:
 * `err.response.status`, `err.response.data.error_code`.
 */
export interface PlaidClientLike {
  transactionsSync(request: TransactionsSyncRequest): Promise<{ data: TransactionsSyncResponse }>;
  itemGet(request: { access_token: string }): Promise<{ data: ItemGetResponse }>;
}

// ───────────────────────── Adapter contract ─────────────────────────

export type ItemStatus = 'healthy' | 'login_required';

/** One transaction as the app stores / displays it. Extra fields are ignored. */
export interface AppTransaction {
  transaction_id: string;
  amount: number;
  pending?: boolean;
  date?: string;
  [key: string]: unknown;
}

export interface AppStateSnapshot {
  transactions: AppTransaction[];
  /** Whether the app currently tells the user their bank connection needs attention. */
  itemStatus?: ItemStatus;
  cursor?: string | null;
}

export interface IntegrationAdapter {
  registerItem(item: { itemId: string; accessToken: string }): Promise<void>;
  handleWebhook(body: PlaidWebhook): Promise<void>;
  getState(itemId: string): Promise<AppStateSnapshot>;
  /** Your periodic catch-up job (cron / scheduled sync), if you have one. */
  reconcile?(itemId: string): Promise<void>;
  close?(): Promise<void>;
}

export interface AdapterContext {
  plaid: PlaidClientLike;
}

export type AdapterFactory = (ctx: AdapterContext) => IntegrationAdapter | Promise<IntegrationAdapter>;

// ───────────────────────── Scripts ─────────────────────────

export type BankOp =
  | { op: 'add'; txn: Transaction }
  | { op: 'modify'; transaction_id: string; changes: Partial<Omit<Transaction, 'transaction_id'>> }
  | { op: 'remove'; transaction_id: string }
  /** Pending → posted: removes the pending txn and adds `posted` with pending_transaction_id set. */
  | { op: 'post'; pending_id: string; posted: Transaction };

export type Step =
  | { type: 'register-item'; item_id: string; access_token: string }
  | { type: 'bank'; item_id: string; ops: BankOp[]; note?: string }
  | { type: 'item-error'; item_id: string; error_code: 'ITEM_LOGIN_REQUIRED' | null; note?: string }
  | { type: 'webhook'; payload: PlaidWebhook; note?: string }
  | { type: 'drop-webhook'; payload: PlaidWebhook; note?: string }
  | { type: 'concurrent'; steps: Step[]; note?: string }
  | { type: 'arm-mutation'; item_id: string; after_page: number; ops: BankOp[]; note?: string }
  | { type: 'reconcile'; item_id: string; note?: string }
  | { type: 'checkpoint'; label: string; checks: InvariantId[] };

export interface Script {
  /** Max transactions per sync page (forces pagination). */
  pageSize: number;
  steps: Step[];
}

export interface ScenarioMeta {
  id: string;
  title: string;
  summary: string;
  whyItMatters: string;
  docs: string[];
  /** Invariants checked once the script finishes. */
  finalChecks: InvariantId[];
}

export interface Scenario extends ScenarioMeta {
  build(seed: number): Script;
}

// ───────────────────────── Results ─────────────────────────

export type InvariantId =
  | 'no-duplicate-transactions'
  | 'no-pending-posted-double-count'
  | 'no-phantom-transactions'
  | 'no-missing-transactions'
  | 'transaction-fields-current'
  | 'item-status-matches'
  | 'sync-restarts-from-original-cursor'
  | 'webhook-handlers-succeed';

export type Severity = 'error' | 'warn';

export interface InvariantResult {
  id: InvariantId;
  severity: Severity;
  passed: boolean;
  /** Where it was checked: a checkpoint label or "final". */
  at: string;
  message: string;
}

export type DecodedCursor =
  | { kind: 'start' }
  | { kind: 'version'; version: number }
  | { kind: 'page'; snapshot: number; baseVersion: number; page: number }
  | { kind: 'invalid'; raw: string };

export type TimelineEvent =
  | { seq: number; kind: 'register'; itemId: string }
  | { seq: number; kind: 'bank'; itemId: string; version: number; summary: string; note?: string }
  | { seq: number; kind: 'item-error'; itemId: string; errorCode: string | null; note?: string }
  | { seq: number; kind: 'armed'; itemId: string; afterPage: number; summary: string; note?: string }
  | { seq: number; kind: 'mutation-fired'; itemId: string; version: number; summary: string }
  | { seq: number; kind: 'webhook'; code: string; itemId: string; delivery: 'delivered' | 'dropped'; note?: string; concurrentGroup?: number }
  | { seq: number; kind: 'handler-error'; code: string; message: string }
  | {
      seq: number;
      kind: 'api';
      itemId: string;
      endpoint: '/transactions/sync' | '/item/get';
      cursor?: DecodedCursor;
      outcome: string;
      errorCode?: string;
    }
  | { seq: number; kind: 'reconcile'; itemId: string; outcome: 'ran' | 'unsupported' | 'error'; message?: string }
  | { seq: number; kind: 'checkpoint'; label: string };

/** A timeline event before the runner assigns its sequence number. */
export type NewTimelineEvent = TimelineEvent extends infer E ? (E extends TimelineEvent ? Omit<E, 'seq'> : never) : never;

export interface StateCapture {
  label: string;
  app: AppStateSnapshot;
  truth: { transactions: Transaction[]; itemStatus: ItemStatus };
}

export interface RunResult {
  scenario: string;
  seed: number;
  pageSize: number;
  passed: boolean;
  invariants: InvariantResult[];
  impact: string[];
  timeline: TimelineEvent[];
  states: StateCapture[];
  script: Script;
}

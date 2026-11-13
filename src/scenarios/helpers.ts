import type {
  BankOp,
  ItemErrorWebhook,
  LoginRepairedWebhook,
  Step,
  SyncUpdatesAvailableWebhook,
  Transaction,
} from '../types.ts';
import { Rng } from '../rng.ts';
import { itemLoginRequired } from '../fake-plaid/errors.ts';
import { LEDGER_CHECKS } from '../engine/invariants.ts';

export const ITEM_ID = 'item_chaos_1';
export const ACCESS_TOKEN = 'access-sandbox-chaos-0001';
export const ACCOUNT_ID = 'acc_checking';

const MERCHANTS: Array<[string, number, number]> = [
  ['Blue Bottle Coffee', 3.5, 9],
  ['Uber', 9, 48],
  ['Whole Foods Market', 18, 160],
  ['Spotify', 11.99, 11.99],
  ['Shell', 25, 70],
  ['Chipotle', 9, 22],
  ['Amazon', 12, 140],
  ['Lyft', 8, 40],
  ["Trader Joe's", 15, 95],
  ['Netflix', 15.49, 15.49],
  ['Sweetgreen', 12, 19],
  ['CVS Pharmacy', 6, 45],
];

/** Generates realistic, unique, seeded transactions. */
export class DataFactory {
  readonly rng: Rng;
  private ids = new Set<string>();
  private day = 0;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  private id(): string {
    let id: string;
    do id = `txn_${this.rng.hex(10)}`;
    while (this.ids.has(id));
    this.ids.add(id);
    return id;
  }

  txn(opts: { pending?: boolean; merchant?: string } = {}): Transaction {
    const [merchant, lo, hi] = opts.merchant
      ? MERCHANTS.find((m) => m[0] === opts.merchant) ?? [opts.merchant, 5, 50]
      : this.rng.pick(MERCHANTS);
    this.day += this.rng.int(0, 1);
    const date = new Date(Date.UTC(2026, 9, 1 + this.day)).toISOString().slice(0, 10);
    return {
      transaction_id: this.id(),
      account_id: ACCOUNT_ID,
      amount: this.rng.money(lo, hi),
      iso_currency_code: 'USD',
      date,
      name: merchant.toUpperCase(),
      merchant_name: merchant,
      pending: opts.pending ?? false,
      pending_transaction_id: null,
    };
  }

  many(n: number, opts: { pending?: boolean } = {}): Transaction[] {
    return Array.from({ length: n }, () => this.txn(opts));
  }

  /** The posted version of a pending transaction (new id; amount may change, e.g. a tip). */
  posted(pending: Transaction, opts: { amountChange?: boolean } = {}): Transaction {
    const amount = opts.amountChange ? Math.round(pending.amount * 1.2 * 100) / 100 : pending.amount;
    return {
      ...pending,
      transaction_id: this.id(),
      amount,
      pending: false,
      pending_transaction_id: pending.transaction_id,
    };
  }
}

export const adds = (txns: Transaction[]): BankOp[] => txns.map((txn) => ({ op: 'add', txn }));

export function syncWebhook(itemId = ITEM_ID): SyncUpdatesAvailableWebhook {
  return {
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    item_id: itemId,
    initial_update_complete: true,
    historical_update_complete: true,
    environment: 'sandbox',
  };
}

export function itemErrorWebhook(itemId = ITEM_ID): ItemErrorWebhook {
  const { request_id: _r, ...error } = itemLoginRequired();
  return { webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: itemId, error, environment: 'sandbox' };
}

export function loginRepairedWebhook(itemId = ITEM_ID): LoginRepairedWebhook {
  return { webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: itemId, environment: 'sandbox' };
}

/** Register the item, load history, deliver the first webhook, verify the initial sync. */
export function initialSync(initial: Transaction[]): Step[] {
  return [
    { type: 'register-item', item_id: ITEM_ID, access_token: ACCESS_TOKEN },
    { type: 'bank', item_id: ITEM_ID, ops: adds(initial), note: 'initial transaction history' },
    { type: 'webhook', payload: syncWebhook(), note: 'initial update' },
    { type: 'checkpoint', label: 'after initial sync', checks: LEDGER_CHECKS },
  ];
}

import type {
  AppStateSnapshot,
  InvariantId,
  InvariantResult,
  ItemStatus,
  Severity,
  TimelineEvent,
  Transaction,
} from '../types.ts';
import { describeCursor, label } from '../fake-plaid/bank.ts';

export interface CheckContext {
  at: string;
  itemId: string;
  app: AppStateSnapshot;
  truth: Transaction[];
  truthStatus: ItemStatus;
  /** Every transaction version the bank ever produced (for readable messages). */
  seen: Map<string, Transaction>;
  /** posted id → pending id */
  replacements: Map<string, string>;
  timeline: TimelineEvent[];
}

interface InvariantDef {
  id: InvariantId;
  severity: Severity;
  description: string;
  check(ctx: CheckContext): { passed: boolean; message: string };
}

const MAX_LISTED = 3;
function list(ids: string[], seen: Map<string, Transaction>): string {
  const shown = ids.slice(0, MAX_LISTED).map((id) => label(seen.get(id), id));
  const more = ids.length > MAX_LISTED ? `, and ${ids.length - MAX_LISTED} more` : '';
  return shown.join(', ') + more;
}

const money = (n: number) => `$${n.toFixed(2)}`;

export const INVARIANTS: Record<InvariantId, InvariantDef> = {
  'no-duplicate-transactions': {
    id: 'no-duplicate-transactions',
    severity: 'error',
    description: 'Every transaction_id appears at most once in app state.',
    check({ app, seen }) {
      const counts = new Map<string, number>();
      for (const t of app.transactions) counts.set(t.transaction_id, (counts.get(t.transaction_id) ?? 0) + 1);
      const dups = [...counts.entries()].filter(([, n]) => n > 1);
      if (dups.length === 0) return { passed: true, message: `${app.transactions.length} transactions, all unique` };
      return {
        passed: false,
        message: `${dups.length} transaction(s) stored more than once: ${dups
          .slice(0, MAX_LISTED)
          .map(([id, n]) => `${label(seen.get(id), id)} ×${n}`)
          .join(', ')}`,
      };
    },
  },

  'no-pending-posted-double-count': {
    id: 'no-pending-posted-double-count',
    severity: 'error',
    description: 'The app never holds both a pending transaction and the posted transaction that replaced it.',
    check({ app, seen, replacements }) {
      const ids = new Set(app.transactions.map((t) => t.transaction_id));
      const pairs = [...replacements.entries()].filter(([posted, pending]) => ids.has(posted) && ids.has(pending));
      if (pairs.length === 0) return { passed: true, message: 'no pending/posted pair held twice' };
      return {
        passed: false,
        message: pairs
          .slice(0, MAX_LISTED)
          .map(([posted, pending]) => `pending ${label(seen.get(pending), pending)} is still stored alongside its posted replacement ${label(seen.get(posted), posted)}`)
          .join('; '),
      };
    },
  },

  'no-phantom-transactions': {
    id: 'no-phantom-transactions',
    severity: 'error',
    description: 'Every transaction the app stores exists at the bank.',
    check({ app, truth, seen }) {
      const truthIds = new Set(truth.map((t) => t.transaction_id));
      const phantoms = [...new Set(app.transactions.map((t) => t.transaction_id).filter((id) => !truthIds.has(id)))];
      if (phantoms.length === 0) return { passed: true, message: 'no phantom transactions' };
      return { passed: false, message: `${phantoms.length} transaction(s) no longer exist at the bank: ${list(phantoms, seen)}` };
    },
  },

  'no-missing-transactions': {
    id: 'no-missing-transactions',
    severity: 'error',
    description: 'Every transaction that exists at the bank is in app state.',
    check({ app, truth, seen }) {
      const appIds = new Set(app.transactions.map((t) => t.transaction_id));
      const missing = truth.map((t) => t.transaction_id).filter((id) => !appIds.has(id));
      if (missing.length === 0) return { passed: true, message: `all ${truth.length} bank transactions present` };
      return { passed: false, message: `${missing.length} of ${truth.length} bank transaction(s) missing: ${list(missing, seen)}` };
    },
  },

  'transaction-fields-current': {
    id: 'transaction-fields-current',
    severity: 'error',
    description: 'Amount (and pending/date when reported) match the latest bank version.',
    check({ app, truth, seen }) {
      const byId = new Map(truth.map((t) => [t.transaction_id, t]));
      const stale: string[] = [];
      for (const a of app.transactions) {
        const t = byId.get(a.transaction_id);
        if (!t) continue;
        const diffs: string[] = [];
        if (Math.abs(Number(a.amount) - t.amount) > 0.004) diffs.push(`amount ${money(Number(a.amount))} ≠ ${money(t.amount)}`);
        if (a.pending !== undefined && a.pending !== t.pending) diffs.push(`pending ${a.pending} ≠ ${t.pending}`);
        if (a.date !== undefined && a.date !== t.date) diffs.push(`date ${a.date} ≠ ${t.date}`);
        if (diffs.length) stale.push(`${label(seen.get(t.transaction_id), t.transaction_id)}: ${diffs.join(', ')}`);
      }
      if (stale.length === 0) return { passed: true, message: 'stored fields match the bank' };
      return {
        passed: false,
        message: `${stale.length} stale transaction(s): ${stale.slice(0, MAX_LISTED).join('; ')}${stale.length > MAX_LISTED ? '; …' : ''}`,
      };
    },
  },

  'item-status-matches': {
    id: 'item-status-matches',
    severity: 'error',
    description: "The app's Item health (does it ask the user to reconnect?) matches Plaid's.",
    check({ app, truthStatus }) {
      if (app.itemStatus === undefined) {
        return { passed: false, message: `adapter did not report itemStatus (expected "${truthStatus}")` };
      }
      if (app.itemStatus === truthStatus) return { passed: true, message: `itemStatus "${truthStatus}"` };
      return { passed: false, message: `app reports itemStatus "${app.itemStatus}" but Plaid's /item/get says "${truthStatus}"` };
    },
  },

  'sync-restarts-from-original-cursor': {
    id: 'sync-restarts-from-original-cursor',
    severity: 'error',
    description:
      'After TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION the next sync call restarts from the original cursor of the loop.',
    check({ timeline, itemId }) {
      const calls = timeline.filter(
        (e): e is Extract<TimelineEvent, { kind: 'api' }> =>
          e.kind === 'api' && e.endpoint === '/transactions/sync' && e.itemId === itemId,
      );
      let exercised = 0;
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        if (call.errorCode !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') continue;
        exercised += 1;
        const base = call.cursor?.kind === 'page' ? call.cursor.baseVersion : undefined;
        const next = calls[i + 1];
        const expected = base === 0 ? 'cursor="" (start)' : `cursor=v${base}`;
        if (!next) {
          return { passed: false, message: `sync loop was never restarted after #${call.seq} (expected a call with ${expected})` };
        }
        const c = next.cursor;
        const ok = c && ((c.kind === 'version' && c.version === base) || (c.kind === 'start' && base === 0));
        if (!ok) {
          return {
            passed: false,
            message: `after the mutation error at #${call.seq}, the next call (#${next.seq}) used ${describeCursor(c)} instead of restarting with ${expected}`,
          };
        }
      }
      return exercised
        ? { passed: true, message: `restarted correctly after ${exercised} mutation error(s)` }
        : { passed: true, message: 'not exercised (no mutation error occurred)' };
    },
  },

  'webhook-handlers-succeed': {
    id: 'webhook-handlers-succeed',
    severity: 'warn',
    description: 'Webhook handlers return success (a failure makes Plaid retry for up to 24h).',
    check({ timeline }) {
      const errors = timeline.filter((e): e is Extract<TimelineEvent, { kind: 'handler-error' }> => e.kind === 'handler-error');
      if (errors.length === 0) return { passed: true, message: 'all webhook handlers succeeded' };
      return {
        passed: false,
        message: `${errors.length} webhook handler failure(s): ${errors
          .slice(0, 2)
          .map((e) => `#${e.seq} ${e.code}: ${e.message}`)
          .join('; ')}`,
      };
    },
  },
};

export function runChecks(ids: InvariantId[], ctx: CheckContext): InvariantResult[] {
  return ids.map((id) => {
    const def = INVARIANTS[id];
    const { passed, message } = def.check(ctx);
    return { id, severity: def.severity, passed, at: ctx.at, message };
  });
}

export const LEDGER_CHECKS: InvariantId[] = [
  'no-duplicate-transactions',
  'no-pending-posted-double-count',
  'no-phantom-transactions',
  'no-missing-transactions',
  'transaction-fields-current',
];

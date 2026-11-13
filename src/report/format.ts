import type { AppTransaction, RunResult, StateCapture, TimelineEvent, Transaction } from '../types.ts';
import { describeCursor } from '../fake-plaid/bank.ts';

const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const note = (n?: string) => (n ? ` — ${n}` : '');

export function formatEvent(e: TimelineEvent): string {
  switch (e.kind) {
    case 'register':
      return `register Item ${e.itemId}`;
    case 'bank':
      return `bank v${e.version}: ${clip(e.summary)}${note(e.note)}`;
    case 'item-error':
      return e.errorCode ? `Item enters ${e.errorCode}${note(e.note)}` : `Item healthy again${note(e.note)}`;
    case 'armed':
      return `chaos armed: after page ${e.afterPage} is served → ${clip(e.summary, 120)}`;
    case 'mutation-fired':
      return `⚡ bank mutated mid-pagination (v${e.version}): ${clip(e.summary, 120)}`;
    case 'webhook':
      return e.delivery === 'dropped'
        ? `✗ webhook ${e.code} DROPPED${note(e.note)}`
        : `→ webhook ${e.code} delivered${e.concurrentGroup ? ` [concurrent #${e.concurrentGroup}]` : ''}${note(e.note)}`;
    case 'handler-error':
      return `! webhook handler for ${e.code} failed: ${clip(e.message, 120)}`;
    case 'api':
      return `app → ${e.endpoint}${e.cursor ? ` ${describeCursor(e.cursor)}` : ''} ⇒ ${e.outcome}`;
    case 'reconcile':
      return e.outcome === 'unsupported'
        ? `reconcile(): not implemented by the app${note(e.message)}`
        : `reconcile(): ${e.outcome}${note(e.message)}`;
    case 'checkpoint':
      return `── checkpoint: ${e.label}`;
  }
}

export type RowStatus = 'ok' | 'DUPLICATE' | 'DOUBLE-COUNT' | 'PHANTOM' | 'MISSING' | 'STALE';

export interface DiffRow {
  id: string;
  merchant: string;
  app: string;
  bank: string;
  status: RowStatus;
}

/** Side-by-side view of app state vs ground truth for one capture. */
export function diffState(capture: StateCapture, run: Pick<RunResult, 'states'>, seen?: Map<string, Transaction>): DiffRow[] {
  const truth = new Map(capture.truth.transactions.map((t) => [t.transaction_id, t]));
  const appById = new Map<string, AppTransaction[]>();
  for (const a of capture.app.transactions) {
    appById.set(a.transaction_id, [...(appById.get(a.transaction_id) ?? []), a]);
  }
  // Pending ids whose posted replacement the app also holds.
  const replacedPending = new Set(
    capture.truth.transactions
      .filter((t) => t.pending_transaction_id && appById.has(t.transaction_id))
      .map((t) => t.pending_transaction_id as string),
  );
  const fmt = (n: number) => `$${n.toFixed(2)}${''}`;
  const rows: DiffRow[] = [];
  const ids = [...new Set([...capture.truth.transactions.map((t) => t.transaction_id), ...appById.keys()])];
  for (const id of ids) {
    const t = truth.get(id);
    const as = appById.get(id) ?? [];
    const merchant =
      t?.merchant_name ??
      (as[0]?.name as string | undefined) ??
      seen?.get(id)?.merchant_name ??
      '?';
    const appText = as.length ? as.map((a) => fmt(Number(a.amount)) + (a.pending ? ' (pending)' : '')).join(' + ') : '—';
    const bankText = t ? fmt(t.amount) + (t.pending ? ' (pending)' : '') : 'gone';
    let status: RowStatus = 'ok';
    if (!t && replacedPending.has(id)) status = 'DOUBLE-COUNT';
    else if (!t) status = 'PHANTOM';
    else if (as.length === 0) status = 'MISSING';
    else if (as.length > 1) status = 'DUPLICATE';
    else if (Math.abs(Number(as[0].amount) - t.amount) > 0.004 || (as[0].pending !== undefined && as[0].pending !== t.pending)) status = 'STALE';
    rows.push({ id, merchant, app: appText, bank: bankText, status });
  }
  return rows;
}

export function failedInvariants(run: RunResult) {
  return run.invariants.filter((i) => !i.passed);
}

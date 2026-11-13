import type { AppTransaction, RunResult, StateCapture, TimelineEvent, Transaction } from '../types.ts';
import { describeCursor } from '../fake-plaid/bank.ts';

const clip = (s: string, n = 150) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const note = (n?: string) => (n ? ` (${n})` : '');

export interface FormattedEvent {
  /** Short fixed-width category label. */
  tag: string;
  text: string;
  /** Events worth drawing the eye to: faults the lab injected and failures. */
  emphasis: boolean;
}

export const TAG_WIDTH = 9;

export function formatEvent(e: TimelineEvent): FormattedEvent {
  const ev = (tag: string, text: string, emphasis = false) => ({ tag, text, emphasis });
  switch (e.kind) {
    case 'register':
      return ev('item', `registered ${e.itemId}`);
    case 'bank':
      return ev('bank', `v${e.version}: ${clip(e.summary)}${note(e.note)}`);
    case 'item-error':
      return e.errorCode ? ev('item', `now ${e.errorCode}${note(e.note)}`, true) : ev('item', `healthy again${note(e.note)}`);
    case 'armed':
      return ev('fault', `after page ${e.afterPage} the bank will change: ${clip(e.summary, 110)}`);
    case 'mutation-fired':
      return ev('fault', `bank changed mid-pagination, now v${e.version}`, true);
    case 'webhook':
      return e.delivery === 'dropped'
        ? ev('dropped', `${e.code}${note(e.note)}`, true)
        : ev('webhook', `${e.code}${e.concurrentGroup ? ` [concurrent ${e.concurrentGroup}]` : ''}${note(e.note)}`);
    case 'handler-error':
      return ev('error', `${e.code} handler failed: ${clip(e.message, 110)}`, true);
    case 'api':
      return ev('call', `${e.endpoint}${e.cursor ? ` ${describeCursor(e.cursor)}` : ''}: ${e.outcome}`, !!e.errorCode);
    case 'reconcile':
      return ev('reconcile', e.outcome === 'unsupported' ? `not implemented by the app${note(e.message)}` : `${e.outcome}${note(e.message)}`, e.outcome !== 'ran');
    case 'checkpoint':
      return ev('check', e.label);
  }
}

/** Plain one-line form for Markdown and logs. */
export function eventLine(e: TimelineEvent): string {
  const f = formatEvent(e);
  return `${f.tag.padEnd(TAG_WIDTH)} ${f.text}`;
}

export type RowStatus = 'ok' | 'duplicate' | 'double count' | 'phantom' | 'missing' | 'stale';

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
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const rows: DiffRow[] = [];
  const ids = [...new Set([...capture.truth.transactions.map((t) => t.transaction_id), ...appById.keys()])];
  for (const id of ids) {
    const t = truth.get(id);
    const as = appById.get(id) ?? [];
    const merchant =
      t?.merchant_name ??
      t?.name ??
      (as[0]?.name as string | undefined) ??
      seen?.get(id)?.merchant_name ??
      '?';
    const appText = as.length ? as.map((a) => fmt(Number(a.amount)) + (a.pending ? ' pending' : '')).join(' and ') : 'not shown';
    const bankText = t ? fmt(t.amount) + (t.pending ? ' pending' : '') : 'removed';
    let status: RowStatus = 'ok';
    if (!t && replacedPending.has(id)) status = 'double count';
    else if (!t) status = 'phantom';
    else if (as.length === 0) status = 'missing';
    else if (as.length > 1) status = 'duplicate';
    else if (Math.abs(Number(as[0].amount) - t.amount) > 0.004 || (as[0].pending !== undefined && as[0].pending !== t.pending)) status = 'stale';
    rows.push({ id, merchant, app: appText, bank: bankText, status });
  }
  return rows;
}

export function failedInvariants(run: RunResult) {
  return run.invariants.filter((i) => !i.passed);
}

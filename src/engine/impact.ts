import type { AppStateSnapshot, ItemStatus, Transaction } from '../types.ts';

const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const name = (t: Transaction | undefined, id: string) => (t ? `"${t.merchant_name ?? t.name}"` : id);

/** Plaid convention: positive amounts are money out. */
export function spend(amounts: number[]): number {
  return Math.round(amounts.filter((a) => a > 0).reduce((s, a) => s + a, 0) * 100) / 100;
}

/**
 * Translate a broken ledger into what the end user would actually see.
 * Returns an empty array when the app's view is correct.
 */
export function userImpact(args: {
  app: AppStateSnapshot;
  truth: Transaction[];
  truthStatus: ItemStatus;
  seen: Map<string, Transaction>;
  replacements: Map<string, string>;
}): string[] {
  const { app, truth, truthStatus, seen, replacements } = args;
  const out: string[] = [];
  const truthById = new Map(truth.map((t) => [t.transaction_id, t]));
  const appIds = app.transactions.map((t) => t.transaction_id);
  const appIdSet = new Set(appIds);

  const shown = spend(app.transactions.map((t) => Number(t.amount)));
  const actual = spend(truth.map((t) => t.amount));
  if (Math.abs(shown - actual) > 0.004) {
    const dir = shown > actual ? 'overstated' : 'understated';
    out.push(`Spending is ${dir} by ${money(shown - actual)}: the app shows ${money(shown)}, the bank says ${money(actual)}.`);
  }

  const counts = new Map<string, number>();
  for (const id of appIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (n > 1) out.push(`${name(seen.get(id), id)} (${money(seen.get(id)?.amount ?? 0)}) appears ${n} times in the activity feed.`);
  }

  for (const [posted, pending] of replacements) {
    if (appIdSet.has(posted) && appIdSet.has(pending)) {
      const p = seen.get(pending);
      const q = seen.get(posted);
      out.push(
        `${name(q, posted)} is listed twice: once as pending (${money(p?.amount ?? 0)}) and once as posted (${money(q?.amount ?? 0)}).`,
      );
    }
  }

  const phantoms = [...appIdSet].filter((id) => !truthById.has(id) && !replacements.has(id) && ![...replacements.values()].includes(id));
  for (const id of phantoms.slice(0, 3)) {
    out.push(`${name(seen.get(id), id)} (${money(seen.get(id)?.amount ?? 0)}) is shown but no longer exists at the bank.`);
  }

  const missing = truth.filter((t) => !appIdSet.has(t.transaction_id));
  if (missing.length) {
    const sample = missing.slice(0, 3).map((t) => `${name(t, t.transaction_id)} ${money(t.amount)}`).join(', ');
    out.push(`${missing.length} transaction(s) never show up: ${sample}${missing.length > 3 ? ', …' : ''}.`);
  }

  for (const a of app.transactions) {
    const t = truthById.get(a.transaction_id);
    if (t && Math.abs(Number(a.amount) - t.amount) > 0.004) {
      out.push(`${name(t, t.transaction_id)} shows ${money(Number(a.amount))} but actually cleared at ${money(t.amount)}.`);
    }
  }

  if (app.itemStatus !== undefined && app.itemStatus !== truthStatus) {
    out.push(
      truthStatus === 'healthy'
        ? 'The user is told to reconnect their bank even though the connection works.'
        : 'The user is never told their bank connection is broken, so their data silently stops updating.',
    );
  }

  return out;
}

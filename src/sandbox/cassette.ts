import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Transaction } from '../types.ts';
import type { SandboxApi } from './api.ts';

/** Real /transactions/sync data recorded from Plaid Sandbox. Contains no credentials or access tokens. */
export interface Cassette {
  tool: 'plaid-chaos-lab';
  kind: 'cassette';
  recordedAt: string;
  source: string;
  /** Every transaction observed: initial history plus whatever a refresh produced. */
  transactions: Transaction[];
  stats: { initial: number; afterRefresh: number; pendingPosted: number; accounts: number };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Create a user_transactions_dynamic Item, drain it, refresh once, drain again, then remove the Item. */
export async function recordCassette(api: SandboxApi, log: (m: string) => void = () => {}): Promise<Cassette> {
  const item = await api.createItem();
  try {
    log('waiting for the Sandbox Item to finish its historical pull');
    let first = await api.drain(item.accessToken);
    for (let i = 0; i < 40 && first.status !== 'HISTORICAL_UPDATE_COMPLETE'; i++) {
      await sleep(1_500);
      first = await api.drain(item.accessToken);
    }
    log(`recorded ${first.transactions.length} transactions; refreshing to capture pending→posted`);
    const refreshed = await api.refreshAndWait(item.accessToken, first.transactions);
    const second = { transactions: refreshed.transactions };
    const all = new Map<string, Transaction>();
    for (const t of [...first.transactions, ...second.transactions]) all.set(t.transaction_id, t);
    return {
      tool: 'plaid-chaos-lab',
      kind: 'cassette',
      recordedAt: new Date().toISOString(),
      source: 'Plaid Sandbox, ins_109508, user_transactions_dynamic',
      transactions: [...all.values()],
      stats: {
        initial: first.transactions.length,
        afterRefresh: second.transactions.length,
        pendingPosted: second.transactions.filter((t) => t.pending_transaction_id).length,
        accounts: new Set(second.transactions.map((t) => t.account_id)).size,
      },
    };
  } finally {
    await api.removeItem(item.accessToken).catch(() => undefined);
  }
}

export async function writeCassette(path: string, c: Cassette): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(c, null, 2) + '\n', 'utf8');
}

export async function readCassette(path: string): Promise<Cassette> {
  const c = JSON.parse(await readFile(path, 'utf8')) as Cassette;
  if (c.tool !== 'plaid-chaos-lab' || c.kind !== 'cassette' || !Array.isArray(c.transactions)) {
    throw new Error(`${path} is not a Chaos Lab cassette`);
  }
  return c;
}

import type {
  BankOp,
  DecodedCursor,
  ItemGetResponse,
  ItemStatus,
  NewTimelineEvent,
  PlaidApiError,
  RemovedTransaction,
  Transaction,
  TransactionsSyncRequest,
  TransactionsSyncResponse,
} from '../types.ts';
import {
  FakePlaidError,
  invalidAccessToken,
  invalidCursor,
  itemLoginRequired,
  mutationDuringPagination,
  requestId,
} from './errors.ts';

type Update =
  | { kind: 'added'; txn: Transaction }
  | { kind: 'modified'; txn: Transaction }
  | { kind: 'removed'; removed: RemovedTransaction };

interface Snapshot {
  id: number;
  itemId: string;
  baseVersion: number;
  atVersion: number;
  pages: Update[][];
}

interface ItemLedger {
  itemId: string;
  accessToken: string;
  version: number;
  current: Map<string, Transaction>;
  /** Frozen copy of the ledger at every version. */
  history: Map<number, Map<string, Transaction>>;
  /** Monotonic "last modified" order per transaction id (used for ordering like Plaid). */
  changeSeq: Map<string, number>;
  error: PlaidApiError | null;
  armed: { afterPage: number; ops: BankOp[] } | null;
}

type EventSink = (e: NewTimelineEvent) => void;

const DEFAULT_COUNT = 100;
const MAX_COUNT = 500;

/**
 * Ground truth for every Item plus the logic that turns it into
 * /transactions/sync and /item/get responses.
 */
export class FakeBank {
  private items = new Map<string, ItemLedger>();
  private byToken = new Map<string, string>();
  private snapshots = new Map<number, Snapshot>();
  private snapshotCounter = 0;
  private seqCounter = 0;
  /** Every transaction version ever seen (for names/amounts in reports). */
  readonly seen = new Map<string, Transaction>();
  /** posted transaction id → pending transaction id it replaced. */
  readonly replacements = new Map<string, string>();

  inflight = 0;
  callCount = 0;

  constructor(
    public readonly pageSize: number,
    private readonly emit: EventSink = () => {},
  ) {}

  // ───────── setup / mutation ─────────

  createItem(itemId: string, accessToken: string): void {
    if (this.items.has(itemId)) return;
    const ledger: ItemLedger = {
      itemId,
      accessToken,
      version: 0,
      current: new Map(),
      history: new Map([[0, new Map()]]),
      changeSeq: new Map(),
      error: null,
      armed: null,
    };
    this.items.set(itemId, ledger);
    this.byToken.set(accessToken, itemId);
  }

  apply(itemId: string, ops: BankOp[]): number {
    const ledger = this.ledger(itemId);
    for (const op of ops) {
      switch (op.op) {
        case 'add':
          this.put(ledger, op.txn);
          break;
        case 'modify': {
          const existing = ledger.current.get(op.transaction_id);
          if (!existing) throw new Error(`modify: unknown transaction ${op.transaction_id}`);
          this.put(ledger, { ...existing, ...op.changes });
          break;
        }
        case 'remove':
          if (!ledger.current.delete(op.transaction_id)) {
            throw new Error(`remove: unknown transaction ${op.transaction_id}`);
          }
          ledger.changeSeq.set(op.transaction_id, ++this.seqCounter);
          break;
        case 'post': {
          if (!ledger.current.delete(op.pending_id)) throw new Error(`post: unknown pending ${op.pending_id}`);
          ledger.changeSeq.set(op.pending_id, ++this.seqCounter);
          this.put(ledger, { ...op.posted, pending: false, pending_transaction_id: op.pending_id });
          break;
        }
      }
    }
    ledger.version += 1;
    ledger.history.set(ledger.version, new Map(ledger.current));
    return ledger.version;
  }

  setItemError(itemId: string, errorCode: 'ITEM_LOGIN_REQUIRED' | null): void {
    this.ledger(itemId).error = errorCode ? itemLoginRequired() : null;
  }

  arm(itemId: string, afterPage: number, ops: BankOp[]): void {
    this.ledger(itemId).armed = { afterPage, ops };
  }

  // ───────── truth accessors ─────────

  truth(itemId: string): Transaction[] {
    return [...this.ledger(itemId).current.values()].map((t) => ({ ...t }));
  }

  itemStatus(itemId: string): ItemStatus {
    return this.ledger(itemId).error ? 'login_required' : 'healthy';
  }

  version(itemId: string): number {
    return this.ledger(itemId).version;
  }

  itemIds(): string[] {
    return [...this.items.keys()];
  }

  hasArmed(itemId: string): boolean {
    return this.ledger(itemId).armed !== null;
  }

  // ───────── API ─────────

  transactionsSync(req: TransactionsSyncRequest): TransactionsSyncResponse {
    const ledger = this.ledgerForToken(req.access_token, '/transactions/sync');
    const cursor = decodeCursor(req.cursor ?? '');
    const log = (outcome: string, errorCode?: string) =>
      this.emit({ kind: 'api', itemId: ledger.itemId, endpoint: '/transactions/sync', cursor, outcome, errorCode });

    if (ledger.error) {
      log(`error ${ledger.error.error_code}`, ledger.error.error_code);
      throw new FakePlaidError(ledger.error);
    }

    const count = Math.min(Math.max(req.count ?? DEFAULT_COUNT, 1), MAX_COUNT);
    const effective = Math.min(count, this.pageSize);

    let snapshot: Snapshot;
    let page: number;
    if (cursor.kind === 'start' || cursor.kind === 'version') {
      const base = cursor.kind === 'start' ? 0 : cursor.version;
      if (!ledger.history.has(base)) {
        log('error INVALID_FIELD (unknown cursor)', 'INVALID_FIELD');
        throw new FakePlaidError(invalidCursor());
      }
      snapshot = this.openSnapshot(ledger, base, effective);
      page = 0;
    } else if (cursor.kind === 'page') {
      const s = this.snapshots.get(cursor.snapshot);
      if (!s || s.itemId !== ledger.itemId) {
        log('error INVALID_FIELD (unknown cursor)', 'INVALID_FIELD');
        throw new FakePlaidError(invalidCursor());
      }
      if (s.atVersion !== ledger.version) {
        const err = mutationDuringPagination();
        log(`error ${err.error_code}`, err.error_code);
        throw new FakePlaidError(err);
      }
      snapshot = s;
      page = cursor.page;
    } else {
      log('error INVALID_FIELD (malformed cursor)', 'INVALID_FIELD');
      throw new FakePlaidError(invalidCursor());
    }

    const updates = snapshot.pages[page] ?? [];
    const hasMore = page + 1 < snapshot.pages.length;
    const response: TransactionsSyncResponse = {
      added: updates.filter((u) => u.kind === 'added').map((u) => ({ ...(u as { txn: Transaction }).txn })),
      modified: updates.filter((u) => u.kind === 'modified').map((u) => ({ ...(u as { txn: Transaction }).txn })),
      removed: updates
        .filter((u) => u.kind === 'removed')
        .map((u) => ({ ...(u as { removed: RemovedTransaction }).removed })),
      next_cursor: hasMore
        ? encodeCursor({ kind: 'page', snapshot: snapshot.id, baseVersion: snapshot.baseVersion, page: page + 1 })
        : encodeCursor({ kind: 'version', version: snapshot.atVersion }),
      has_more: hasMore,
      transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      accounts: [{ account_id: 'acc_checking', name: 'Plaid Checking', type: 'depository', subtype: 'checking' }],
      request_id: requestId(),
    };

    log(
      `page ${page + 1}/${Math.max(snapshot.pages.length, 1)}: +${response.added.length} ~${response.modified.length} -${response.removed.length}` +
        (hasMore ? ' has_more' : ''),
    );

    // Chaos: data changes while the app is in the middle of paginating.
    if (ledger.armed && hasMore && ledger.armed.afterPage === page + 1) {
      const { ops } = ledger.armed;
      ledger.armed = null;
      const version = this.apply(ledger.itemId, ops);
      this.emit({ kind: 'mutation-fired', itemId: ledger.itemId, version, summary: summarizeOps(ops, this.seen) });
    }

    return response;
  }

  itemGet(req: { access_token: string }): ItemGetResponse {
    const ledger = this.ledgerForToken(req.access_token, '/item/get');
    this.emit({
      kind: 'api',
      itemId: ledger.itemId,
      endpoint: '/item/get',
      outcome: ledger.error ? `item.error=${ledger.error.error_code}` : 'item.error=null',
    });
    return {
      item: {
        item_id: ledger.itemId,
        institution_id: 'ins_chaos_bank',
        webhook: '',
        error: ledger.error ? { ...ledger.error } : null,
        available_products: [],
        billed_products: ['transactions'],
        products: ['transactions'],
        consent_expiration_time: null,
        update_type: 'background',
      },
      request_id: requestId(),
    };
  }

  // ───────── internals ─────────

  private put(ledger: ItemLedger, txn: Transaction): void {
    const copy = { ...txn };
    ledger.current.set(copy.transaction_id, copy);
    ledger.changeSeq.set(copy.transaction_id, ++this.seqCounter);
    this.seen.set(copy.transaction_id, { ...copy });
    if (copy.pending_transaction_id) this.replacements.set(copy.transaction_id, copy.pending_transaction_id);
  }

  private openSnapshot(ledger: ItemLedger, baseVersion: number, pageSize: number): Snapshot {
    const base = ledger.history.get(baseVersion)!;
    const cur = ledger.current;
    const bySeq = (a: string, b: string) => (ledger.changeSeq.get(a) ?? 0) - (ledger.changeSeq.get(b) ?? 0);

    const added = [...cur.keys()].filter((id) => !base.has(id)).sort(bySeq);
    const modified = [...cur.keys()]
      .filter((id) => base.has(id) && JSON.stringify(base.get(id)) !== JSON.stringify(cur.get(id)))
      .sort(bySeq);
    const removed = [...base.keys()].filter((id) => !cur.has(id)).sort(bySeq);

    const updates: Update[] = [
      ...added.map((id) => ({ kind: 'added' as const, txn: cur.get(id)! })),
      ...modified.map((id) => ({ kind: 'modified' as const, txn: cur.get(id)! })),
      ...removed.map((id) => ({
        kind: 'removed' as const,
        removed: { transaction_id: id, account_id: base.get(id)!.account_id },
      })),
    ];
    const pages: Update[][] = [];
    for (let i = 0; i < updates.length; i += pageSize) pages.push(updates.slice(i, i + pageSize));
    if (pages.length === 0) pages.push([]);

    const snapshot: Snapshot = {
      id: ++this.snapshotCounter,
      itemId: ledger.itemId,
      baseVersion,
      atVersion: ledger.version,
      pages,
    };
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  private ledger(itemId: string): ItemLedger {
    const l = this.items.get(itemId);
    if (!l) throw new Error(`Unknown item ${itemId}`);
    return l;
  }

  private ledgerForToken(token: string, endpoint: '/transactions/sync' | '/item/get'): ItemLedger {
    const itemId = this.byToken.get(token);
    if (!itemId) {
      this.emit({ kind: 'api', itemId: '?', endpoint, outcome: 'error INVALID_ACCESS_TOKEN', errorCode: 'INVALID_ACCESS_TOKEN' });
      throw new FakePlaidError(invalidAccessToken());
    }
    return this.ledger(itemId);
  }
}

// ───────── cursors ─────────

/** Cursors are opaque base64url strings, like Plaid's. */
export function encodeCursor(c: DecodedCursor): string {
  if (c.kind === 'start') return '';
  const payload =
    c.kind === 'version' ? { t: 'v', v: c.version } : c.kind === 'page' ? { t: 'p', s: c.snapshot, b: c.baseVersion, p: c.page } : { t: 'x' };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(raw: string): DecodedCursor {
  if (!raw) return { kind: 'start' };
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (p.t === 'v' && Number.isInteger(p.v)) return { kind: 'version', version: p.v };
    if (p.t === 'p' && Number.isInteger(p.s)) return { kind: 'page', snapshot: p.s, baseVersion: p.b, page: p.p };
  } catch {
    /* fall through */
  }
  return { kind: 'invalid', raw };
}

export function describeCursor(c: DecodedCursor | undefined): string {
  if (!c) return '';
  switch (c.kind) {
    case 'start':
      return 'cursor="" (start)';
    case 'version':
      return `cursor=v${c.version}`;
    case 'page':
      return `cursor=page ${c.page + 1} of loop from v${c.baseVersion}`;
    case 'invalid':
      return `cursor=<invalid ${c.raw.slice(0, 12)}…>`;
    case 'opaque':
      return `cursor=${c.label}`;
  }
}

export function label(t: Transaction | undefined, id: string): string {
  if (!t) return id;
  return `${id} "${t.merchant_name ?? t.name}" $${t.amount.toFixed(2)}${t.pending ? ' (pending)' : ''}`;
}

export function summarizeOps(ops: BankOp[], seen: Map<string, Transaction>): string {
  return ops
    .map((op) => {
      switch (op.op) {
        case 'add':
          return `add ${label(op.txn, op.txn.transaction_id)}`;
        case 'modify':
          return `modify ${op.transaction_id}: ${Object.entries(op.changes)
            .map(([k, v]) => `${k} ${typeof v === 'number' ? `$${v.toFixed(2)}` : JSON.stringify(v)}`)
            .join(', ')}`;
        case 'remove':
          return `remove ${label(seen.get(op.transaction_id), op.transaction_id)}`;
        case 'post':
          return `pending ${op.pending_id} posts as ${label(op.posted, op.posted.transaction_id)}`;
      }
    })
    .join('; ');
}

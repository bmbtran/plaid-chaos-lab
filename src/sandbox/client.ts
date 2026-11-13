import type {
  DecodedCursor,
  ItemGetResponse,
  NewTimelineEvent,
  PlaidClientLike,
  TransactionsSyncRequest,
  TransactionsSyncResponse,
} from '../types.ts';
import { axiosStyleError } from '../fake-plaid/errors.ts';
import { PlaidHttpError, type SandboxApi } from './api.ts';

/**
 * The Plaid client handed to an in-process adapter during a Sandbox run.
 * It calls real Plaid Sandbox, records every call in the run's timeline
 * (real cursors shown as c1, c2, … in order of first appearance), and throws
 * errors in the same shape as `plaid/legacy`.
 */
export class SandboxPlaidClient implements PlaidClientLike {
  inflight = 0;
  callCount = 0;
  private cursorLabels = new Map<string, string>();

  constructor(
    private readonly api: SandboxApi,
    private readonly emit: (e: NewTimelineEvent) => void,
    /** Display id for timeline events (fixtures never contain real ids). */
    private readonly displayItemId: string,
  ) {}

  labelCursor(raw: string | null | undefined): DecodedCursor {
    if (!raw) return { kind: 'start' };
    let label = this.cursorLabels.get(raw);
    if (!label) {
      label = `c${this.cursorLabels.size + 1}`;
      this.cursorLabels.set(raw, label);
    }
    return { kind: 'opaque', label };
  }

  async transactionsSync(request: TransactionsSyncRequest): Promise<{ data: TransactionsSyncResponse }> {
    const cursor = this.labelCursor(request.cursor);
    return this.track('/transactions/sync', cursor, async () => {
      const data = await this.api.transactionsSync(request);
      const next = this.labelCursor(data.next_cursor);
      const nextLabel = next.kind === 'opaque' ? next.label : '""';
      const counts = `+${data.added.length} ~${data.modified.length} -${data.removed.length}`;
      return { data, outcome: `${counts}${data.has_more ? ' has_more' : ''}, next_cursor=${nextLabel}` };
    });
  }

  async itemGet(request: { access_token: string }): Promise<{ data: ItemGetResponse }> {
    return this.track('/item/get', undefined, async () => {
      const data = await this.api.itemGet(request.access_token);
      return { data, outcome: `item.error=${data.item.error?.error_code ?? 'null'}` };
    });
  }

  private async track<T>(
    endpoint: '/transactions/sync' | '/item/get',
    cursor: DecodedCursor | undefined,
    fn: () => Promise<{ data: T; outcome: string }>,
  ): Promise<{ data: T }> {
    this.inflight += 1;
    this.callCount += 1;
    try {
      const { data, outcome } = await fn();
      this.emit({ kind: 'api', itemId: this.displayItemId, endpoint, cursor, outcome });
      return { data };
    } catch (err) {
      if (err instanceof PlaidHttpError) {
        this.emit({
          kind: 'api',
          itemId: this.displayItemId,
          endpoint,
          cursor,
          outcome: `error ${err.body.error_code}`,
          errorCode: err.body.error_code,
        });
        throw axiosStyleError(err.body);
      }
      throw err;
    } finally {
      this.inflight -= 1;
    }
  }
}

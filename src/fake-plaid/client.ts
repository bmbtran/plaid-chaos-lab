import type { ItemGetResponse, PlaidClientLike, TransactionsSyncRequest, TransactionsSyncResponse } from '../types.ts';
import { Rng } from '../rng.ts';
import type { FakeBank } from './bank.ts';
import { FakePlaidError, toAxiosStyleError } from './errors.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * In-process client with the same call shape as `PlaidApi` from `plaid/legacy`.
 * Each call yields a seeded number of event-loop turns before and after
 * touching the bank, so concurrent webhook handlers genuinely interleave
 * (the way they would against a real network) — but reproducibly.
 */
export class FakePlaidClient implements PlaidClientLike {
  private rng: Rng;

  constructor(
    private readonly bank: FakeBank,
    seed: number,
  ) {
    this.rng = new Rng(seed ^ 0x51ed);
  }

  async transactionsSync(request: TransactionsSyncRequest): Promise<{ data: TransactionsSyncResponse }> {
    return this.call(() => this.bank.transactionsSync(request));
  }

  async itemGet(request: { access_token: string }): Promise<{ data: ItemGetResponse }> {
    return this.call(() => this.bank.itemGet(request));
  }

  private async call<T>(fn: () => T): Promise<{ data: T }> {
    this.bank.inflight += 1;
    this.bank.callCount += 1;
    try {
      await this.jitter();
      let data: T;
      try {
        data = fn();
      } catch (err) {
        await this.jitter();
        if (err instanceof FakePlaidError) throw toAxiosStyleError(err);
        throw err;
      }
      await this.jitter();
      return { data: structuredClone(data) };
    } finally {
      this.bank.inflight -= 1;
    }
  }

  private async jitter(): Promise<void> {
    const n = this.rng.int(0, 3);
    for (let i = 0; i < n; i++) await tick();
  }
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ItemGetResponse, PlaidApiError, Transaction, TransactionsSyncRequest, TransactionsSyncResponse } from '../types.ts';

export const SANDBOX_BASE_URL = 'https://sandbox.plaid.com';

const RETRYABLE = new Set(['/transactions/sync', '/item/get', '/transactions/refresh', '/item/remove']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SandboxCredentials {
  clientId: string;
  secret: string;
}

/**
 * Read Sandbox credentials from the environment, loading `.env` from the
 * working directory if present. Values are never logged or returned in errors.
 */
export function loadSandboxCredentials(envFile = resolve(process.cwd(), '.env')): SandboxCredentials {
  if (existsSync(envFile) && !(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET)) {
    process.loadEnvFile(envFile);
  }
  const clientId = process.env.PLAID_CLIENT_ID?.trim();
  const secret = (process.env.PLAID_SECRET_SANDBOX ?? process.env.PLAID_SECRET)?.trim();
  if (!clientId || !secret) {
    throw new Error('Sandbox mode needs PLAID_CLIENT_ID and PLAID_SECRET (your Sandbox secret) in the environment or .env');
  }
  return { clientId, secret };
}

export function hasSandboxCredentials(): boolean {
  try {
    loadSandboxCredentials();
    return true;
  } catch {
    return false;
  }
}

/** Error from the real Plaid API. Carries only the response body — never request headers or credentials. */
export class PlaidHttpError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly body: PlaidApiError,
  ) {
    super(`${endpoint} → ${body.error_code}: ${body.error_message}`);
    this.name = 'PlaidHttpError';
  }
}

export interface SandboxTransactionInput {
  amount: number;
  date_transacted: string;
  date_posted: string;
  description: string;
  iso_currency_code?: string;
}

/**
 * Minimal, dependency-free client for the Sandbox endpoints the lab drives.
 * Credentials travel in the request body (Plaid supports this), so nothing
 * that could be logged — errors, timelines, fixtures — ever contains them.
 */
export class SandboxApi {
  constructor(
    private readonly creds: SandboxCredentials,
    readonly baseUrl = SANDBOX_BASE_URL,
  ) {}

  /**
   * POST to Plaid. Read-only and idempotent endpoints are retried on 5xx, 429
   * and network failures (Sandbox has occasional transient INTERNAL_SERVER_ERRORs);
   * endpoints that create things are never retried.
   */
  async call<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const retryable = RETRYABLE.has(endpoint);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(endpoint, body);
      } catch (e) {
        const transient = e instanceof PlaidHttpError ? e.body.status >= 500 || e.body.status === 429 : !(e instanceof PlaidHttpError);
        if (!retryable || !transient || attempt >= 4) throw e;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  private async once<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Plaid-Version': '2020-09-14' },
      body: JSON.stringify({ client_id: this.creds.clientId, secret: this.creds.secret, ...body }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new PlaidHttpError(endpoint, {
        error_type: String(json.error_type ?? 'API_ERROR'),
        error_code: String(json.error_code ?? `HTTP_${res.status}`),
        error_message: String(json.error_message ?? res.statusText),
        display_message: (json.display_message as string | null) ?? null,
        status: res.status,
        request_id: json.request_id as string | undefined,
      });
    }
    return json as T;
  }

  /**
   * Call /transactions/refresh and wait until ground truth changes. Sandbox
   * silently ignores a refresh issued right after an Item's historical pull,
   * so an attempt that produces nothing within `attemptMs` is retried.
   */
  async refreshAndWait(
    accessToken: string,
    before: Transaction[],
    opts: { attempts?: number; attemptMs?: number; pollMs?: number } = {},
  ): Promise<{ transactions: Transaction[]; changed: boolean; attempts: number }> {
    const attempts = opts.attempts ?? 3;
    const attemptMs = opts.attemptMs ?? 20_000;
    const pollMs = opts.pollMs ?? 2_000;
    const fingerprint = (txns: Transaction[]) =>
      txns
        .map((t) => `${t.transaction_id}:${t.amount}:${t.pending}`)
        .sort()
        .join('|');
    const start = fingerprint(before);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.refreshTransactions(accessToken);
      const deadline = Date.now() + attemptMs;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        let current = (await this.drain(accessToken)).transactions;
        if (fingerprint(current) === start) continue;
        // Changed: wait until two consecutive drains agree before calling it ground truth.
        for (let i = 0; i < 5; i++) {
          await sleep(pollMs);
          const again = (await this.drain(accessToken)).transactions;
          if (fingerprint(again) === fingerprint(current)) break;
          current = again;
        }
        return { transactions: current, changed: true, attempts: attempt };
      }
    }
    return { transactions: before, changed: false, attempts };
  }

  /** Create a Sandbox Item and exchange its public token. */
  async createItem(opts: { username?: string; institutionId?: string; daysRequested?: number; webhook?: string } = {}) {
    const { public_token } = await this.call<{ public_token: string }>('/sandbox/public_token/create', {
      institution_id: opts.institutionId ?? 'ins_109508',
      initial_products: ['transactions'],
      options: {
        override_username: opts.username ?? 'user_transactions_dynamic',
        override_password: 'pass_good',
        transactions: { days_requested: opts.daysRequested ?? 30 },
        ...(opts.webhook ? { webhook: opts.webhook } : {}),
      },
    });
    const { access_token, item_id } = await this.call<{ access_token: string; item_id: string }>(
      '/item/public_token/exchange',
      { public_token },
    );
    return { accessToken: access_token, itemId: item_id };
  }

  transactionsSync(req: TransactionsSyncRequest): Promise<TransactionsSyncResponse> {
    return this.call('/transactions/sync', { access_token: req.access_token, cursor: req.cursor || undefined, count: req.count ?? 100 });
  }

  itemGet(accessToken: string): Promise<ItemGetResponse> {
    return this.call('/item/get', { access_token: accessToken });
  }

  refreshTransactions(accessToken: string): Promise<unknown> {
    return this.call('/transactions/refresh', { access_token: accessToken });
  }

  createTransactions(accessToken: string, transactions: SandboxTransactionInput[]): Promise<unknown> {
    return this.call('/sandbox/transactions/create', { access_token: accessToken, transactions });
  }

  resetLogin(accessToken: string): Promise<{ reset_login: boolean }> {
    return this.call('/sandbox/item/reset_login', { access_token: accessToken });
  }

  fireWebhook(accessToken: string, webhookCode: string, webhookType?: string): Promise<{ webhook_fired: boolean }> {
    return this.call('/sandbox/item/fire_webhook', {
      access_token: accessToken,
      webhook_code: webhookCode,
      ...(webhookType ? { webhook_type: webhookType } : {}),
    });
  }

  removeItem(accessToken: string): Promise<unknown> {
    return this.call('/item/remove', { access_token: accessToken });
  }

  /** Drain /transactions/sync from the start with the lab's own cursor (independent of the app). */
  async drain(accessToken: string): Promise<{ transactions: Transaction[]; status: string; cursor: string; pages: number }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const byId = new Map<string, Transaction>();
      let cursor = '';
      let status = '';
      let pages = 0;
      try {
        for (;;) {
          const page = await this.transactionsSync({ access_token: accessToken, cursor, count: 500 });
          pages += 1;
          for (const t of [...page.added, ...page.modified]) byId.set(t.transaction_id, t);
          for (const r of page.removed) byId.delete(r.transaction_id);
          cursor = page.next_cursor;
          status = page.transactions_update_status;
          if (!page.has_more) break;
        }
        return { transactions: [...byId.values()], status, cursor, pages };
      } catch (e) {
        if (e instanceof PlaidHttpError && e.body.error_code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') continue;
        throw e;
      }
    }
    throw new Error('ground-truth drain kept hitting TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
  }
}

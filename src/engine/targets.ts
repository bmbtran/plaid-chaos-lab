import type { AdapterFactory, AppStateSnapshot, IntegrationAdapter, PlaidClientLike, PlaidWebhook } from '../types.ts';
import type { FakeBank } from '../fake-plaid/bank.ts';
import { FakePlaidClient } from '../fake-plaid/client.ts';
import { FakePlaidHttpServer } from '../fake-plaid/http-server.ts';

export type DeliveryResult = { ok: true } | { ok: false; error: string };
export type ReconcileResult = { outcome: 'ran' } | { outcome: 'unsupported' } | { outcome: 'error'; message: string };

/** Something the lab can run scenarios against. One `begin`/`end` pair per run. */
/**
 * What a run gives the app to talk to: the fake bank (synthetic / recorded
 * runs) or a ready-made client for real Plaid Sandbox.
 */
export interface RunEnvironment {
  seed: number;
  bank?: FakeBank;
  client?: PlaidClientLike;
}

export interface Target {
  readonly description: string;
  /** How long fake-API silence must last before the app is considered idle. */
  readonly quietMs: number;
  /** True when the lab can see the app's Plaid calls (needed to detect quiescence precisely). */
  readonly observesCalls: boolean;
  init(): Promise<void>;
  begin(env: RunEnvironment): Promise<void>;
  registerItem(itemId: string, accessToken: string): Promise<void>;
  deliverWebhook(payload: PlaidWebhook): Promise<DeliveryResult>;
  getState(itemId: string): Promise<AppStateSnapshot>;
  reconcile(itemId: string): Promise<ReconcileResult>;
  end(): Promise<void>;
  dispose(): Promise<void>;
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ───────────────────────── in-process ─────────────────────────

export class InProcessTarget implements Target {
  readonly quietMs = 3;
  readonly observesCalls = true;
  private adapter: IntegrationAdapter | null = null;

  constructor(
    private readonly factory: AdapterFactory,
    readonly description = 'in-process adapter',
  ) {}

  async init(): Promise<void> {}

  async begin(env: RunEnvironment): Promise<void> {
    const plaid = env.client ?? (env.bank ? new FakePlaidClient(env.bank, env.seed) : null);
    if (!plaid) throw new Error('begin() needs a bank or a client');
    this.adapter = await this.factory({ plaid });
  }

  private get app(): IntegrationAdapter {
    if (!this.adapter) throw new Error('Target not started');
    return this.adapter;
  }

  async registerItem(itemId: string, accessToken: string): Promise<void> {
    await this.app.registerItem({ itemId, accessToken });
  }

  async deliverWebhook(payload: PlaidWebhook): Promise<DeliveryResult> {
    try {
      // Webhook bodies arrive as fresh JSON; never share object identity with the lab.
      await this.app.handleWebhook(structuredClone(payload));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMessage(e) };
    }
  }

  async getState(itemId: string): Promise<AppStateSnapshot> {
    return structuredClone(await this.app.getState(itemId));
  }

  async reconcile(itemId: string): Promise<ReconcileResult> {
    if (!this.app.reconcile) return { outcome: 'unsupported' };
    try {
      await this.app.reconcile(itemId);
      return { outcome: 'ran' };
    } catch (e) {
      return { outcome: 'error', message: errMessage(e) };
    }
  }

  async end(): Promise<void> {
    await this.adapter?.close?.();
    this.adapter = null;
  }

  async dispose(): Promise<void> {}
}

// ───────────────────────── HTTP ─────────────────────────

export interface HttpTargetOptions {
  webhookUrl: string;
  controlUrl: string;
  plaidPort: number;
  plaidHost?: string;
  /** Webhook response timeout (Plaid uses 10s). */
  timeoutMs?: number;
}

/**
 * Black-box mode for apps in any language. The lab hosts a fake Plaid API
 * on `plaidPort`; the app must use it as its Plaid base URL and expose the
 * control endpoints documented in the README.
 */
export class HttpTarget implements Target {
  readonly quietMs = 150;
  /** Synthetic/recorded runs: the app calls our fake server, so we see its calls. Sandbox: it calls Plaid directly. */
  observesCalls = true;
  readonly description: string;
  private server = new FakePlaidHttpServer();
  plaidBaseUrl = '';

  constructor(private readonly opts: HttpTargetOptions) {
    this.description = `HTTP app (webhooks → ${opts.webhookUrl})`;
  }

  async init(): Promise<void> {
    this.plaidBaseUrl = await this.server.listen(this.opts.plaidPort, this.opts.plaidHost ?? '127.0.0.1');
  }

  async begin(env: RunEnvironment): Promise<void> {
    this.server.use(env.bank ?? null);
    this.observesCalls = !!env.bank;
    await this.control('POST', '/reset', {});
  }

  async registerItem(itemId: string, accessToken: string): Promise<void> {
    await this.control('POST', '/items', { item_id: itemId, access_token: accessToken });
  }

  async deliverWebhook(payload: PlaidWebhook): Promise<DeliveryResult> {
    try {
      const res = await fetch(this.opts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      await res.arrayBuffer();
      return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: errMessage(e) };
    }
  }

  async getState(itemId: string): Promise<AppStateSnapshot> {
    const res = await fetch(`${this.opts.controlUrl}/state?item_id=${encodeURIComponent(itemId)}`);
    if (!res.ok) throw new Error(`GET ${this.opts.controlUrl}/state failed: HTTP ${res.status}`);
    return (await res.json()) as AppStateSnapshot;
  }

  async reconcile(itemId: string): Promise<ReconcileResult> {
    try {
      const res = await fetch(`${this.opts.controlUrl}/reconcile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ item_id: itemId }),
      });
      await res.arrayBuffer();
      if (res.status === 404 || res.status === 501) return { outcome: 'unsupported' };
      return res.ok ? { outcome: 'ran' } : { outcome: 'error', message: `HTTP ${res.status}` };
    } catch (e) {
      return { outcome: 'error', message: errMessage(e) };
    }
  }

  async end(): Promise<void> {
    this.server.use(null);
  }

  async dispose(): Promise<void> {
    await this.server.close();
  }

  private async control(method: string, path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.opts.controlUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`${method} ${this.opts.controlUrl}${path} failed: HTTP ${res.status}`);
  }
}

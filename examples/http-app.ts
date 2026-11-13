/**
 * The reference app as a real HTTP service talking to Plaid through the
 * official `plaid` npm SDK. Use it to try HTTP mode, or as a template for the
 * control endpoints your own app (in any language) needs to expose.
 *
 *   # terminal 1 — the app (official SDK pointed at the lab's fake Plaid API)
 *   PLAID_BASE_URL=http://127.0.0.1:4010 npx tsx examples/http-app.ts
 *   # terminal 2 — the lab
 *   npx tsx src/cli.ts run --webhook-url http://127.0.0.1:3005/webhooks/plaid \
 *       --control-url http://127.0.0.1:3005/chaos --plaid-port 4010
 *
 * Env: PORT (3005) · PLAID_BASE_URL · PLAID_SDK=current|legacy · CHAOS_BUGS (see naive-adapter.ts)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaidClient } from 'plaid';
import { Configuration, PlaidApi } from 'plaid/legacy';
import type { IntegrationAdapter, PlaidClientLike, PlaidWebhook } from '../src/types.ts';
import { type Bugs, createReferenceApp, NO_BUGS } from './reference-app.ts';

export type SdkFlavor = 'current' | 'legacy';

/** Build a Plaid client from the official SDK, pointed at `baseUrl`. */
export function officialPlaidClient(
  baseUrl: string,
  flavor: SdkFlavor,
  creds: { clientId: string; secret: string } = { clientId: 'chaos-client', secret: 'chaos-secret' },
): PlaidClientLike {
  if (flavor === 'legacy') {
    // Classic axios-based PlaidApi: already has the PlaidClientLike call shape.
    const api = new PlaidApi(
      new Configuration({
        basePath: baseUrl,
        baseOptions: { headers: { 'PLAID-CLIENT-ID': creds.clientId, 'PLAID-SECRET': creds.secret } },
      }),
    );
    return api as unknown as PlaidClientLike;
  }
  // v51+ PlaidClient: responses are bodies; errors are PlaidError with `.body`.
  const client = new PlaidClient({ baseUrl, clientId: creds.clientId, secret: creds.secret, maxRetries: 0 });
  return {
    async transactionsSync(req) {
      const data = await client.transactions.sync({
        access_token: req.access_token,
        cursor: req.cursor ?? undefined,
        count: req.count,
      });
      return { data: data as never };
    },
    async itemGet(req) {
      return { data: (await client.item.get({ access_token: req.access_token })) as never };
    },
  };
}

export interface HttpAppOptions {
  port?: number;
  plaidBaseUrl: string;
  sdk?: SdkFlavor;
  bugs?: Partial<Bugs>;
  /** Real Plaid credentials, for running against Sandbox. Omit for the lab's fake Plaid API. */
  creds?: { clientId: string; secret: string };
}

export async function startHttpApp(opts: HttpAppOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const plaid = officialPlaidClient(opts.plaidBaseUrl, opts.sdk ?? 'current', opts.creds);
  const bugs = { ...NO_BUGS, ...opts.bugs };
  let app: IntegrationAdapter = createReferenceApp(plaid, bugs);

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    try {
      if (req.method === 'POST' && url.pathname === '/webhooks/plaid') {
        // Acknowledge fast (Plaid times out after 10s) and do the work asynchronously.
        json(200, { received: true });
        app.handleWebhook(body as PlaidWebhook).catch((err) => console.error('[http-app] webhook failed:', err?.message ?? err));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/chaos/reset') {
        app = createReferenceApp(plaid, bugs);
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/chaos/items') {
        await app.registerItem({ itemId: body.item_id, accessToken: body.access_token });
        return json(200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/chaos/state') {
        return json(200, await app.getState(url.searchParams.get('item_id') ?? ''));
      }
      if (req.method === 'POST' && url.pathname === '/chaos/reconcile') {
        if (!app.reconcile) return json(501, { error: 'no reconciliation job' });
        await app.reconcile(body.item_id);
        return json(200, { ok: true });
      }
      json(404, { error: 'not found' });
    } catch (err) {
      json(500, { error: String((err as Error)?.message ?? err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && /http-app\.ts$/.test(process.argv[1])) {
  const { bugsFromEnv } = await import('./naive-adapter.ts');
  const { loadSandboxCredentials, SANDBOX_BASE_URL } = await import('../src/sandbox/api.ts');
  const plaidBaseUrl = process.env.PLAID_BASE_URL ?? 'http://127.0.0.1:4010';
  const app = await startHttpApp({
    port: Number(process.env.PORT ?? 3005),
    plaidBaseUrl,
    sdk: (process.env.PLAID_SDK as SdkFlavor) ?? 'current',
    bugs: process.env.CHAOS_BUGS ? bugsFromEnv() : NO_BUGS,
    creds: plaidBaseUrl === SANDBOX_BASE_URL ? loadSandboxCredentials() : undefined,
  });
  console.log(`[http-app] listening on ${app.url}; webhooks at /webhooks/plaid, control at /chaos; Plaid at ${plaidBaseUrl}`);
}

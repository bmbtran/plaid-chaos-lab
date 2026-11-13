import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeBank } from './bank.ts';
import { FakePlaidError } from './errors.ts';

/**
 * Wire-level fake of the two Plaid endpoints the lab models. Works with the
 * official `plaid` Node SDK (both `PlaidClient` and `plaid/legacy` PlaidApi)
 * by pointing its base URL here. Credentials are accepted but not checked.
 */
export class FakePlaidHttpServer {
  private server: http.Server;
  private bank: FakeBank | null = null;

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  /** Swap in the ground truth for the current run. */
  use(bank: FakeBank | null): void {
    this.bank = bank;
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve());
    });
    const addr = this.server.address() as AddressInfo;
    return `http://${host}:${addr.port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const bank = this.bank;
    if (!bank) return send(503, { error_code: 'CHAOS_LAB_IDLE', error_message: 'No scenario is running' });
    if (req.method !== 'POST') return send(405, { error_code: 'METHOD_NOT_ALLOWED' });

    let body: Record<string, unknown>;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      return send(400, { error_type: 'INVALID_REQUEST', error_code: 'INVALID_BODY', error_message: 'body is not valid JSON', status: 400 });
    }

    const path = (req.url ?? '').split('?')[0];
    bank.inflight += 1;
    bank.callCount += 1;
    try {
      if (path === '/transactions/sync') {
        return send(
          200,
          bank.transactionsSync({
            access_token: String(body.access_token ?? ''),
            cursor: (body.cursor as string | undefined) ?? '',
            count: body.count as number | undefined,
          }),
        );
      }
      if (path === '/item/get') return send(200, bank.itemGet({ access_token: String(body.access_token ?? '') }));
      return send(404, {
        error_type: 'INVALID_REQUEST',
        error_code: 'UNKNOWN_FIELDS',
        error_message: `Chaos Lab does not simulate ${path}`,
        status: 404,
      });
    } catch (err) {
      if (err instanceof FakePlaidError) return send(err.body.status, { ...err.body, request_id: 'chaos-http' });
      return send(500, { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', error_message: String(err), status: 500 });
    } finally {
      bank.inflight -= 1;
    }
  }
}

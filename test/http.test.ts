import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpTarget } from '../src/engine/targets.ts';
import { SCENARIOS, getScenario } from '../src/scenarios/index.ts';
import { runScenario } from '../src/engine/runner.ts';
import { type SdkFlavor, startHttpApp } from '../examples/http-app.ts';
import type { Bugs } from '../examples/reference-app.ts';

async function withHttpApp(sdk: SdkFlavor, bugs: Partial<Bugs>, fn: (t: HttpTarget) => Promise<void>) {
  // The app needs the fake Plaid URL and the lab needs the app URL, so start the lab's server first.
  const probe = new HttpTarget({ webhookUrl: '', controlUrl: '', plaidPort: 0 });
  await probe.init();
  const app = await startHttpApp({ plaidBaseUrl: probe.plaidBaseUrl, sdk, bugs });
  const port = Number(new URL(probe.plaidBaseUrl).port);
  await probe.dispose();
  const target = new HttpTarget({ webhookUrl: `${app.url}/webhooks/plaid`, controlUrl: `${app.url}/chaos`, plaidPort: port });
  await target.init();
  try {
    await fn(target);
  } finally {
    await app.close();
    await target.dispose();
  }
}

const quiet = () => {
  const original = console.error;
  console.error = () => {};
  return () => (console.error = original);
};

for (const sdk of ['current', 'legacy'] as const) {
  test(`HTTP mode with the official plaid SDK (${sdk}): robust app passes every scenario`, async () => {
    await withHttpApp(sdk, {}, async (t) => {
      for (const s of SCENARIOS) {
        const r = await runScenario(t, s, 2);
        assert.ok(r.passed, `${s.id}: ${r.invariants.filter((i) => !i.passed).map((i) => i.message).join('; ')}`);
      }
    });
  });
}

test('HTTP mode catches bugs over the wire (async handlers, official SDK errors)', async () => {
  const restore = quiet();
  try {
    await withHttpApp('current', { noRestartOnMutation: true, noReconcile: true }, async (t) => {
      const mutation = await runScenario(t, getScenario('mutation-during-pagination'), 1);
      assert.equal(mutation.passed, false);
      assert.ok(mutation.invariants.some((i) => i.id === 'sync-restarts-from-original-cursor' && !i.passed));
      const reconcile = await runScenario(t, getScenario('missed-webhook-reconcile'), 1);
      assert.equal(reconcile.passed, false);
      assert.ok(reconcile.timeline.some((e) => e.kind === 'reconcile' && e.outcome === 'unsupported'));
    });
  } finally {
    restore();
  }
});

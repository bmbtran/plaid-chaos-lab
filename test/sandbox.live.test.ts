// Live tests against real Plaid Sandbox. Opt-in: CHAOS_LIVE=1 and Sandbox keys in .env.
//   npm run test:sandbox
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InProcessTarget } from '../src/engine/targets.ts';
import { replay, toFixture } from '../src/engine/fixture.ts';
import { hasSandboxCredentials, loadSandboxCredentials, SandboxApi } from '../src/sandbox/api.ts';
import { runSandboxScenario } from '../src/sandbox/runner.ts';
import { SANDBOX_SCENARIOS } from '../src/sandbox/scenarios.ts';
import { type Bugs, createReferenceApp } from '../examples/reference-app.ts';

const optedIn = process.env.CHAOS_LIVE === '1' || process.env.npm_lifecycle_event === 'test:sandbox';
const live = optedIn && hasSandboxCredentials();
const skip = live ? false : 'set CHAOS_LIVE=1 and put Sandbox keys in .env';
const target = (bugs: Partial<Bugs> = {}) => new InProcessTarget(({ plaid }) => createReferenceApp(plaid, bugs));
const scenario = (id: string) => SANDBOX_SCENARIOS.find((s) => s.id === id)!;

test('real Sandbox: robust app passes pending→posted; ignoring `removed` is caught; nothing leaks credentials', { skip, timeout: 600_000 }, async () => {
  const creds = loadSandboxCredentials();
  const api = new SandboxApi(creds);

  const good = await runSandboxScenario({ api, target: target(), scenario: scenario('sandbox-pending-to-posted'), seed: 1 });
  assert.ok(good.passed, good.invariants.filter((i) => !i.passed).map((i) => i.message).join('; '));
  assert.ok(good.timeline.some((e) => e.kind === 'bank' && /pending→posted/.test(e.summary)), 'Sandbox really posted pending transactions');

  const bad = await runSandboxScenario({ api, target: target({ ignoreRemoved: true }), scenario: scenario('sandbox-pending-to-posted'), seed: 1 });
  assert.equal(bad.passed, false);
  assert.ok(bad.invariants.some((i) => i.id === 'no-pending-posted-double-count' && !i.passed));

  // The recorded fixture reproduces the real failure offline.
  const offline = await replay(toFixture(bad, scenario('sandbox-pending-to-posted')), target({ ignoreRemoved: true }));
  assert.equal(offline.passed, false);

  for (const r of [good, bad]) {
    const json = JSON.stringify([r, toFixture(r)]);
    assert.ok(!json.includes(creds.secret) && !json.includes(creds.clientId), 'credentials must never reach results or fixtures');
  }
});

test('real Sandbox: reset_login is reflected, data survives, a stale LOGIN_REPAIRED is not trusted', { skip, timeout: 600_000 }, async () => {
  const api = new SandboxApi(loadSandboxCredentials());
  const good = await runSandboxScenario({ api, target: target(), scenario: scenario('sandbox-login-required'), seed: 1 });
  assert.ok(good.passed, good.invariants.filter((i) => !i.passed).map((i) => i.message).join('; '));
  assert.ok(good.timeline.some((e) => e.kind === 'api' && e.errorCode === 'ITEM_LOGIN_REQUIRED'), 'Sandbox really returned ITEM_LOGIN_REQUIRED');

  const trusting = await runSandboxScenario({ api, target: target({ trustWebhookOrder: true }), scenario: scenario('sandbox-login-required'), seed: 1 });
  assert.ok(trusting.invariants.some((i) => i.id === 'item-status-matches' && !i.passed));
});

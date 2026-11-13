/**
 * Programmatic API — use it to put Chaos Lab fixtures in your own test suite.
 *
 *   import { replayFixtureFile } from 'plaid-chaos-lab';
 *   const result = await replayFixtureFile('fixtures/pending-to-posted.seed3.json', myAdapterFactory);
 *   assert.ok(result.passed, result.invariants.filter(i => !i.passed).map(i => i.message).join('\n'));
 */
import type { AdapterFactory, RunResult, Scenario } from './types.ts';
import { InProcessTarget, type Target } from './engine/targets.ts';
import { exploreScenario, runScenario } from './engine/runner.ts';
import { readFixture, replay } from './engine/fixture.ts';
import { getScenario, SCENARIOS } from './scenarios/index.ts';

export * from './types.ts';
export { SCENARIOS, getScenario } from './scenarios/index.ts';
export { INVARIANTS, LEDGER_CHECKS } from './engine/invariants.ts';
export { InProcessTarget, HttpTarget, type Target } from './engine/targets.ts';
export { runScript, runScenario, exploreScenario, type ScenarioSummary } from './engine/runner.ts';
export { toFixture, writeFixture, readFixture, replay, type Fixture } from './engine/fixture.ts';
export { FakeBank } from './fake-plaid/bank.ts';
export { FakePlaidClient } from './fake-plaid/client.ts';
export { FakePlaidHttpServer } from './fake-plaid/http-server.ts';

const asTarget = (t: Target | AdapterFactory): Target => (typeof t === 'function' ? new InProcessTarget(t) : t);

/** Replay a fixture file against an adapter factory (or any Target). */
export async function replayFixtureFile(path: string, target: Target | AdapterFactory): Promise<RunResult> {
  const t = asTarget(target);
  await t.init();
  try {
    return await replay(await readFixture(path), t);
  } finally {
    await t.dispose();
  }
}

/** Run one scenario (by id or object) for one seed. */
export async function runOne(scenario: string | Scenario, seed: number, target: Target | AdapterFactory): Promise<RunResult> {
  const t = asTarget(target);
  await t.init();
  try {
    return await runScenario(t, typeof scenario === 'string' ? getScenario(scenario) : scenario, seed);
  } finally {
    await t.dispose();
  }
}

/** Run every scenario across `seeds` and return one summary per scenario. */
export async function runAll(target: Target | AdapterFactory, seeds: number[] = [1, 2, 3, 4, 5]) {
  const t = asTarget(target);
  await t.init();
  try {
    const out = [];
    for (const s of SCENARIOS) out.push(await exploreScenario(t, s, seeds));
    return out;
  } finally {
    await t.dispose();
  }
}

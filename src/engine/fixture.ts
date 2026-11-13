import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { InvariantId, RunResult, Script } from '../types.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import { runScript } from './runner.ts';
import type { Target } from './targets.ts';

export const FIXTURE_VERSION = 1;

/**
 * A fully-materialized, replayable counterexample. Replaying it runs the exact
 * same steps regardless of later changes to scenario generators.
 */
export interface Fixture {
  fixtureVersion: number;
  tool: 'plaid-chaos-lab';
  scenario: string;
  title: string;
  seed: number;
  finalChecks: InvariantId[];
  script: Script;
  observed: {
    passed: boolean;
    failures: Array<{ id: InvariantId; at: string; message: string }>;
    impact: string[];
  };
}

export function toFixture(run: RunResult): Fixture {
  const scenario = SCENARIOS.find((s) => s.id === run.scenario);
  return {
    fixtureVersion: FIXTURE_VERSION,
    tool: 'plaid-chaos-lab',
    scenario: run.scenario,
    title: scenario?.title ?? run.scenario,
    seed: run.seed,
    finalChecks: scenario?.finalChecks ?? [],
    script: run.script,
    observed: {
      passed: run.passed,
      failures: run.invariants
        .filter((i) => !i.passed && i.severity === 'error')
        .map(({ id, at, message }) => ({ id, at, message })),
      impact: run.impact,
    },
  };
}

export async function writeFixture(path: string, run: RunResult): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(toFixture(run), null, 2) + '\n', 'utf8');
}

export async function readFixture(path: string): Promise<Fixture> {
  const f = JSON.parse(await readFile(path, 'utf8')) as Fixture;
  if (f.tool !== 'plaid-chaos-lab' || !f.script?.steps) throw new Error(`${path} is not a Chaos Lab fixture`);
  if (f.fixtureVersion > FIXTURE_VERSION) throw new Error(`${path} needs a newer Chaos Lab (fixture v${f.fixtureVersion})`);
  return f;
}

/** Re-run a fixture's exact event sequence against a target. */
export async function replay(fixture: Fixture, target: Target): Promise<RunResult> {
  const meta = SCENARIOS.find((s) => s.id === fixture.scenario);
  return runScript({
    target,
    seed: fixture.seed,
    script: fixture.script,
    scenario: {
      id: fixture.scenario,
      title: fixture.title,
      summary: meta?.summary ?? '',
      whyItMatters: meta?.whyItMatters ?? '',
      docs: meta?.docs ?? [],
      finalChecks: fixture.finalChecks.length ? fixture.finalChecks : meta?.finalChecks ?? [],
    },
  });
}

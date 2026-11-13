import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { InvariantId, RunResult, RunSource, ScenarioMeta, Script } from '../types.ts';
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
  /** Where the recorded events came from. Sandbox runs replay their observed transitions offline. */
  source: RunSource;
  seed: number;
  finalChecks: InvariantId[];
  script: Script;
  observed: {
    passed: boolean;
    failures: Array<{ id: InvariantId; at: string; message: string }>;
    impact: string[];
  };
}

export function toFixture(run: RunResult, meta?: ScenarioMeta): Fixture {
  const scenario = meta ?? SCENARIOS.find((s) => s.id === run.scenario);
  return {
    fixtureVersion: FIXTURE_VERSION,
    tool: 'plaid-chaos-lab',
    scenario: run.scenario,
    title: scenario?.title ?? run.scenario,
    source: run.source,
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

export async function writeFixture(path: string, run: RunResult, meta?: ScenarioMeta): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(toFixture(run, meta), null, 2) + '\n', 'utf8');
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
    source: (fixture.source ?? 'synthetic') === 'synthetic' ? 'synthetic' : 'recorded',
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

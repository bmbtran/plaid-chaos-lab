import type {
  InvariantId,
  InvariantResult,
  NewTimelineEvent,
  RunResult,
  RunSource,
  Transaction,
  Scenario,
  ScenarioMeta,
  Script,
  StateCapture,
  Step,
  TimelineEvent,
} from '../types.ts';
import { FakeBank, summarizeOps } from '../fake-plaid/bank.ts';
import { runChecks } from './invariants.ts';
import { userImpact } from './impact.ts';
import type { Target } from './targets.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Execute one fully-materialized script against a target. */
export async function runScript(args: {
  target: Target;
  scenario: ScenarioMeta;
  script: Script;
  seed: number;
  source?: RunSource;
}): Promise<RunResult> {
  const { target, scenario, script, seed } = args;
  const timeline: TimelineEvent[] = [];
  const push = (e: NewTimelineEvent) => {
    timeline.push({ ...e, seq: timeline.length + 1 } as TimelineEvent);
  };
  const bank = new FakeBank(script.pageSize, push);
  const invariants: InvariantResult[] = [];
  const states: StateCapture[] = [];
  let concurrentGroup = 0;

  const settle = async () => {
    const deadline = Date.now() + 5_000;
    let lastCount = -1;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if (bank.inflight > 0 || bank.callCount !== lastCount) {
        lastCount = bank.callCount;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= target.quietMs) {
        return;
      }
      await sleep(1);
    }
  };

  const capture = async (labelText: string, checks: InvariantId[]) => {
    await settle();
    for (const itemId of bank.itemIds()) {
      const app = await target.getState(itemId);
      const truth = bank.truth(itemId);
      const truthStatus = bank.itemStatus(itemId);
      states.push({ label: labelText, app, truth: { transactions: truth, itemStatus: truthStatus } });
      invariants.push(
        ...runChecks(checks, {
          at: labelText,
          itemId,
          app,
          truth,
          truthStatus,
          seen: bank.seen,
          replacements: bank.replacements,
          timeline,
        }),
      );
    }
  };

  const exec = async (step: Step, group?: number): Promise<void> => {
    switch (step.type) {
      case 'register-item':
        bank.createItem(step.item_id, step.access_token);
        push({ kind: 'register', itemId: step.item_id });
        await target.registerItem(step.item_id, step.access_token);
        return;
      case 'bank': {
        const summary = summarizeOps(step.ops, bank.seen);
        const version = bank.apply(step.item_id, step.ops);
        push({ kind: 'bank', itemId: step.item_id, version, summary, note: step.note });
        return;
      }
      case 'item-error':
        bank.setItemError(step.item_id, step.error_code);
        push({ kind: 'item-error', itemId: step.item_id, errorCode: step.error_code, note: step.note });
        return;
      case 'arm-mutation':
        bank.arm(step.item_id, step.after_page, step.ops);
        push({
          kind: 'armed',
          itemId: step.item_id,
          afterPage: step.after_page,
          summary: summarizeOps(step.ops, bank.seen),
          note: step.note,
        });
        return;
      case 'webhook': {
        push({
          kind: 'webhook',
          code: step.payload.webhook_code,
          itemId: step.payload.item_id,
          delivery: 'delivered',
          note: step.note,
          concurrentGroup: group,
        });
        const res = await target.deliverWebhook(step.payload);
        if (!res.ok) push({ kind: 'handler-error', code: step.payload.webhook_code, message: res.error });
        return;
      }
      case 'drop-webhook':
        push({ kind: 'webhook', code: step.payload.webhook_code, itemId: step.payload.item_id, delivery: 'dropped', note: step.note });
        return;
      case 'concurrent': {
        const g = ++concurrentGroup;
        await Promise.all(step.steps.map((s) => exec(s, g)));
        return;
      }
      case 'reconcile': {
        const res = await target.reconcile(step.item_id);
        push({
          kind: 'reconcile',
          itemId: step.item_id,
          outcome: res.outcome,
          message: res.outcome === 'error' ? res.message : step.note,
        });
        return;
      }
      case 'checkpoint':
        push({ kind: 'checkpoint', label: step.label });
        await capture(step.label, step.checks);
        return;
    }
  };

  await target.begin({ bank, seed });
  try {
    for (const step of script.steps) {
      await exec(step);
      if (step.type !== 'bank' && step.type !== 'item-error' && step.type !== 'arm-mutation') await settle();
    }
    push({ kind: 'checkpoint', label: 'final' });
    await capture('final', [...scenario.finalChecks, 'webhook-handlers-succeed']);
  } finally {
    await target.end();
  }

  const impact: string[] = [];
  for (const s of states) {
    const failedHere = invariants.some((r) => r.at === s.label && !r.passed && r.severity === 'error');
    if (!failedHere) continue;
    const lines = userImpact({
      app: s.app,
      truth: s.truth.transactions,
      truthStatus: s.truth.itemStatus,
      seen: bank.seen,
      replacements: bank.replacements,
    });
    impact.push(...lines.map((l) => (s.label === 'final' ? l : `[${s.label}] ${l}`)));
  }

  return {
    scenario: scenario.id,
    source: args.source ?? 'synthetic',
    seed,
    pageSize: script.pageSize,
    passed: !invariants.some((r) => !r.passed && r.severity === 'error'),
    invariants,
    impact,
    timeline,
    states,
    script,
  };
}

export async function runScenario(target: Target, scenario: Scenario, seed: number, pool?: Transaction[]): Promise<RunResult> {
  return runScript({ target, scenario, script: scenario.build(seed, pool), seed, source: pool ? 'recorded' : 'synthetic' });
}

export interface ScenarioSummary {
  scenario: ScenarioMeta;
  seeds: number[];
  failedSeeds: number[];
  /** First failing run (the counterexample), or the first run if all passed. */
  representative: RunResult;
  warnings: number;
  /** Set when real Sandbox couldn't produce the scenario's situation; the run neither passed nor failed. */
  inconclusive?: string;
}

/** Run a scenario across many seeds; keep the first failure as the counterexample. */
export async function exploreScenario(
  target: Target,
  scenario: Scenario,
  seeds: number[],
  opts: { pool?: Transaction[]; onRun?: (r: RunResult) => void } = {},
): Promise<ScenarioSummary> {
  const failedSeeds: number[] = [];
  let representative: RunResult | null = null;
  let warnings = 0;
  for (const seed of seeds) {
    const r = await runScenario(target, scenario, seed, opts.pool);
    const onRun = opts.onRun;
    onRun?.(r);
    if (r.invariants.some((i) => !i.passed && i.severity === 'warn')) warnings += 1;
    if (!r.passed) {
      failedSeeds.push(seed);
      representative ??= r;
    }
    if (!representative && seed === seeds[seeds.length - 1]) representative = r;
  }
  return { scenario, seeds, failedSeeds, representative: representative!, warnings };
}

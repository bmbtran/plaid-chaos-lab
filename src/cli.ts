import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdapterFactory, RunResult, ScenarioMeta, Transaction } from './types.ts';
import { getScenario, SCENARIOS } from './scenarios/index.ts';
import { exploreScenario, type ScenarioSummary } from './engine/runner.ts';
import { HttpTarget, InProcessTarget, type Target } from './engine/targets.ts';
import { readFixture, replay, writeFixture } from './engine/fixture.ts';
import { renderConsole } from './report/console.ts';
import { renderMarkdown } from './report/markdown.ts';
import { INVARIANTS } from './engine/invariants.ts';
import { loadSandboxCredentials, PlaidHttpError, SandboxApi } from './sandbox/api.ts';
import { readCassette, recordCassette, writeCassette } from './sandbox/cassette.ts';
import { RECORDED_FALLBACKS, SANDBOX_SCENARIOS } from './sandbox/scenarios.ts';
import { InconclusiveError, runSandboxScenario } from './sandbox/runner.ts';

const HELP = `Plaid Integration Chaos Lab (unofficial)

Usage
  chaos-lab list
  chaos-lab run     <target> [options]
  chaos-lab run     <target> --sandbox [--data cassette.json]
  chaos-lab record  [--out cassette.json]
  chaos-lab replay  <fixture.json...> <target>

Target
  --adapter <module>       In-process adapter (default export: AdapterFactory)
  --webhook-url <url>      HTTP mode: where the lab POSTs webhooks
  --control-url <url>      HTTP mode: base URL of /reset, /items, /state, /reconcile
  --plaid-port <port>      HTTP mode: port for the fake Plaid API (default 4010)

Data
  (default)                Synthetic transactions on the fake bank
  --data <cassette.json>   Transactions recorded from Plaid Sandbox (see: record)
  --sandbox                Real Plaid Sandbox for what it can reproduce; recorded
                           Sandbox data on the fake bank for everything else.
                           Needs PLAID_CLIENT_ID and PLAID_SECRET (Sandbox) in .env

Options
  --scenario <ids>         Comma-separated scenario ids (default: all)
  --seed <n>               First seed (default 1)
  --runs <n>               Seeds per scenario (default 10; 1 for real Sandbox scenarios)
  --out <path>             Report directory, or cassette file for record
  --no-report              Skip report files and fixtures
  --json                   Print the JSON report instead of the console view

Exit codes: 0 passed, 1 an invariant failed, 2 usage or setup error`;

/** Bad command line: print the message and the usage text. */
class UsageError extends Error {}
/** Bad environment (credentials, Plaid unavailable): print just the message. */
class SetupError extends Error {}

const options = {
  adapter: { type: 'string' },
  'webhook-url': { type: 'string' },
  'control-url': { type: 'string' },
  'plaid-port': { type: 'string', default: '4010' },
  scenario: { type: 'string' },
  seed: { type: 'string', default: '1' },
  runs: { type: 'string' },
  out: { type: 'string' },
  data: { type: 'string' },
  sandbox: { type: 'boolean', default: false },
  'no-report': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>['values'];

function int(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer`);
  return n;
}

async function loadAdapter(path: string): Promise<AdapterFactory> {
  const mod = await import(pathToFileURL(resolve(path)).href);
  const factory = mod.default ?? mod.createAdapter;
  if (typeof factory !== 'function') {
    throw new UsageError(`${path} must default-export an adapter factory: ({ plaid }) => IntegrationAdapter`);
  }
  return factory as AdapterFactory;
}

async function makeTarget(v: Values): Promise<{ target: Target; label: string; args: string }> {
  if (v.adapter) {
    return { target: new InProcessTarget(await loadAdapter(v.adapter), `adapter ${v.adapter}`), label: v.adapter, args: `--adapter ${v.adapter}` };
  }
  if (v['webhook-url']) {
    if (!v['control-url']) throw new UsageError('--control-url is required with --webhook-url');
    const target = new HttpTarget({
      webhookUrl: v['webhook-url'],
      controlUrl: v['control-url'],
      plaidPort: int('plaid-port', v['plaid-port'], 4010),
    });
    return {
      target,
      label: v['webhook-url'],
      args: `--webhook-url ${v['webhook-url']} --control-url ${v['control-url']} --plaid-port ${v['plaid-port']}`,
    };
  }
  throw new UsageError('Pick a target: --adapter <module>, or --webhook-url <url> --control-url <url>');
}

const timestamp = () => new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
const posix = (p: string) => relative(process.cwd(), p).replace(/\\/g, '/');
// Progress goes to stderr and only to a terminal, so logs and pipes stay clean.
const progress = (v: Values, msg: string) => {
  if (!v.json && process.stderr.isTTY) process.stderr.write(`\x1b[2K\r  ${msg.slice(0, (process.stderr.columns ?? 80) - 4)}`);
};
const clearProgress = (v: Values) => {
  if (!v.json && process.stderr.isTTY) process.stderr.write('\x1b[2K\r');
};

function sandboxApi(): SandboxApi {
  try {
    return new SandboxApi(loadSandboxCredentials());
  } catch (e) {
    throw new SetupError((e as Error).message);
  }
}

async function cmdRun(v: Values): Promise<number> {
  const firstSeed = int('seed', v.seed, 1);
  const runs = int('runs', v.runs, 10);
  if (runs < 1) throw new UsageError('--runs must be at least 1');
  const seeds = Array.from({ length: runs }, (_, i) => firstSeed + i);
  const wanted = v.scenario?.split(',').map((s) => s.trim());
  const { target, label, args } = await makeTarget(v);
  const summaries: ScenarioSummary[] = [];
  const metas = new Map<string, ScenarioMeta>();
  const outDir = v.out ?? join('chaos-reports', timestamp());
  const writeReport = !v['no-report'];
  let pool: Transaction[] | undefined;
  let api: SandboxApi | null = null;
  let dataLabel = 'synthetic data';

  if (v.sandbox) api = sandboxApi();
  if (v.data) {
    const cassette = await readCassette(v.data);
    pool = cassette.transactions;
    dataLabel = `recorded data from ${v.data}`;
  }

  await target.init();
  if (target instanceof HttpTarget && !v.json && !v.sandbox) {
    console.error(`Fake Plaid API on ${target.plaidBaseUrl}. Point your app's Plaid base URL here.`);
  }

  try {
    if (api) {
      // Real Sandbox first, for everything it can reproduce.
      const sandboxSeeds = v.runs === undefined ? [firstSeed] : seeds;
      for (const scenario of SANDBOX_SCENARIOS.filter((s) => !wanted || wanted.includes(s.id))) {
        metas.set(scenario.id, scenario);
        const failedSeeds: number[] = [];
        let first: RunResult | null = null;
        let firstFailure: RunResult | null = null;
        let inconclusive: string | undefined;
        for (const seed of sandboxSeeds) {
          try {
            const r = await runSandboxScenario({ api, target, scenario, seed, log: (m) => progress(v, `sandbox: ${m}`) });
            first ??= r;
            if (!r.passed) {
              failedSeeds.push(seed);
              firstFailure ??= r;
            }
          } catch (e) {
            if (!(e instanceof InconclusiveError || e instanceof PlaidHttpError)) throw e;
            inconclusive = e.message;
          }
        }
        clearProgress(v);
        const placeholder: RunResult = {
          scenario: scenario.id,
          source: 'sandbox',
          seed: sandboxSeeds[0],
          pageSize: 100,
          passed: false,
          invariants: [],
          impact: [],
          timeline: [],
          states: [],
          script: { pageSize: 100, steps: [] },
        };
        summaries.push({
          scenario,
          seeds: sandboxSeeds,
          failedSeeds,
          representative: firstFailure ?? first ?? placeholder,
          warnings: 0,
          inconclusive: firstFailure || first ? undefined : inconclusive,
        });
      }
      const fallbacksWanted = SCENARIOS.some((s) => (wanted ? wanted.includes(s.id) : RECORDED_FALLBACKS.includes(s.id)));
      if (!pool && fallbacksWanted) {
        const cassette = await recordCassette(api, (m) => progress(v, `recording Sandbox data · ${m}`));
        pool = cassette.transactions;
        if (writeReport) await writeCassette(join(outDir, 'cassette.json'), cassette);
        clearProgress(v);
      }
      dataLabel = pool ? 'real Plaid Sandbox, plus recorded Sandbox data for the rest' : 'real Plaid Sandbox';
    }

    const fakeScenarios = SCENARIOS.filter((s) => (wanted ? wanted.includes(s.id) : api ? RECORDED_FALLBACKS.includes(s.id) : true));
    for (const scenario of fakeScenarios) {
      metas.set(scenario.id, scenario);
      progress(v, `running ${scenario.id}`);
      summaries.push(await exploreScenario(target, scenario, seeds, { pool }));
    }
    clearProgress(v);
  } catch (e) {
    clearProgress(v);
    if (e instanceof PlaidHttpError) throw new SetupError(`Plaid Sandbox error: ${e.message}`);
    throw e;
  } finally {
    await target.dispose();
  }
  if (!summaries.length) throw new UsageError(`No scenario matches "${v.scenario}". Run "chaos-lab list".`);

  const fixtures: Record<string, string> = {};
  if (writeReport) {
    for (const s of summaries) {
      if (!s.failedSeeds.length) continue;
      const path = join(outDir, 'fixtures', `${s.scenario.id}.seed${s.representative.seed}.json`);
      await writeFixture(path, s.representative, metas.get(s.scenario.id));
      fixtures[s.scenario.id] = posix(path);
    }
  }

  const ctx = { target: label, data: dataLabel, seeds, summaries, fixtures, outDir: writeReport ? posix(outDir) : undefined, replayHint: args };
  const json = {
    tool: 'plaid-chaos-lab',
    target: label,
    data: dataLabel,
    seeds,
    passed: summaries.every((s) => !s.failedSeeds.length && !s.inconclusive),
    scenarios: summaries.map((s) => ({
      id: s.scenario.id,
      title: s.scenario.title,
      source: s.representative.source,
      passed: !s.failedSeeds.length && !s.inconclusive,
      inconclusive: s.inconclusive ?? null,
      seeds: s.seeds,
      failedSeeds: s.failedSeeds,
      warnings: s.warnings,
      fixture: fixtures[s.scenario.id] ?? null,
      counterexample: s.failedSeeds.length ? s.representative : null,
    })),
  };

  if (writeReport) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'report.json'), JSON.stringify(json, null, 2) + '\n');
    await writeFile(join(outDir, 'report.md'), renderMarkdown({ ...ctx, generatedAt: new Date().toISOString() }));
  }
  console.log(v.json ? JSON.stringify(json, null, 2) : renderConsole(ctx));
  if (summaries.some((s) => s.failedSeeds.length)) return 1;
  return summaries.some((s) => s.inconclusive) ? 2 : 0;
}

async function cmdRecord(v: Values): Promise<number> {
  const api = sandboxApi();
  const out = v.out ?? join('chaos-reports', `cassette-${timestamp()}.json`);
  const cassette = await recordCassette(api, (m) => progress(v, m));
  clearProgress(v);
  await writeCassette(out, cassette);
  const s = cassette.stats;
  console.log(
    `Recorded ${cassette.transactions.length} Sandbox transactions (${s.accounts} accounts, ${s.pendingPosted} pending→posted) to ${posix(resolve(out))}`,
  );
  console.log(`Use it with: chaos-lab run --adapter <module> --data ${posix(resolve(out))}`);
  return 0;
}

async function cmdReplay(v: Values, files: string[]): Promise<number> {
  if (!files.length) throw new UsageError('replay needs at least one fixture file');
  const { target, label, args } = await makeTarget(v);
  await target.init();
  const summaries: ScenarioSummary[] = [];
  const notes: string[] = [];
  try {
    for (const file of files) {
      const fixture = await readFixture(file);
      const run = await replay(fixture, target);
      const meta: ScenarioMeta = SCENARIOS.find((s) => s.id === fixture.scenario) ??
        SANDBOX_SCENARIOS.find((s) => s.id === fixture.scenario) ?? {
          id: fixture.scenario,
          title: fixture.title,
          summary: '',
          whyItMatters: '',
          docs: [],
          finalChecks: fixture.finalChecks,
        };
      summaries.push({ scenario: meta, seeds: [fixture.seed], failedSeeds: run.passed ? [] : [fixture.seed], representative: run, warnings: 0 });
      const was = fixture.observed.passed ? 'passed' : 'failed';
      notes.push(`${file}: ${was} when recorded, ${run.passed ? 'passes now' : 'still fails'}.`);
    }
  } finally {
    await target.dispose();
  }
  if (v.json) console.log(JSON.stringify(summaries.map((s) => s.representative), null, 2));
  else {
    console.log(renderConsole({ target: label, data: 'replayed fixture', seeds: [0], summaries, fixtures: {}, replayHint: args }));
    for (const n of notes) console.log(n);
  }
  return summaries.every((s) => !s.failedSeeds.length) ? 0 : 1;
}

function cmdList(): number {
  const row = (id: string, text: string) => console.log(`  ${id.padEnd(32)}${text}`);
  console.log('Scenarios (fake bank; synthetic or recorded data)\n');
  for (const s of SCENARIOS) row(s.id, s.title);
  console.log('\nScenarios (real Plaid Sandbox, with --sandbox)\n');
  for (const s of SANDBOX_SCENARIOS) row(s.id, s.title);
  console.log('\nInvariants\n');
  for (const i of Object.values(INVARIANTS)) row(i.id, `${i.severity === 'warn' ? '(warning) ' : ''}${i.description}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  try {
    if (values.help || !command || command === 'help') {
      console.log(HELP);
      return command || values.help ? 0 : 2;
    }
    if (command === 'list') return cmdList();
    if (command === 'run') return await cmdRun(values);
    if (command === 'record') return await cmdRecord(values);
    if (command === 'replay') return await cmdReplay(values, rest);
    throw new UsageError(`Unknown command "${command}"`);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${HELP}`);
      return 2;
    }
    if (e instanceof SetupError || e instanceof PlaidHttpError) {
      console.error(e instanceof PlaidHttpError ? `Plaid Sandbox error: ${e.message}` : e.message);
      return 2;
    }
    throw e;
  }
}

const invokedDirectly = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly || process.env.CHAOS_LAB_BIN) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}

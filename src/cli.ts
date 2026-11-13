import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdapterFactory } from './types.ts';
import { getScenario, SCENARIOS } from './scenarios/index.ts';
import { exploreScenario, type ScenarioSummary } from './engine/runner.ts';
import { HttpTarget, InProcessTarget, type Target } from './engine/targets.ts';
import { readFixture, replay, writeFixture } from './engine/fixture.ts';
import { renderConsole } from './report/console.ts';
import { renderMarkdown } from './report/markdown.ts';
import { INVARIANTS } from './engine/invariants.ts';

const HELP = `Plaid Integration Chaos Lab (unofficial)

Usage:
  chaos-lab list
  chaos-lab run    <target> [--scenario a,b] [--seed 1] [--runs 10] [--out dir] [--json]
  chaos-lab replay <fixture.json...> <target>

Target (one of):
  --adapter <module>         In-process adapter module (default export: AdapterFactory)
  --webhook-url <url>        HTTP mode: where the lab POSTs Plaid webhooks
    --control-url <url>      HTTP mode: base URL of /reset, /items, /state, /reconcile
    --plaid-port <port>      HTTP mode: port for the fake Plaid API (default 4010)

Options:
  --scenario <ids>   Comma-separated scenario ids (default: all)
  --seed <n>         First seed (default 1)
  --runs <n>         Seeds per scenario (default 10)
  --out <dir>        Report directory (default chaos-reports/<timestamp>)
  --no-report        Do not write report files or fixtures
  --json             Print the JSON report to stdout instead of the console view

Exit code: 0 all passed · 1 an invariant failed · 2 usage error`;

class UsageError extends Error {}

const options = {
  adapter: { type: 'string' },
  'webhook-url': { type: 'string' },
  'control-url': { type: 'string' },
  'plaid-port': { type: 'string', default: '4010' },
  scenario: { type: 'string' },
  seed: { type: 'string', default: '1' },
  runs: { type: 'string', default: '10' },
  out: { type: 'string' },
  'no-report': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>['values'];

function int(name: string, v: string | undefined): number {
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
    return {
      target: new InProcessTarget(await loadAdapter(v.adapter), `adapter ${v.adapter}`),
      label: `adapter ${v.adapter}`,
      args: `--adapter ${v.adapter}`,
    };
  }
  if (v['webhook-url']) {
    if (!v['control-url']) throw new UsageError('--control-url is required with --webhook-url');
    const target = new HttpTarget({
      webhookUrl: v['webhook-url'],
      controlUrl: v['control-url'],
      plaidPort: int('plaid-port', v['plaid-port']),
    });
    return {
      target,
      label: `HTTP app ${v['webhook-url']}`,
      args: `--webhook-url ${v['webhook-url']} --control-url ${v['control-url']} --plaid-port ${v['plaid-port']}`,
    };
  }
  throw new UsageError('Specify a target: --adapter <module> or --webhook-url <url> --control-url <url>');
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
}

async function cmdRun(v: Values): Promise<number> {
  const scenarios = v.scenario ? v.scenario.split(',').map((s) => getScenario(s.trim())) : SCENARIOS;
  const first = int('seed', v.seed);
  const runs = int('runs', v.runs);
  if (runs < 1) throw new UsageError('--runs must be at least 1');
  const seeds = Array.from({ length: runs }, (_, i) => first + i);
  const { target, label, args } = await makeTarget(v);

  await target.init();
  if (target instanceof HttpTarget && !v.json) {
    console.error(`Fake Plaid API listening at ${target.plaidBaseUrl} — point your app's Plaid base URL here.`);
  }
  const summaries: ScenarioSummary[] = [];
  try {
    for (const scenario of scenarios) {
      if (!v.json) process.stderr.write(`  running ${scenario.id}…\r`);
      summaries.push(await exploreScenario(target, scenario, seeds));
      if (!v.json) process.stderr.write(' '.repeat(60) + '\r');
    }
  } finally {
    await target.dispose();
  }

  const fixtures: Record<string, string> = {};
  const outDir = v.out ?? join('chaos-reports', timestamp());
  const writeReport = !v['no-report'];
  if (writeReport) {
    for (const s of summaries) {
      if (!s.failedSeeds.length) continue;
      const path = join(outDir, 'fixtures', `${s.scenario.id}.seed${s.representative.seed}.json`);
      await writeFixture(path, s.representative);
      fixtures[s.scenario.id] = relative(process.cwd(), path).replace(/\\/g, '/');
    }
  }

  const ctx = {
    target: label,
    seeds,
    summaries,
    fixtures,
    outDir: writeReport ? outDir.replace(/\\/g, '/') : undefined,
    replayHint: args,
  };
  const json = {
    tool: 'plaid-chaos-lab',
    target: label,
    seeds,
    passed: summaries.every((s) => !s.failedSeeds.length),
    scenarios: summaries.map((s) => ({
      id: s.scenario.id,
      title: s.scenario.title,
      passed: !s.failedSeeds.length,
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
  if (v.json) console.log(JSON.stringify(json, null, 2));
  else console.log(renderConsole(ctx));
  return json.passed ? 0 : 1;
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
      const meta = SCENARIOS.find((s) => s.id === fixture.scenario) ?? getScenario(fixture.scenario);
      summaries.push({ scenario: meta, seeds: [fixture.seed], failedSeeds: run.passed ? [] : [fixture.seed], representative: run, warnings: 0 });
      const was = fixture.observed.passed ? 'passed' : 'failed';
      notes.push(
        `${file}: recorded ${was}, replay ${run.passed ? 'passes' : 'fails'}` +
          (!fixture.observed.passed && run.passed ? ' (fixed!)' : ''),
      );
    }
  } finally {
    await target.dispose();
  }
  if (v.json) console.log(JSON.stringify(summaries.map((s) => s.representative), null, 2));
  else {
    console.log(renderConsole({ target: label, seeds: [0], summaries, fixtures: {}, replayHint: args }));
    for (const n of notes) console.log(n);
  }
  return summaries.every((s) => !s.failedSeeds.length) ? 0 : 1;
}

function cmdList(): number {
  console.log('Scenarios:\n');
  for (const s of SCENARIOS) {
    console.log(`  ${s.id.padEnd(30)} ${s.title}`);
    console.log(`  ${''.padEnd(30)} checks: ${s.finalChecks.join(', ')}\n`);
  }
  console.log('Invariants:\n');
  for (const i of Object.values(INVARIANTS)) console.log(`  ${i.id.padEnd(36)} [${i.severity}] ${i.description}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    console.error(String((e as Error).message) + '\n\n' + HELP);
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
    if (command === 'replay') return await cmdReplay(values, rest);
    throw new UsageError(`Unknown command "${command}"`);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${HELP}`);
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

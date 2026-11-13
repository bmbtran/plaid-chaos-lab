import type { ScenarioSummary } from '../engine/runner.ts';
import { diffState, formatEvent } from './format.ts';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);
const cyan = c(36);

export interface ReportContext {
  target: string;
  seeds: number[];
  summaries: ScenarioSummary[];
  fixtures: Record<string, string>;
  outDir?: string;
  replayHint?: string;
}

export function renderConsole(ctx: ReportContext): string {
  const out: string[] = [];
  const failed = ctx.summaries.filter((s) => s.failedSeeds.length > 0);
  out.push('');
  out.push(
    `${bold('Plaid Integration Chaos Lab')}  ${dim('·')}  ${ctx.target}  ${dim('·')}  ${ctx.summaries.length} scenario(s) × ${ctx.seeds.length} seed(s)`,
  );
  out.push('');

  for (const s of ctx.summaries) {
    const id = s.scenario.id.padEnd(30);
    const warn = s.warnings ? yellow(`  ${s.warnings} warning(s)`) : '';
    if (s.failedSeeds.length === 0) {
      out.push(`${green('✓')} ${id} ${green('PASS')}  ${dim(`${s.seeds.length}/${s.seeds.length} seeds`)}${warn}`);
      continue;
    }
    const r = s.representative;
    out.push(
      `${red('✗')} ${id} ${red('FAIL')}  ${dim(`failed ${s.failedSeeds.length}/${s.seeds.length} seeds · counterexample seed ${r.seed}, page size ${r.pageSize}`)}${warn}`,
    );
    out.push(`    ${dim(s.scenario.title + ': ' + s.scenario.whyItMatters)}`);
    for (const inv of r.invariants.filter((i) => !i.passed)) {
      const mark = inv.severity === 'error' ? red('✗') : yellow('!');
      out.push(`    ${mark} ${bold(inv.id)} ${dim(`@ ${inv.at}`)}`);
      out.push(`      ${inv.message}`);
    }
    if (r.impact.length) {
      out.push(`    ${bold('What the user sees:')}`);
      for (const line of r.impact.slice(0, 5)) out.push(`      • ${line}`);
    }
    out.push(`    ${bold('Counterexample:')}`);
    r.timeline.forEach((e, i) => out.push(`      ${dim(String(i + 1).padStart(2) + '.')} ${formatEvent(e)}`));
    const final = r.states.filter((st) => st.label === 'final').at(-1);
    if (final) {
      const rows = diffState(final, r);
      const bad = rows.filter((row) => row.status !== 'ok');
      if (bad.length) {
        out.push(`    ${bold('Final state (app vs bank):')} ${dim(`${rows.length - bad.length} rows ok`)}`);
        for (const row of bad.slice(0, 8)) {
          out.push(`      ${red(row.status.padEnd(12))} ${row.id} ${row.merchant.padEnd(20)} app ${row.app.padEnd(22)} bank ${row.bank}`);
        }
      }
    }
    const fixture = ctx.fixtures[s.scenario.id];
    if (fixture) out.push(`    ${bold('Replay fixture:')} ${cyan(fixture)}`);
    out.push('');
  }

  out.push('');
  const total = ctx.summaries.length;
  out.push(
    failed.length === 0
      ? green(bold(`All ${total} scenarios passed across ${ctx.seeds.length} seed(s).`))
      : red(bold(`${failed.length}/${total} scenarios failed.`)) +
          (ctx.outDir ? `  Full report: ${cyan(ctx.outDir + '/report.md')}` : ''),
  );
  if (failed.length && ctx.replayHint) out.push(dim(`Replay a counterexample: npx chaos-lab replay <fixture> ${ctx.replayHint}`));
  out.push('');
  return out.join('\n');
}

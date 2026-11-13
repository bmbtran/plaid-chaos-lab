import type { ScenarioSummary } from '../engine/runner.ts';
import { diffState, formatEvent, TAG_WIDTH } from './format.ts';

const useColor = (process.stdout.isTTY || !!process.env.FORCE_COLOR) && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const dim = paint('2');
const bold = paint('1');

export interface ReportContext {
  target: string;
  /** What the scenarios ran on, e.g. "synthetic data" or "real Plaid Sandbox + recorded Sandbox data". */
  data?: string;
  seeds: number[];
  summaries: ScenarioSummary[];
  fixtures: Record<string, string>;
  outDir?: string;
  replayHint?: string;
}

const INDENT = '      ';
const ID_WIDTH = 32;

function seedsText(s: ScenarioSummary): string {
  const n = s.seeds.length;
  const word = n === 1 ? 'seed' : 'seeds';
  return s.failedSeeds.length ? `failed ${s.failedSeeds.length} of ${n} ${word}` : `${n} ${word}`;
}

export function renderConsole(ctx: ReportContext): string {
  const out: string[] = [''];
  const failed = ctx.summaries.filter((s) => s.failedSeeds.length > 0);
  const sources = new Set(ctx.summaries.map((s) => s.representative.source));
  const showSource = sources.size > 1 || !sources.has('synthetic');

  out.push(`${bold('chaos-lab')}  ${ctx.target}${ctx.data ? dim(`  on ${ctx.data}`) : ''}`, '');

  for (const s of ctx.summaries) {
    const r = s.representative;
    const source = showSource ? dim(r.source.padEnd(10)) : '';
    const warn = s.warnings ? yellow(`  ${s.warnings} with warnings`) : '';
    if (s.inconclusive) {
      out.push(`${yellow('skip')}  ${source}${s.scenario.id.padEnd(ID_WIDTH)}${dim(`inconclusive: ${s.inconclusive}`)}`);
      continue;
    }
    if (!s.failedSeeds.length) {
      out.push(`${green('pass')}  ${source}${s.scenario.id.padEnd(ID_WIDTH)}${dim(seedsText(s))}${warn}`);
      continue;
    }
    out.push(`${red(bold('FAIL'))}  ${source}${bold(s.scenario.id.padEnd(ID_WIDTH))}${dim(`${seedsText(s)}; showing seed ${r.seed}`)}${warn}`);
    out.push('');

    for (const inv of r.invariants.filter((i) => !i.passed)) {
      const mark = inv.severity === 'error' ? red(inv.id) : yellow(`${inv.id} (warning)`);
      out.push(`${INDENT}${mark} ${dim(`at ${inv.at}`)}`);
      out.push(`${INDENT}  ${inv.message}`);
    }

    if (r.impact.length) {
      out.push('', `${INDENT}${bold('What the user sees')}`);
      for (const line of r.impact.slice(0, 5)) out.push(`${INDENT}  ${line}`);
    }

    out.push('', `${INDENT}${bold('Events')}`);
    const width = String(r.timeline.length).length;
    r.timeline.forEach((e, i) => {
      const f = formatEvent(e);
      const tag = f.tag.padEnd(TAG_WIDTH);
      out.push(`${INDENT}  ${dim(String(i + 1).padStart(width))}  ${f.emphasis ? yellow(tag) : dim(tag)} ${f.text}`);
    });

    const final = r.states.filter((st) => st.label === 'final').at(-1);
    if (final) {
      const rows = diffState(final, r);
      const bad = rows.filter((row) => row.status !== 'ok');
      if (bad.length) {
        out.push('', `${INDENT}${bold('Final state')} ${dim(`(${rows.length - bad.length} of ${rows.length} rows match the bank)`)}`);
        for (const row of bad.slice(0, 8)) {
          out.push(
            `${INDENT}  ${red(row.status.padEnd(14))}${row.id}  ${row.merchant.slice(0, 22).padEnd(23)}app ${row.app.padEnd(20)} bank ${row.bank}`,
          );
        }
        if (bad.length > 8) out.push(`${INDENT}  ${dim(`${bad.length - 8} more`)}`);
      }
    }

    const fixture = ctx.fixtures[s.scenario.id];
    if (fixture) out.push('', `${INDENT}${dim('fixture')}  ${fixture}`);
    out.push('');
  }

  out.push('');
  const total = ctx.summaries.length;
  const skipped = ctx.summaries.filter((s) => s.inconclusive).length;
  if (!failed.length && !skipped) {
    out.push(green(`All ${total} scenarios passed.`));
  } else if (!failed.length) {
    out.push(yellow(`${total - skipped} of ${total} scenarios passed; ${skipped} inconclusive (Plaid Sandbox did not cooperate).`));
  } else {
    out.push(`${red(bold(`${failed.length} of ${total} scenarios failed.`))}${ctx.outDir ? `  Report: ${ctx.outDir}/report.md` : ''}`);
    if (ctx.replayHint && Object.keys(ctx.fixtures).length) out.push(dim(`Replay a failure: chaos-lab replay <fixture> ${ctx.replayHint}`));
  }
  out.push('');
  return out.join('\n');
}

import type { RunResult, StateCapture } from '../types.ts';
import { diffState, eventLine } from './format.ts';
import type { ReportContext } from './console.ts';

const esc = (s: string) => s.replace(/\|/g, '\\|');

function stateTable(capture: StateCapture, run: RunResult, onlyDifferences: boolean): string {
  const rows = diffState(capture, run);
  // Real Sandbox Items have hundreds of rows; list only the ones that differ.
  const shown = onlyDifferences || rows.length > 25 ? rows.filter((r) => r.status !== 'ok') : rows;
  const lines = [
    `Item status: app shows \`${capture.app.itemStatus ?? 'not reported'}\`, Plaid says \`${capture.truth.itemStatus}\`.`,
    `${rows.length - rows.filter((r) => r.status !== 'ok').length} of ${rows.length} transactions match the bank.`,
  ];
  const MAX_ROWS = 15;
  if (shown.length) {
    lines.push(
      '',
      '| | Transaction | Merchant | App | Bank |',
      '|---|---|---|---|---|',
      ...shown.slice(0, MAX_ROWS).map((r) => `| ${r.status} | \`${r.id}\` | ${esc(r.merchant)} | ${esc(r.app)} | ${esc(r.bank)} |`),
    );
    if (shown.length > MAX_ROWS) lines.push('', `${shown.length - MAX_ROWS} more rows like these are not shown.`);
  }
  return lines.join('\n');
}

export function renderMarkdown(ctx: ReportContext & { generatedAt: string }): string {
  const out: string[] = [];
  const failed = ctx.summaries.filter((s) => s.failedSeeds.length);
  out.push('# Chaos Lab report', '');
  out.push(`Target: \`${ctx.target}\`  `);
  if (ctx.data) out.push(`Data: ${ctx.data}  `);
  out.push(`Generated: ${ctx.generatedAt}  `);
  out.push(`Result: ${failed.length ? `${failed.length} of ${ctx.summaries.length} scenarios failed` : `all ${ctx.summaries.length} scenarios passed`}`, '');

  out.push('| Scenario | Data | Result | Seeds failed | Invariants broken |', '|---|---|---|---|---|');
  for (const s of ctx.summaries) {
    const inv = [...new Set(s.representative.invariants.filter((i) => !i.passed && i.severity === 'error').map((i) => `\`${i.id}\``))];
    const result = s.inconclusive ? 'inconclusive' : s.failedSeeds.length ? '**fail**' : 'pass';
    out.push(
      `| [${s.scenario.id}](#${s.scenario.id}) | ${s.representative.source} | ${result} | ${s.inconclusive ? 'n/a' : `${s.failedSeeds.length} of ${s.seeds.length}`} | ${inv.join(', ')} |`,
    );
  }
  out.push('');

  for (const s of ctx.summaries) {
    const r = s.representative;
    out.push(`## ${s.scenario.id}`, '');
    const verdict = s.inconclusive ? `Inconclusive: ${s.inconclusive}.` : s.failedSeeds.length ? '**Failed.**' : 'Passed.';
    out.push(`${s.scenario.title}. ${verdict}`, '');
    if (s.scenario.summary) out.push(s.scenario.summary, '');
    if (s.scenario.whyItMatters) out.push(s.scenario.whyItMatters, '');
    if (s.scenario.docs.length) out.push(`Plaid docs: ${s.scenario.docs.map((d) => `<${d}>`).join(', ')}`, '');
    if (!s.failedSeeds.length) continue;

    out.push(`### What broke (seed ${r.seed}, page size ${r.pageSize}, ${r.source} data)`, '');
    for (const i of r.invariants.filter((x) => !x.passed)) {
      out.push(`- \`${i.id}\`${i.severity === 'warn' ? ' (warning)' : ''} at ${i.at}: ${i.message}`);
    }
    out.push('');
    if (r.impact.length) {
      out.push('### What the user sees', '');
      for (const line of r.impact) out.push(`- ${line}`);
      out.push('');
    }
    out.push('### Events', '', '```text');
    const width = String(r.timeline.length).length;
    r.timeline.forEach((e, idx) => out.push(`${String(idx + 1).padStart(width)}  ${eventLine(e)}`));
    out.push('```', '');

    const final = r.states.filter((x) => x.label === 'final').at(-1);
    const earlier = r.states.filter(
      (st) => st !== final && r.invariants.some((i) => i.at === st.label && !i.passed && i.severity === 'error'),
    );
    const before = r.states[0];
    if (before && before !== final && !earlier.includes(before)) out.push(`### Before: ${before.label}`, '', stateTable(before, r, true), '');
    for (const st of earlier) out.push(`### At ${st.label}`, '', stateTable(st, r, false), '');
    if (final) out.push('### After', '', stateTable(final, r, false), '');

    const fixture = ctx.fixtures[s.scenario.id];
    if (fixture) out.push('### Replay', '', '```bash', `chaos-lab replay ${fixture} ${ctx.replayHint ?? ''}`.trim(), '```', '');
  }
  return out.join('\n');
}

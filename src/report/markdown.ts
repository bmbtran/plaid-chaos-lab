import type { StateCapture } from '../types.ts';
import type { RunResult } from '../types.ts';
import { diffState, formatEvent } from './format.ts';
import type { ReportContext } from './console.ts';

const esc = (s: string) => s.replace(/\|/g, '\\|');

function stateTable(capture: StateCapture, run: RunResult): string {
  const rows = diffState(capture, run);
  const lines = [
    `App Item status: \`${capture.app.itemStatus ?? 'not reported'}\` · Plaid: \`${capture.truth.itemStatus}\``,
    '',
    '| Status | Transaction | Merchant | App shows | Bank says |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.status === 'ok' ? 'ok' : `**${r.status}**`} | \`${r.id}\` | ${esc(r.merchant)} | ${esc(r.app)} | ${esc(r.bank)} |`,
    ),
  ];
  return lines.join('\n');
}

export function renderMarkdown(ctx: ReportContext & { generatedAt: string }): string {
  const out: string[] = [];
  const failed = ctx.summaries.filter((s) => s.failedSeeds.length);
  out.push('# Plaid Integration Chaos Lab report', '');
  out.push(`- **Target:** ${ctx.target}`);
  out.push(`- **Generated:** ${ctx.generatedAt}`);
  out.push(`- **Seeds:** ${ctx.seeds[0]}–${ctx.seeds[ctx.seeds.length - 1]} (${ctx.seeds.length} per scenario)`);
  out.push(`- **Result:** ${failed.length === 0 ? 'all scenarios passed' : `${failed.length}/${ctx.summaries.length} scenarios failed`}`, '');

  out.push('| Scenario | Result | Failing seeds | Failed invariants |', '|---|---|---|---|');
  for (const s of ctx.summaries) {
    const inv = [...new Set(s.representative.invariants.filter((i) => !i.passed && i.severity === 'error').map((i) => `\`${i.id}\``))];
    out.push(
      `| [${s.scenario.id}](#${s.scenario.id}) | ${s.failedSeeds.length ? '❌ FAIL' : '✅ PASS'} | ${s.failedSeeds.length}/${s.seeds.length} | ${inv.join(', ') || '—'} |`,
    );
  }
  out.push('');

  for (const s of ctx.summaries) {
    const r = s.representative;
    out.push(`## ${s.scenario.id}`, '');
    out.push(`**${s.scenario.title}** — ${s.failedSeeds.length ? '❌ FAIL' : '✅ PASS'}`, '');
    out.push(s.scenario.summary, '');
    out.push(`*Why it matters:* ${s.scenario.whyItMatters}`, '');
    out.push(`Plaid docs: ${s.scenario.docs.map((d) => `<${d}>`).join(' · ')}`, '');
    if (!s.failedSeeds.length) continue;

    out.push(`### Failed invariants (seed ${r.seed}, page size ${r.pageSize})`, '');
    for (const i of r.invariants.filter((x) => !x.passed)) {
      out.push(`- ${i.severity === 'error' ? '❌' : '⚠️'} \`${i.id}\` @ *${i.at}*: ${i.message}`);
    }
    out.push('');
    if (r.impact.length) {
      out.push('### What the user would see', '');
      for (const line of r.impact) out.push(`- ${line}`);
      out.push('');
    }
    out.push('### Counterexample', '', '```text');
    r.timeline.forEach((e, idx) => out.push(`${String(idx + 1).padStart(2)}. ${formatEvent(e)}`));
    out.push('```', '');

    const first = r.states[0];
    const final = r.states.filter((x) => x.label === 'final').at(-1);
    const failing = r.states.filter(
      (st) => st !== final && r.invariants.some((i) => i.at === st.label && !i.passed && i.severity === 'error'),
    );
    if (first && first !== final && !failing.includes(first)) {
      out.push(`### Before — ${first.label}`, '', stateTable(first, r), '');
    }
    for (const st of failing) out.push(`### At checkpoint — ${st.label}`, '', stateTable(st, r), '');
    if (final) out.push('### After — final', '', stateTable(final, r), '');

    const fixture = ctx.fixtures[s.scenario.id];
    if (fixture) {
      out.push('### Replay', '', '```bash', `npx chaos-lab replay ${fixture} ${ctx.replayHint ?? ''}`.trim(), '```', '');
    }
  }
  return out.join('\n');
}

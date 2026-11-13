import type { RunResult, StateCapture } from '../types.ts';
import { diffState, eventLine } from './format.ts';
import type { ReportContext } from './console.ts';

const esc = (s: string) => s.replace(/\|/g, '\\|');
const MAX_ROWS = 8;
const MAX_IMPACT = 4;

/** Only the rows where the app and the bank disagree. */
function mismatches(capture: StateCapture, run: RunResult): string[] {
  const rows = diffState(capture, run).filter((r) => r.status !== 'ok');
  const status =
    capture.app.itemStatus !== undefined && capture.app.itemStatus !== capture.truth.itemStatus
      ? [`Item status: app shows \`${capture.app.itemStatus}\`, Plaid says \`${capture.truth.itemStatus}\`.`]
      : [];
  if (!rows.length) return status;
  return [
    ...status,
    ...(status.length ? [''] : []),
    '| | Transaction | Merchant | App | Bank |',
    '|---|---|---|---|---|',
    ...rows.slice(0, MAX_ROWS).map((r) => `| ${r.status} | \`${r.id}\` | ${esc(r.merchant)} | ${esc(r.app)} | ${esc(r.bank)} |`),
    ...(rows.length > MAX_ROWS ? ['', `${rows.length - MAX_ROWS} more.`] : []),
  ];
}

export function renderMarkdown(ctx: ReportContext & { generatedAt: string }): string {
  const failed = ctx.summaries.filter((s) => s.failedSeeds.length);
  const out: string[] = [
    '# Chaos Lab report',
    '',
    `\`${ctx.target}\`${ctx.data ? ` on ${ctx.data}` : ''}. ${failed.length ? `${failed.length} of ${ctx.summaries.length} scenarios failed.` : `All ${ctx.summaries.length} scenarios passed.`}`,
    '',
    '| Scenario | Data | Result |',
    '|---|---|---|',
  ];
  for (const s of ctx.summaries) {
    const result = s.inconclusive ? 'inconclusive' : s.failedSeeds.length ? `**fail** (${s.failedSeeds.length}/${s.seeds.length} seeds)` : 'pass';
    const name = s.failedSeeds.length ? `[${s.scenario.id}](#${s.scenario.id})` : s.scenario.id;
    out.push(`| ${name} | ${s.representative.source} | ${result} |`);
  }

  for (const s of failed) {
    const r = s.representative;
    const docs = s.scenario.docs[0] ? ` ([Plaid docs](${s.scenario.docs[0]}))` : '';
    out.push('', `## ${s.scenario.id}`, '', `${s.scenario.whyItMatters}${docs}`, '');

    for (const i of r.invariants.filter((x) => !x.passed)) {
      const msg = i.message.length > 220 ? `${i.message.slice(0, 219)}…` : i.message;
      out.push(`- \`${i.id}\` (${i.at}${i.severity === 'warn' ? ', warning' : ''}): ${msg}`);
    }

    if (r.impact.length) {
      out.push('', '**User sees:**', '');
      for (const line of r.impact.slice(0, MAX_IMPACT)) out.push(`- ${line}`);
    }

    const width = String(r.timeline.length).length;
    out.push('', '```text', ...r.timeline.map((e, idx) => `${String(idx + 1).padStart(width)}  ${eventLine(e)}`), '```');

    // Mismatched rows at the first failing check (often the most telling) and at the end.
    const failing = r.states.filter((st) => r.invariants.some((i) => i.at === st.label && !i.passed && i.severity === 'error'));
    for (const st of failing.slice(0, 2)) {
      const rows = mismatches(st, r);
      if (rows.length) out.push('', `App vs bank (${st.label}):`, '', ...rows);
    }

    const fixture = ctx.fixtures[s.scenario.id];
    if (fixture) out.push('', `Replay: \`chaos-lab replay ${fixture} ${ctx.replayHint ?? ''}\``.replace(/ `$/, '`'));
  }
  out.push('');
  return out.join('\n');
}

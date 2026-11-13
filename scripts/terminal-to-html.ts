// Turn captured terminal output (with ANSI colors) into a terminal-styled HTML page for screenshots.
// Usage: tsx scripts/terminal-to-html.ts <input.ansi> <output.html> [first-line-regex] [last-line-regex]
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, from, to] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: terminal-to-html <input.ansi> <output.html> [from-regex] [to-regex]');
  process.exit(2);
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
let lines = readFileSync(input, 'utf8')
  .replace(/\x1b\[2K|\r/g, '')
  .split('\n');

// Keep the header line, then the slice between the two markers.
if (from) {
  const start = lines.findIndex((l) => new RegExp(from).test(strip(l)));
  const end = to ? lines.findIndex((l, i) => i > start && new RegExp(to).test(strip(l))) : lines.length - 1;
  lines = [...lines.slice(0, 2), ...lines.slice(start, end + 1)];
}

const COLORS: Record<string, string> = { '31': 'red', '32': 'green', '33': 'yellow', '36': 'cyan' };
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toHtml(line: string): string {
  let html = '';
  let open = 0;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) {
      html += escape(part);
      continue;
    }
    for (const code of m[1].split(';')) {
      if (code === '0' || code === '') {
        html += '</span>'.repeat(open);
        open = 0;
      } else {
        const cls = code === '1' ? 'b' : code === '2' ? 'dim' : COLORS[code];
        if (cls) {
          html += `<span class="${cls}">`;
          open += 1;
        }
      }
    }
  }
  return html + '</span>'.repeat(open);
}

const body = lines.map(toHtml).join('\n').replace(/\n{3,}/g, '\n\n');
writeFileSync(
  output,
  `<!doctype html>
<html><head><meta charset="utf-8"><title>chaos-lab output</title>
<style>
  body { margin: 0; background: #0d1117; }
  .term { display: inline-block; margin: 24px; border-radius: 10px; background: #161b22; box-shadow: 0 8px 30px rgba(0,0,0,.5); overflow: hidden; }
  .bar { height: 32px; background: #21262d; display: flex; align-items: center; gap: 8px; padding: 0 14px; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; display: block; }
  .bar span { color: #8b949e; font: 12px ui-monospace, Consolas, monospace; margin-left: 10px; }
  pre { margin: 0; padding: 18px 22px 22px; width: 1080px; white-space: pre-wrap; word-break: break-all;
        color: #e6edf3; font: 13.5px/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace; }
  .b { font-weight: 700; } .dim { color: #8b949e; }
  .red { color: #ff7b72; } .green { color: #7ee787; } .yellow { color: #e3b341; } .cyan { color: #79c0ff; }
</style></head>
<body><div class="term" id="shot"><div class="bar"><i style="background:#ff5f56"></i><i style="background:#ffbd2e"></i><i style="background:#27c93f"></i><span>chaos-lab run --adapter examples/naive-adapter.ts --sandbox</span></div><pre>${body}</pre></div></body></html>
`,
);
console.log(`wrote ${output} (${lines.length} lines)`);

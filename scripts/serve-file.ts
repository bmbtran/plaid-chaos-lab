// Serve a single local HTML file on 127.0.0.1 (for taking screenshots with a browser tool).
// Usage: tsx scripts/serve-file.ts <file.html> [port]
import http from 'node:http';
import { readFileSync } from 'node:fs';

const [file, port = '8765'] = process.argv.slice(2);
if (!file) {
  console.error('usage: serve-file <file.html> [port]');
  process.exit(2);
}
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file));
  })
  .listen(Number(port), '127.0.0.1', () => console.log(`serving ${file} on http://127.0.0.1:${port}/`));

// Fails if the Plaid client id or secret appears in any file under the given paths. Prints no values.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadSandboxCredentials } from '../src/sandbox/api.ts';
const { clientId, secret } = loadSandboxCredentials();
const files: string[] = [];
const walk = (p: string) => { const s = statSync(p); if (s.isDirectory()) { for (const f of readdirSync(p)) walk(join(p, f)); } else files.push(p); };
for (const p of process.argv.slice(2)) walk(p);
let leaks = 0;
for (const f of files) { const c = readFileSync(f, 'utf8'); if (c.includes(secret) || c.includes(clientId)) { leaks++; console.log('LEAK in', f); } }
console.log(`checked ${files.length} files: ${leaks ? `${leaks} contain credentials` : 'no credentials found'}`);
process.exit(leaks ? 1 : 0);

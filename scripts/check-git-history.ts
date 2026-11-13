// Before publishing: confirm no commit contains the Plaid credentials or a tracked env file.
// Prints counts only, never values.
import { execFileSync } from 'node:child_process';
import { loadSandboxCredentials } from '../src/sandbox/api.ts';

const git = (...args: string[]) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return ''; // git grep: no matches
    throw e;
  }
};

const { clientId, secret } = loadSandboxCredentials();
const revs = git('rev-list', '--all').split('\n').filter(Boolean);
let hits = 0;
for (const value of [clientId, secret]) {
  hits += git('grep', '-l', '-F', value, ...revs).split('\n').filter(Boolean).length;
}
const envName = ['.', 'env'].join('');
const envFiles = revs.flatMap((r) => git('ls-tree', '-r', '--name-only', r).split('\n')).filter((p) => p === envName || p.endsWith(`/${envName}`));

console.log(`commits checked: ${revs.length}`);
console.log(`files containing credentials: ${hits}`);
console.log(`env files ever committed: ${envFiles.length}`);
process.exit(hits || envFiles.length ? 1 : 0);

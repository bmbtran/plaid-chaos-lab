import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = join(import.meta.dirname, '..', 'bin', 'chaos-lab.js');
const run = (...args: string[]) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 120_000 });

test('list prints scenarios and invariants', () => {
  const r = run('list');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /mutation-during-pagination/);
  assert.match(r.stdout, /sandbox-pending-to-posted/);
  assert.match(r.stdout, /no-pending-posted-double-count/);
});

test('run --data uses a recorded cassette', () => {
  const r = run('run', '--adapter', 'examples/robust-adapter.ts', '--data', 'examples/fixtures/sandbox-cassette.json', '--runs', '2', '--no-report');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /recorded data from examples\/fixtures\/sandbox-cassette.json/);
  assert.match(r.stdout, /All 8 scenarios passed/);
});

test('usage errors exit 2', () => {
  assert.equal(run('run').status, 2);
  assert.equal(run('bogus').status, 2);
  assert.equal(run('run', '--adapter', 'examples/robust-adapter.ts', '--runs', 'x').status, 2);
});

test('run against the naive adapter exits 1 and writes report.md, report.json and fixtures', async () => {
  const out = await mkdtemp(join(tmpdir(), 'chaos-cli-'));
  try {
    const r = run('run', '--adapter', 'examples/naive-adapter.ts', '--runs', '2', '--scenario', 'pending-to-posted,missed-webhook-catchup', '--out', out);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /FAIL\s+pending-to-posted/);
    assert.match(r.stdout, /pass\s+missed-webhook-catchup/);
    assert.match(r.stdout, /Events/);
    assert.match(r.stdout, /What the user sees/);
    assert.doesNotMatch(r.stdout, /[✓✗⚡❌✅]/u, 'no emoji status marks');
    const md = await readFile(join(out, 'report.md'), 'utf8');
    assert.match(md, /### Events/);
    assert.match(md, /double count/);
    const json = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    assert.equal(json.passed, false);
    const fixtures = await readdir(join(out, 'fixtures'));
    assert.deepEqual(fixtures, ['pending-to-posted.seed1.json']);

    const fixture = join(out, 'fixtures', fixtures[0]);
    const stillBroken = run('replay', fixture, '--adapter', 'examples/naive-adapter.ts');
    assert.equal(stillBroken.status, 1);
    const fixed = run('replay', fixture, '--adapter', 'examples/robust-adapter.ts');
    assert.equal(fixed.status, 0);
    assert.match(fixed.stdout, /failed when recorded, passes now/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('run against the robust adapter exits 0', () => {
  const r = run('run', '--adapter', 'examples/robust-adapter.ts', '--runs', '2', '--no-report');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /All 8 scenarios passed/);
});

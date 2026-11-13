// How to keep a Chaos Lab counterexample as a regression test in your own CI.
//
// 1. `chaos-lab run` finds a failure and writes chaos-reports/<ts>/fixtures/<scenario>.seedN.json
// 2. You fix the bug and commit that fixture next to your tests
// 3. This test replays the exact event sequence on every build
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayFixtureFile } from '../src/index.ts';
import robust from './robust-adapter.ts';

const fixtures = ['examples/fixtures/pending-to-posted.seed1.json', 'examples/fixtures/mutation-during-pagination.seed1.json'];

for (const path of fixtures) {
  test(`regression: ${path}`, async () => {
    const result = await replayFixtureFile(path, robust);
    const failures = result.invariants.filter((i) => !i.passed && i.severity === 'error');
    assert.equal(failures.length, 0, failures.map((f) => `${f.id}: ${f.message}`).join('\n'));
  });
}

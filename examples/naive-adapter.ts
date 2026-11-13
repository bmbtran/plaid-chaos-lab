// The reference app with common mistakes switched on.
//
//   npx tsx src/cli.ts run --adapter examples/naive-adapter.ts
//   CHAOS_BUGS=ignoreRemoved npx tsx src/cli.ts run --adapter examples/naive-adapter.ts
//   CHAOS_BUGS=all ...
//
// By default it is a "typical first integration": it copies the quickstart's
// has_more loop correctly but gets the lifecycle edge cases wrong.
import type { AdapterFactory } from '../src/types.ts';
import { ALL_BUGS, type Bugs, createReferenceApp, NO_BUGS } from './reference-app.ts';

export const TYPICAL_BUGS: Bugs = { ...ALL_BUGS, ignoreHasMore: false };

export function bugsFromEnv(value = process.env.CHAOS_BUGS): Bugs {
  if (!value) return TYPICAL_BUGS;
  if (value === 'all') return ALL_BUGS;
  if (value === 'none') return NO_BUGS;
  const bugs = { ...NO_BUGS };
  for (const name of value.split(',').map((s) => s.trim())) {
    if (!(name in NO_BUGS)) throw new Error(`Unknown bug "${name}". Known: ${Object.keys(NO_BUGS).join(', ')}`);
    bugs[name as keyof Bugs] = true;
  }
  return bugs;
}

const factory: AdapterFactory = ({ plaid }) => createReferenceApp(plaid, bugsFromEnv());
export default factory;

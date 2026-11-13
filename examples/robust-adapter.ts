// The reference app with no bugs: passes every scenario.
// Run: npx tsx src/cli.ts run --adapter examples/robust-adapter.ts
import type { AdapterFactory } from '../src/types.ts';
import { createReferenceApp } from './reference-app.ts';

const factory: AdapterFactory = ({ plaid }) => createReferenceApp(plaid);
export default factory;

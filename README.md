# Plaid Integration Chaos Lab

**A contract tester for the hard parts of a Plaid integration.** Point it at your webhook handler and it runs adversarial, reproducible Transactions and Item lifecycle scenarios: pending→posted replacement, duplicate and out-of-order webhooks, mutation mid-pagination, `ITEM_LOGIN_REQUIRED` → `LOGIN_REPAIRED`, missed webhooks. It then tells you whether your app's state is still correct.

> Unofficial. Not affiliated with or endorsed by Plaid Inc. Uses only synthetic data.

Plaid Sandbox lets you *fire* webhooks. It doesn't tell you whether your database is right afterwards. This tool does. For every failure you get:

- the **invariant** that broke (e.g. `no-pending-posted-double-count`)
- **what the user would see** ("Spending is overstated by $159.30")
- the exact **counterexample**: every webhook, bank change and `/transactions/sync` call with its decoded cursor
- an app-vs-bank **state diff**
- a **replay fixture** you can commit and run in CI

## 60-second demo

```bash
npm install
npm run demo:naive     # a "typical first integration": 7 of 8 scenarios fail
npm run demo:robust    # the corrected reference app: 8/8 pass across 25 seeds
```

```text
✗ pending-to-posted              FAIL  failed 5/5 seeds · counterexample seed 1, page size 2
    ✗ no-pending-posted-double-count @ final
      pending txn_2d1ffd57ed "Whole Foods Market" $159.30 (pending) is still stored alongside its
      posted replacement txn_c2a8790c95 "Whole Foods Market" $159.30
    What the user sees:
      • Spending is overstated by $159.30: the app shows $442.81, the bank says $283.51.
      • "Whole Foods Market" is listed twice: once as pending ($159.30) and once as posted ($159.30).
    Counterexample:
       7. bank v2: post txn_2d1ffd57ed → txn_c2a8790c95 "Whole Foods Market" $159.30 (pending removed + posted added)
       8. → webhook SYNC_UPDATES_AVAILABLE delivered
       9. app → /transactions/sync cursor=v1 ⇒ page 1/2: +2 ~0 -0 has_more
      10. app → /transactions/sync cursor=page 2 of loop from v1 ⇒ page 2/2: +0 ~0 -1
    Final state (app vs bank): 4 rows ok
      DOUBLE-COUNT txn_2d1ffd57ed Whole Foods Market   app $159.30 (pending)      bank gone
    Replay fixture: chaos-reports/…/fixtures/pending-to-posted.seed1.json

✗ mutation-during-pagination     FAIL
      13. ⚡ bank mutated mid-pagination (v3): remove txn_2d1ffd57ed "Whole Foods Market" …
      14. app → /transactions/sync cursor=page 4 of loop from v1 ⇒ error TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION
      15. app → /transactions/sync cursor=page 4 of loop from v1 ⇒ error TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION
    ✗ sync-restarts-from-original-cursor: after the mutation error at #14, the next call (#15)
      used cursor=page 4 of loop from v1 instead of restarting with cursor=v1
```

A full Markdown report (`report.md`) and machine-readable `report.json` are written next to the fixtures.

## Scenarios

| Scenario | What the lab does | Typical bug it catches |
|---|---|---|
| `pending-to-posted` | A pending txn posts: removed + new posted txn with `pending_transaction_id`, amount may change (tip). A small page cap puts the removal on a later page. | Ignoring `removed` → double count |
| `duplicate-webhook-delivery` | The same `SYNC_UPDATES_AVAILABLE` arrives twice concurrently, then as a late retry | Concurrent handlers + appends → duplicates |
| `out-of-order-item-events` | `LOGIN_REPAIRED` arrives before the stale `ERROR` | Item health taken from arrival order instead of `/item/get` |
| `paginated-sync` | Multi-page history; later modifications, a reversal and new txns span pages | Reading one page |
| `mutation-during-pagination` | Bank changes after page *k*; the next page returns `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` | Retrying the failed page or keeping partial pages |
| `login-required-then-repaired` | Sync fails with `ITEM_LOGIN_REQUIRED` (with a stale sync webhook during the outage), then `LOGIN_REPAIRED` + new data | Wiping data on errors; never clearing the reconnect banner |
| `missed-webhook-reconcile` | A webhook is dropped and nothing else arrives | No periodic reconciliation job |
| `missed-webhook-catchup` | A webhook is dropped, a later one arrives | Control case: syncing from a stored cursor recovers automatically |

The seed controls transaction data, the page-size cap (1–4), which page the mutation fires after, and async interleaving. Run many seeds with `--runs N`.

## Invariants

| Invariant | Severity |
|---|---|
| `no-duplicate-transactions` — each `transaction_id` stored once | error |
| `no-pending-posted-double-count` — never hold a pending txn and its posted replacement | error |
| `no-phantom-transactions` — nothing the bank no longer has | error |
| `no-missing-transactions` — everything the bank has | error |
| `transaction-fields-current` — amounts / pending / date are the latest version | error |
| `item-status-matches` — the app's reconnect prompt matches `/item/get` | error |
| `sync-restarts-from-original-cursor` — after a mutation error, restart from the loop's first cursor | error |
| `webhook-handlers-succeed` — handlers don't throw / return non-2xx | warn |

Checkpoints check invariants *during* a scenario too. For example, `login-required-then-repaired` verifies that data survives the outage, not just that it comes back afterwards.

## Testing your app

### Option A — in-process adapter (TypeScript / JavaScript)

Write a module whose default export builds your integration around the Plaid client the lab hands you. That client has the `PlaidApi` call shape from `plaid/legacy` (`transactionsSync`, `itemGet`, axios-style errors).

```ts
// my-adapter.ts
import type { AdapterFactory } from 'plaid-chaos-lab';
import { createMyIntegration } from './src/plaid-integration';

const factory: AdapterFactory = ({ plaid }) => {
  const app = createMyIntegration({ plaid, db: inMemoryDb() });
  return {
    registerItem: ({ itemId, accessToken }) => app.saveItem(itemId, accessToken),
    handleWebhook: (body) => app.onPlaidWebhook(body),
    getState: async (itemId) => ({
      transactions: await app.listTransactions(itemId),   // [{ transaction_id, amount, pending?, date? }]
      itemStatus: await app.needsReconnect(itemId) ? 'login_required' : 'healthy',
    }),
    reconcile: (itemId) => app.scheduledSync(itemId),     // optional
  };
};
export default factory;
```

```bash
npx chaos-lab run --adapter my-adapter.ts --runs 20
```

### Option B — HTTP mode (any language)

The lab runs a fake Plaid API (default port 4010) that the official SDKs can talk to. Set your Plaid client's base URL to it, and expose these endpoints:

| Endpoint | Purpose |
|---|---|
| `POST <webhook-url>` | Receives Plaid webhooks (respond fast; the lab waits for your async work to settle) |
| `POST <control>/reset` | Clear all state before a run |
| `POST <control>/items` `{item_id, access_token}` | Store an Item as if `/item/public_token/exchange` had just happened |
| `GET <control>/state?item_id=` | `{ transactions: [...], itemStatus }` as your UI would show it |
| `POST <control>/reconcile` `{item_id}` | Optional: run your scheduled sync (404/501 = not implemented) |

```bash
PLAID_BASE_URL=http://127.0.0.1:4010 npx tsx examples/http-app.ts      # example app (official SDK)
npx chaos-lab run --webhook-url http://127.0.0.1:3005/webhooks/plaid \
                  --control-url http://127.0.0.1:3005/chaos --plaid-port 4010
```

`examples/http-app.ts` is verified against **both** official SDK styles: the v51 `PlaidClient` and the classic `PlaidApi` from `plaid/legacy`.

### Keep counterexamples as CI regression tests

```bash
npx chaos-lab replay chaos-reports/<run>/fixtures/pending-to-posted.seed1.json --adapter my-adapter.ts
# → "recorded failed, replay passes (fixed!)"
```

```ts
import { replayFixtureFile } from 'plaid-chaos-lab';
test('pending→posted regression', async () => {
  const r = await replayFixtureFile('fixtures/pending-to-posted.seed1.json', myAdapterFactory);
  assert.ok(r.passed);
});
```

See [examples/ci-fixture.test.ts](examples/ci-fixture.test.ts).

## CLI

```
chaos-lab list
chaos-lab run    (--adapter <module> | --webhook-url <url> --control-url <url> [--plaid-port 4010])
                 [--scenario a,b] [--seed 1] [--runs 10] [--out dir] [--no-report] [--json]
chaos-lab replay <fixture.json...> <target>
```

Exit code `0` all passed · `1` an invariant failed · `2` usage error.

## How it works

- **Ground truth** ([src/fake-plaid/bank.ts](src/fake-plaid/bank.ts)) keeps a versioned ledger per Item. A version cursor syncs as the exact diff between two versions (added / modified / removed, ordered by last change). Each sync loop pages over a frozen snapshot. If the bank changes while a loop is open, its page cursors return `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, but the loop's original cursor still works, as Plaid documents.
- **Scenarios** are seeded generators that produce a fully materialized, JSON-serializable script. Replaying a fixture runs the exact recorded steps.
- **Determinism**: the in-process fake client yields a seeded number of event-loop turns per call, so concurrent webhook handlers really interleave, and they do so the same way every time. The same seed gives byte-identical results (tested).
- **Validation**: a reference app with 8 toggleable bugs ([examples/reference-app.ts](examples/reference-app.ts)) proves each scenario catches the bug it targets. Each bug alone is caught on every seed tested, and the corrected app has zero false positives over 200 runs.

### Fidelity notes

- Only `/transactions/sync` and `/item/get` are simulated. Transaction objects include the core fields.
- The page-size cap is a chaos knob. Real Plaid paginates at your `count`, but your code must not assume a single page either way.
- Webhook JWT verification isn't simulated. Turn verification off for test runs, or stub it in your adapter.

## Development

```bash
npm run typecheck
npm test            # 33 tests: fake Plaid, invariants, detection matrix, determinism, replay, HTTP with both SDKs, CLI
```

The spec and definitions of done are in [PLAN.md](PLAN.md).

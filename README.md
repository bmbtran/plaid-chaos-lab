# Plaid Integration Chaos Lab

A test harness for the parts of a Plaid integration that usually break in production: pending transactions that post, webhooks that arrive twice or out of order, data that changes mid-pagination, Items that need re-authentication, and webhooks that never arrive.

You connect your webhook handler. The lab plays out each situation, then compares what your app stores with what Plaid says is true. When the two disagree, it shows the sequence of events that caused it, what your user would see, and a fixture that reproduces it in CI.

Unofficial; not affiliated with Plaid Inc.

```
npm install
npm run demo:naive      # a typical first integration: 7 of 8 scenarios fail
npm run demo:robust     # the corrected version: all pass
npm run demo:sandbox    # real Plaid Sandbox (needs Sandbox keys in .env)
```

## What a failure looks like

```
FAIL  pending-to-posted               failed 3 of 3 seeds; showing seed 1

      no-pending-posted-double-count at final
        pending txn_2d1ffd57ed "Whole Foods Market" $159.30 (pending) is still stored
        alongside its posted replacement txn_c2a8790c95 "Whole Foods Market" $159.30

      What the user sees
        Spending is overstated by $159.30: the app shows $442.81, the bank says $283.51.
        "Whole Foods Market" is listed twice: once as pending ($159.30) and once as posted ($159.30).

      Events
         7  bank      v2: pending txn_2d1ffd57ed posts as txn_c2a8790c95 "Whole Foods Market" $159.30; …
         8  webhook   SYNC_UPDATES_AVAILABLE
         9  call      /transactions/sync cursor=v1: page 1/2: +2 ~0 -0 has_more
        10  call      /transactions/sync cursor=page 2 of loop from v1: page 2/2: +0 ~0 -1
        11  check     final

      Final state (4 of 5 rows match the bank)
        double count  txn_2d1ffd57ed  Whole Foods Market     app $159.30 pending      bank removed

      fixture  chaos-reports/2026-11-13-04-31-07/fixtures/pending-to-posted.seed1.json
```

The app read both pages, but it ignored the `removed` entry on page 2, so the pending charge stayed next to its posted replacement. Each run also writes `report.md` and `report.json`.

## Where the data comes from

| Mode | Command | What it uses |
|---|---|---|
| Synthetic | `run --adapter app.ts` | A fake Plaid with generated transactions. Fast, deterministic, offline. |
| Recorded | `run --adapter app.ts --data cassette.json` | The same fake Plaid, filled with transactions recorded from Plaid Sandbox (`chaos-lab record`). Real field shapes and merchants, still deterministic. |
| Sandbox | `run --adapter app.ts --sandbox` | Real Plaid Sandbox for everything Sandbox can reproduce. Recorded data for the rest. |

Here's what Plaid Sandbox can and can't reproduce, as tested against the live API:

| Situation | In Sandbox | How the lab gets it |
|---|---|---|
| Item with a few hundred transactions over 7 accounts (real pagination at `count=100`) | yes | `/sandbox/public_token/create` with `user_transactions_dynamic` |
| Pending transactions posting (removed + posted with `pending_transaction_id`) | yes | `/transactions/refresh`. Sandbox ignores a refresh sent right after the historical pull, so the lab retries. |
| New transactions | yes | `/sandbox/transactions/create`, then a refresh |
| `ITEM_LOGIN_REQUIRED` | yes | `/sandbox/item/reset_login`. Sync and `/item/get` then really return it. |
| Duplicate, late, and missing webhooks | delivery only | The lab sends the webhook bodies itself, so it decides when each one arrives |
| Repairing a login | no (needs Link update mode in a browser) | Recorded data |
| Data changing mid-pagination | no (not on demand) | Recorded data |
| Exact page boundaries | no | Recorded data |

Ground truth in Sandbox mode is the lab's own full `/transactions/sync` drain, with its own cursor, plus `/item/get`. If Sandbox doesn't produce the needed situation (for example, a refresh that never lands), the scenario is reported as inconclusive. It is never reported as a pass.

A Sandbox run also records every change it observed as fake-bank steps. So a failure found against real Sandbox becomes a fixture that replays offline, with real item ids and access tokens replaced.

## Scenarios

Fake bank (synthetic or recorded data):

| Scenario | What happens | The bug it catches |
|---|---|---|
| `pending-to-posted` | A pending transaction posts; the removal lands on a later page than the addition | Ignoring `removed` |
| `duplicate-webhook-delivery` | The same webhook twice at once, then a late retry | Concurrent handlers that append rows |
| `out-of-order-item-events` | `LOGIN_REPAIRED` arrives before the older `ERROR` | Item health taken from arrival order |
| `paginated-sync` | Modifications, a reversal, and new transactions across pages | Reading one page |
| `mutation-during-pagination` | The bank changes after page *k*; the next page returns `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` | Retrying the failed page instead of restarting the loop |
| `login-required-then-repaired` | Sync fails with `ITEM_LOGIN_REQUIRED`, then the login is repaired and new data arrives | Wiping data on errors; a reconnect prompt that never clears |
| `missed-webhook-reconcile` | A webhook is dropped and nothing else arrives | No scheduled catch-up sync |
| `missed-webhook-catchup` | A webhook is dropped, a later one arrives | Control case. Cursor-based sync recovers on its own |

Real Sandbox (with `--sandbox`): `sandbox-initial-sync`, `sandbox-pending-to-posted`, `sandbox-duplicate-webhook`, `sandbox-login-required`, `sandbox-missed-webhook`. Run `chaos-lab list` for descriptions.

## Invariants

| Invariant | Fails when |
|---|---|
| `no-duplicate-transactions` | A `transaction_id` is stored more than once |
| `no-pending-posted-double-count` | The app holds a pending transaction and the posted one that replaced it |
| `no-phantom-transactions` | The app shows something the bank no longer has |
| `no-missing-transactions` | The bank has something the app doesn't |
| `transaction-fields-current` | Amount, pending flag or date is out of date |
| `item-status-matches` | The app's reconnect prompt disagrees with `/item/get` |
| `sync-restarts-from-original-cursor` | After a mutation error, the next sync call doesn't use the loop's first cursor |
| `webhook-handlers-succeed` | A handler throws or returns non-2xx (warning only) |

Some scenarios also check invariants partway through. `login-required-then-repaired`, for example, checks that the user's data is still there during the outage, not only after it ends.

## Connecting your app

In-process, for JavaScript or TypeScript. Export a factory that wires your integration to the Plaid client the lab passes in. That client has the call shape of `PlaidApi` from `plaid/legacy`, and in `--sandbox` mode it is backed by real Sandbox.

```ts
import type { AdapterFactory } from 'plaid-chaos-lab';

const factory: AdapterFactory = ({ plaid }) => {
  const app = createMyIntegration({ plaid, db: testDb() });
  return {
    registerItem: ({ itemId, accessToken }) => app.saveItem(itemId, accessToken),
    handleWebhook: (body) => app.onPlaidWebhook(body),
    getState: async (itemId) => ({
      transactions: await app.listTransactions(itemId), // [{ transaction_id, amount, pending?, date? }]
      itemStatus: (await app.needsReconnect(itemId)) ? 'login_required' : 'healthy',
    }),
    reconcile: (itemId) => app.scheduledSync(itemId), // optional
  };
};
export default factory;
```

```
npx chaos-lab run --adapter my-adapter.ts --runs 20
```

Over HTTP, for any language. The lab serves a fake Plaid API on port 4010 that the official SDKs accept; point your Plaid base URL at it. Your app exposes:

| Endpoint | Purpose |
|---|---|
| `POST <webhook-url>` | Receives webhooks |
| `POST <control>/reset` | Clears state before each run |
| `POST <control>/items` `{item_id, access_token}` | Stores an Item, as after a token exchange |
| `GET <control>/state?item_id=` | Returns `{ transactions, itemStatus }` as your UI would show them |
| `POST <control>/reconcile` `{item_id}` | Runs your scheduled sync (404 or 501 if you have none) |

```
PLAID_BASE_URL=http://127.0.0.1:4010 npx tsx examples/http-app.ts
npx chaos-lab run --webhook-url http://127.0.0.1:3005/webhooks/plaid --control-url http://127.0.0.1:3005/chaos
```

[examples/http-app.ts](examples/http-app.ts) is tested with both the v51 `PlaidClient` and the classic `PlaidApi`. To run it against real Sandbox instead, set `PLAID_BASE_URL=https://sandbox.plaid.com` and pass `--sandbox` to the lab.

## Keeping failures fixed

```
npx chaos-lab replay chaos-reports/<run>/fixtures/pending-to-posted.seed1.json --adapter my-adapter.ts
```

Or in a test:

```ts
import { replayFixtureFile } from 'plaid-chaos-lab';

test('pending→posted regression', async () => {
  const r = await replayFixtureFile('fixtures/pending-to-posted.seed1.json', myAdapterFactory);
  assert.ok(r.passed);
});
```

## Sandbox setup

Create `.env` with your Sandbox keys from the Plaid Dashboard:

```
PLAID_CLIENT_ID=...
PLAID_SECRET=...
```

The keys go to Plaid in the request body and nowhere else. Errors, timelines, reports, fixtures and cassettes never contain them; `npm run test:sandbox` and `npm run check-secrets` verify that. Each Sandbox scenario creates its own Item and removes it afterwards.

```
npx chaos-lab record --out my-cassette.json        # record real Sandbox data
npx chaos-lab run --adapter my-adapter.ts --sandbox # real Sandbox + recorded fallbacks
```

## CLI

```
chaos-lab list
chaos-lab run     <target> [--scenario a,b] [--seed 1] [--runs 10] [--data file] [--sandbox] [--out dir] [--json]
chaos-lab record  [--out cassette.json]
chaos-lab replay  <fixture.json...> <target>
```

Exit codes: `0` everything passed, `1` an invariant failed, `2` usage or setup error, or a Sandbox scenario was inconclusive.

## How it works

The fake bank ([src/fake-plaid/bank.ts](src/fake-plaid/bank.ts)) keeps a versioned ledger per Item. A cursor names a version. A sync from it returns the diff to the current version (added, modified, removed, ordered by last change), paged over a frozen snapshot. If the bank changes while a pagination loop is open, that loop's page cursors fail with `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`. The loop's first cursor keeps working, as Plaid documents.

Scenarios are seeded generators that produce a plain JSON script, so a fixture replays exactly. The in-process fake client yields a seeded number of event-loop turns per call. Concurrent handlers therefore interleave for real, and the same way every time.

The reference app ([examples/reference-app.ts](examples/reference-app.ts)) has eight switchable bugs. The tests turn each one on alone and confirm that its scenario catches it: on every seed tried with synthetic data, and again with recorded data and with a stubbed Sandbox. The corrected app passes every scenario across 25 seeds.

Limits: only `/transactions/sync` and `/item/get` are simulated. The page-size cap is a test setting (real Plaid pages at your `count`). Webhook JWT verification isn't simulated, so turn it off in test runs.

## Development

```
npm run typecheck
npm test               # offline: fake Plaid, invariants, bug matrix, replay, HTTP with both SDKs, CLI, Sandbox layer
npm run test:sandbox   # live Plaid Sandbox (needs .env)
```

Spec and definitions of done: [PLAN.md](PLAN.md).

# Plaid Integration Chaos Lab — Build Plan

> Unofficial developer tool. Not affiliated with or endorsed by Plaid Inc.

## 1. Problem

Plaid's Transactions and Item lifecycles have edge cases that are documented but easy to get wrong:

| Plaid behavior (documented) | Typical integration bug | What the user sees |
|---|---|---|
| Pending→posted is a **removal of the pending txn + a new posted txn** ([docs](https://plaid.com/docs/transactions/webhooks/)) | Only handles `added` | Coffee counted twice |
| `/transactions/sync` paginates with `has_more` | Reads one page | Missing transactions |
| `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` → **restart the whole loop from the first page's cursor** ([docs](https://plaid.com/docs/api/products/transactions/)) | Retries the failed page / keeps partial pages | Phantom transactions, stuck Item |
| "Design your application to handle **duplicate and out-of-order** webhooks" ([docs](https://plaid.com/docs/api/webhooks/)) | Non-idempotent writes; state driven by arrival order | Duplicates; wrong "reconnect your bank" banner |
| `ITEM_LOGIN_REQUIRED` → `LOGIN_REPAIRED` ([docs](https://plaid.com/docs/api/items/)) | Ignores `LOGIN_REPAIRED`; wipes data on sync error | Banner never clears; empty account during outage |
| Webhooks can be missed (24h retry window, then dropped) | No reconciliation job | Updates never appear |

Plaid's Sandbox lets you *fire* webhooks and create test Items. It does not tell you whether **your app's state is correct afterwards**. The Chaos Lab is that contract tester.

## 2. Goals / Non-goals

**Goals**
1. Run adversarial, **reproducible** (seeded) lifecycle scenarios against an app's Plaid integration.
2. Check named **invariants** against a ground-truth ledger and report pass/fail.
3. On failure, output: the exact **counterexample event sequence**, **before/after app state**, the **user-visible impact** (e.g. "spend overstated by $4.50"), and a **replay fixture** for CI.
4. Two ways to connect: **in-process adapter** (TypeScript/JS module) and **HTTP mode** (any language; the lab runs a fake Plaid API and posts webhooks to your endpoint).
5. Fidelity: the fake Plaid API is wire-compatible enough that the **official `plaid` Node SDK** works against it unmodified (only `basePath` changes).

**Non-goals**
- Not a replacement for Plaid Sandbox or a full Plaid API emulator. Only `/transactions/sync` and `/item/get` are simulated.
- No webhook JWT verification simulation (v1).
- No real credentials or real financial data — all data is synthetic.
- No shrinking/minimization of counterexamples (seeds are small by construction).

## 3. Definitions

| Term | Definition |
|---|---|
| **Bank / ground truth** | The lab's authoritative ledger per Item: current transactions, a version number that increments on every mutation, snapshots of every version, and Item health. |
| **Version cursor** | Cursor pointing at a ground-truth version. Returned as `next_cursor` on the last page of a sync loop. Empty string = beginning of history. |
| **Page cursor** | Cursor pointing at page *k* of a frozen sync snapshot. Returned when `has_more=true`. Becomes invalid if the bank mutates before the loop finishes → `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`. |
| **Sync loop** | The sequence of `/transactions/sync` calls from a version cursor until `has_more=false`. Its **original cursor** is the version cursor of its first call. |
| **Page-size cap** | Chaos knob: the fake caps page size (≤ the requested `count`) to force pagination. Real Plaid paginates at `count`; code must never assume one page. |
| **Replacement pair** | (posted txn T, pending txn P) where `T.pending_transaction_id = P`. Holding both = double count. |
| **Scenario** | A named generator `(seed) → Script`. |
| **Script** | A JSON-serializable list of **steps** (bank mutations, webhook deliveries, drops, concurrent deliveries, armed mid-pagination mutations, Item errors, reconcile triggers, checkpoints). Fully materialized, so it replays exactly. |
| **Target** | The app under test, reached via an adapter (in-process) or HTTP endpoints. |
| **Checkpoint** | A point where the lab reads app state and checks a listed subset of invariants against the truth *at that moment*. |
| **Invariant** | A named, pure check over (truth, app state, API call log) → pass/fail + message. Severity `error` fails a run; `warn` is reported only. |
| **Counterexample** | The timeline (bank changes, webhooks delivered/dropped, API calls with decoded cursors and outcomes, handler errors, checkpoints) of a failing run. |
| **Fixture** | JSON file `{scenario, seed, pageSize, script, observed failures}` replayable with `chaos-lab replay` or `replayFixture()` in a test. |
| **Quiescence** | No in-flight fake-API calls and no new calls for a quiet window. Used so async webhook handlers (respond 200, work later) are measured after they finish. |

## 4. Architecture

```
            ┌───────────────── Chaos Lab ─────────────────┐
 Scenario ──► Script ──► Runner ──► Target ──► your app    │
 (seeded)                 │   ▲       (adapter | HTTP)      │
                          │   │           │                 │
                          ▼   │           ▼                 │
                    Fake Plaid bank ◄── /transactions/sync, /item/get
                    (ground truth,       (in-process client or HTTP server)
                     cursors, faults)
                          │
                          ▼
             Invariants + Impact ──► Console / Markdown / JSON report + fixtures
```

Source layout:

```
src/
  types.ts                 Plaid-shaped types, adapter contract, script schema
  rng.ts                   seeded PRNG (mulberry32)
  fake-plaid/bank.ts       ground truth, versions, diffing, snapshots, pagination, faults
  fake-plaid/errors.ts     Plaid error objects + axios-shaped thrown errors
  fake-plaid/client.ts     in-process plaid-node-shaped client (transactionsSync, itemGet)
  fake-plaid/http-server.ts HTTP fake Plaid API (official SDK compatible)
  scenarios/*.ts           8 scenarios + registry + data helpers
  engine/targets.ts        InProcessTarget, HttpTarget
  engine/runner.ts         executes scripts, timeline, checkpoints, quiescence, explore over seeds
  engine/invariants.ts     invariant catalog
  engine/impact.ts         user-visible impact
  engine/fixture.ts        write/read/replay fixtures
  report/console.ts, report/markdown.ts
  cli.ts                   `chaos-lab list | run | replay`
  index.ts                 public API
examples/
  reference-app.ts         realistic integration with toggleable bugs
  naive-adapter.ts         all bugs on
  robust-adapter.ts        no bugs
  http-app.ts              same app over HTTP using the official `plaid` SDK
  ci-fixture.test.ts       how to put a fixture in CI
test/                      node:test suites
```

## 5. Adapter contract

```ts
// default export of an adapter module
type AdapterFactory = (ctx: { plaid: PlaidClientLike }) => IntegrationAdapter | Promise<IntegrationAdapter>;

interface IntegrationAdapter {
  registerItem(item: { itemId: string; accessToken: string }): Promise<void>;
  handleWebhook(body: PlaidWebhook): Promise<void>;
  getState(itemId: string): Promise<{ transactions: AppTransaction[]; itemStatus?: ItemStatus; cursor?: string | null }>;
  reconcile?(itemId: string): Promise<void>;   // your periodic catch-up job, if any
  close?(): Promise<void>;
}
```
`PlaidClientLike` has the same call shape as `PlaidApi` from the `plaid` SDK (`transactionsSync`, `itemGet`, returning `{ data }`, throwing axios-style errors with `response.data.error_code`).

HTTP mode: the app points its Plaid client at the lab (`--plaid-port`, default 4010) and exposes:
`POST <webhook-url>`, `POST <control>/reset`, `POST <control>/items {item_id, access_token}`, `GET <control>/state?item_id=`, optional `POST <control>/reconcile {item_id}`.

## 6. Invariants

| ID | Severity | Passes when |
|---|---|---|
| `no-duplicate-transactions` | error | Every `transaction_id` appears at most once in app state |
| `no-pending-posted-double-count` | error | App never holds both halves of a replacement pair |
| `no-phantom-transactions` | error | Every app txn exists in ground truth |
| `no-missing-transactions` | error | Every ground-truth txn exists in app state |
| `transaction-fields-current` | error | Amount (and `pending`/`date` if the app reports them) match truth |
| `item-status-matches` | error | App's reported Item status equals truth (`healthy` / `login_required`) |
| `sync-restarts-from-original-cursor` | error | After a mutation-during-pagination error, the next sync call for that Item uses the loop's original cursor |
| `webhook-handlers-succeed` | warn | No webhook handler threw / returned non-2xx |

## 7. Scenarios

Each scenario: injected fault → invariants checked → bug from the reference app it must catch.

| # | ID | Fault | Key invariants | Catches bug |
|---|---|---|---|---|
| 1 | `pending-to-posted` | Pending txn posts (removed + added w/ `pending_transaction_id`, amount may change e.g. tip); page cap forces removal onto a later page | double-count, phantom, fields | `ignoreRemoved` |
| 2 | `duplicate-webhook-delivery` | Same `SYNC_UPDATES_AVAILABLE` delivered twice concurrently, then a late retry | duplicates | `nonIdempotentWrites` |
| 3 | `out-of-order-item-events` | Item breaks then is repaired; `LOGIN_REPAIRED` arrives **before** the stale `ERROR` | item-status | `trustWebhookOrder` |
| 4 | `paginated-sync` | Multi-page initial sync, then modifies/removes/adds across pages | missing, fields | `ignoreHasMore` |
| 5 | `mutation-during-pagination` | Bank mutates after page *k* is served (incl. removing a txn already served) | restart-from-original, phantom, missing | `noRestartOnMutation` |
| 6 | `login-required-then-repaired` | `ITEM_LOGIN_REQUIRED` (sync returns error), stale sync webhook during outage, then `LOGIN_REPAIRED` + new data | item-status (checkpoint + final), missing during outage | `ignoreLoginRepaired`, `clearDataOnSyncError` |
| 7 | `missed-webhook-reconcile` | `SYNC_UPDATES_AVAILABLE` dropped; only the app's reconcile job can recover | missing | `noReconcile` |
| 8 | `missed-webhook-catchup` | Webhook dropped, later webhook delivered; cursor-based sync must pick up both batches | missing, fields | control (shows sync's built-in recovery) |

Seed controls: transaction data, page-size cap (1–4), which page the mutation fires after, async interleaving jitter in the fake client.

## 8. Milestones & Definitions of Done

**M1 — Fake Plaid core** (`bank.ts`, `errors.ts`, `client.ts`)
- [x] Sync from `""` returns full history; from version cursor returns exact diff (added/modified/removed) incl. replacement pairs.
- [x] Pagination honors `min(count, pageSizeCap)`; `has_more`/`next_cursor` correct; last page returns version cursor.
- [x] Mutation while a loop is open makes its page cursors fail with `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` (400, `TRANSACTIONS_ERROR`); original cursor still works.
- [x] Item error makes sync fail with `ITEM_LOGIN_REQUIRED`; `/item/get` reflects `item.error`.
- [x] Errors thrown in axios shape (`err.response.status`, `err.response.data.error_code`).
- [x] Unit tests cover all of the above.

**M2 — Engine** (`runner.ts`, `targets.ts`, `invariants.ts`, `impact.ts`)
- [x] Runner executes every step type; concurrent steps run truly concurrently.
- [x] Timeline records bank changes, webhooks (delivered/dropped), every API call with decoded cursor + outcome, handler errors, checkpoints.
- [x] Quiescence detection so fire-and-forget handlers are measured after completion.
- [x] All 8 invariants implemented with human-readable messages naming txn ids + merchants.
- [x] Impact computes shown vs actual spend and lists duplicates/phantoms/missing/stale amounts/status mismatches.
- [x] Same seed ⇒ byte-identical result JSON (determinism test).

**M3 — Scenarios + reference app**
- [x] 8 scenarios, each with description, docs link, and a materialized script.
- [x] Reference app with 8 toggleable bugs; naive (all bugs) + robust (none) adapters.
- [x] **Robust passes all scenarios for seeds 1–25.**
- [x] **Each bug, enabled alone on the robust app, is caught by its target scenario** (bug-detection matrix test).

**M4 — Reports + fixtures**
- [x] Console report: per-scenario verdict, failing invariants, impact, numbered counterexample, fixture path.
- [x] `report.md` and `report.json` written to `--out` (default `chaos-reports/<timestamp>`).
- [x] Fixtures written for the first failing seed of each scenario; replay reproduces identical invariant results.
- [x] `replayFixture()` + example CI test using `node:test`.

**M5 — CLI + HTTP mode**
- [x] `chaos-lab list`, `run` (`--adapter` or `--webhook-url/--control-url`, `--scenario`, `--seed`, `--runs`, `--out`, `--plaid-port`), `replay`.
- [x] Exit code 1 iff any `error`-severity failure.
- [x] HTTP fake Plaid server compatible with the **official `plaid` SDK** (verified by the HTTP example app using `PlaidApi`).
- [x] HTTP example app passes all scenarios (robust) and fails with `BUGS=all`.

**M6 — Docs**
- [x] README: pitch, quickstart (60 seconds to first counterexample), sample output, scenario + invariant catalog, adapter + HTTP contract, CI usage, fidelity notes/limits, disclaimer.

**Project DoD:** `npm run typecheck` clean · `npm test` green · `npm run demo:naive` shows failures with counterexamples and writes fixtures · `npm run demo:robust` all pass · README complete.

**Status (2026-11-13): Phase 1 complete.** 33/33 tests pass. Each of the 8 bugs is caught on every seed tested; the robust app has 0 false positives over 200 runs. HTTP mode is verified with both official SDK styles.

---

## Phase 2 — Real Plaid Sandbox mode

Goal: run scenarios against **real Plaid Sandbox** where Sandbox can produce the event. Where it can't do that deterministically, fall back to the fake bank seeded with **recorded real `/transactions/sync` responses**.

### What Sandbox can and can't do (verified against Plaid docs)

| Need | Sandbox capability | Plan |
|---|---|---|
| Create Items | `/sandbox/public_token/create` (`user_transactions_dynamic`, `options.webhook`) + `/item/public_token/exchange` | **Real** |
| New transactions | `/sandbox/transactions/create` (≤10 per call, dates ≤ today) + `/transactions/refresh` | **Real** |
| Pending → posted | `user_transactions_dynamic`: `/transactions/refresh` "moves previously pending transactions to posted" | **Real** (which ones post isn't controllable) |
| Fire webhooks | `/sandbox/item/fire_webhook` supports `SYNC_UPDATES_AVAILABLE`, `LOGIN_REPAIRED`, … | **Real** |
| Duplicate delivery | fire `SYNC_UPDATES_AVAILABLE` twice | **Real** |
| Stale/out-of-order Item event | `reset_login`, then fire `LOGIN_REPAIRED` (doesn't change Item state) → app must trust `/item/get`, not the webhook | **Real** |
| `ITEM_LOGIN_REQUIRED` | `/sandbox/item/reset_login` (fires the ERROR webhook) | **Real** |
| Repair the login | Only via Link update mode (browser) — not automatable headlessly | **Fallback** (or optional Playwright later) |
| Mutation during pagination | Not reproducible on demand | **Fallback: recorded responses** |
| Forcing pagination / page boundaries | Not controllable | **Fallback: recorded responses** |
| Dropped / reordered webhooks | Plaid delivers directly | **Real data + lab webhook relay** (see below) |

### Design
1. **SandboxBank**: implements the same truth interface as `FakeBank`, but ground truth comes from an *independent* full drain of `/transactions/sync` from `""` with the lab's own cursor, plus `/item/get`. Bank steps become real Sandbox calls.
2. **Webhook delivery**, two modes:
   - *direct* (default, no tunnel): the lab triggers the real data change in Sandbox and then posts the matching webhook body to the app itself. Real Plaid webhooks go nowhere.
   - *relay*: Items are created with `options.webhook` pointing at the lab's public relay URL (needs a tunnel such as `cloudflared`). The lab forwards real Plaid webhooks to the app, and can **drop, duplicate, delay or reorder** them, so delivery faults are deterministic even though the webhooks are real.
3. **Settling**: Sandbox is eventually consistent, so the lab polls its truth drain until it stabilizes (bounded wait) before checking invariants.
4. **Recorder**: `chaos-lab record --sandbox` creates a dynamic Item, refreshes it, and saves the real sync pages (full transaction objects, including observed pending→posted pairs) to a *cassette*.
5. **Cassette-backed fake**: `--data cassette.json` makes `FakeBank` scenarios use recorded real transactions instead of synthetic ones. Edge cases (mutation mid-pagination, page caps) are injected on top of real-shaped data, and stay deterministic.
6. Each scenario declares `sandbox: 'real' | 'partial' | 'fallback'`, and the report labels every run with the mode it used.

### Needs from the user
- Plaid **Sandbox** `PLAID_CLIENT_ID` + `PLAID_SECRET` in a local `.env` (git-ignored; never committed or printed).
- For relay mode only: a tunnel (`cloudflared tunnel --url http://localhost:<port>`; quick tunnels need no account).

### Findings from the live API (2026-11-13)
- A `user_transactions_dynamic` Item has 311 transactions over 7 accounts. An app syncing with `count=100` really paginates.
- A `/transactions/refresh` sent right after the historical pull is silently ignored; a second one posts 20 pending transactions (removed + posted with `pending_transaction_id`). The lab retries refreshes that change nothing within 20s.
- `HISTORICAL_UPDATE_COMPLETE` can be reported a moment before the data is visible. "Ready" therefore means complete, non-empty, and stable across two drains.
- `/sandbox/item/fire_webhook` needs a public webhook URL on the Item (`SANDBOX_WEBHOOK_INVALID` otherwise), and it refuses `LOGIN_REPAIRED` while the Item is broken. So the default "direct" mode delivers webhook bodies itself.
- `/transactions/sync` occasionally returns a transient `INTERNAL_SERVER_ERROR`. Idempotent calls are retried with backoff.

### Definitions of done
- [x] `chaos-lab run --sandbox` creates real Items and runs the 5 Sandbox scenarios. Verified live: the robust app passes, and `ignoreRemoved` and `trustWebhookOrder` are caught, both in-process and over HTTP with the official v51 SDK. The full single-bug matrix is verified against a Sandbox stub (offline tests).
- [x] Truth comes from an independent Sandbox drain plus `/item/get`. Waits are bounded, and Sandbox not cooperating is reported as `inconclusive` (exit 2), never as a pass.
- [x] `chaos-lab record` writes a cassette (checked in: [examples/fixtures/sandbox-cassette.json](examples/fixtures/sandbox-cassette.json), 349 real transactions, 20 real pending→posted pairs). `--data` runs all 8 scenarios on it deterministically. `--sandbox` runs the 5 non-reproducible scenarios on recorded data.
- [x] Every Sandbox run records what it observed as fake-bank steps, so a real failure replays offline with the same verdicts (verified live). Real item ids and access tokens are replaced.
- [ ] Relay mode (proxy real Plaid webhooks through a tunnel, with drop/duplicate/reorder). Not built: it needs a public tunnel URL, and direct mode already controls delivery.
- [x] Credentials are read only from env and sent only in request bodies, and they never appear in results, fixtures or cassettes. Checked by the live test and by `npm run check-secrets`.
- [x] Live tests run only with `npm run test:sandbox` and Sandbox keys present; `npm test` stays offline.

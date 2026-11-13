# Chaos Lab report

Target: `examples/naive-adapter.ts`  
Data: real Plaid Sandbox, plus recorded Sandbox data for the rest  
Generated: 2026-11-13T12:55:16.240Z  
Result: 3 of 3 scenarios failed

| Scenario | Data | Result | Seeds failed | Invariants broken |
|---|---|---|---|---|
| [sandbox-pending-to-posted](#sandbox-pending-to-posted) | sandbox | **fail** | 1 of 1 | `no-pending-posted-double-count`, `no-phantom-transactions` |
| [sandbox-login-required](#sandbox-login-required) | sandbox | **fail** | 1 of 1 | `no-missing-transactions` |
| [mutation-during-pagination](#mutation-during-pagination) | recorded | **fail** | 1 of 1 | `no-phantom-transactions`, `no-missing-transactions`, `transaction-fields-current`, `sync-restarts-from-original-cursor` |

## sandbox-pending-to-posted

Real pending → posted transitions. **Failed.**

/transactions/refresh on user_transactions_dynamic posts the pending transactions. Plaid removes each pending one and adds a posted one with pending_transaction_id set, and also adds new pending transactions.

If the app ignores `removed`, every posted purchase shows up twice.

Plaid docs: <https://plaid.com/docs/transactions/transactions-data/#pending-and-posted-transactions>

### What broke (seed 1, page size 100, sandbox data)

- `no-pending-posted-double-count` at final: 20 pending transactions are stored alongside their posted replacements: pending Jlo9ZKK549UL3DqNarxet3Rl44pJrBUByxedN "Earnin" $58.00 (pending) is still stored alongside its posted replacement nlWwN33zMwUo5Gq9M46DIpndqLaqrbf3wvMRA "Earnin" $58.00; pending k9gkdrrqxkuBX6gkjxAQs4kD55EaqbFLja1Wg "Apple" $97.67 (pending) is still stored alongside its posted replacement bk7g599J6gUR5GgkLA3eFzw1bkqbv7ioQ86jo "Apple" $97.67; pending KqgZMrr54ZuXxpEN9zLQixnpZZkz7WFR9JDRd "Apple" $16.99 (pending) is still stored alongside its posted replacement NzWgp3357gUQ4wZL7xals4lojAKjz9fXm9AwL "Apple" $16.99; and 17 more
- `no-phantom-transactions` at final: 20 transactions the bank no longer has: Jlo9ZKK549UL3DqNarxet3Rl44pJrBUByxedN "Earnin" $58.00 (pending), k9gkdrrqxkuBX6gkjxAQs4kD55EaqbFLja1Wg "Apple" $97.67 (pending), KqgZMrr54ZuXxpEN9zLQixnpZZkz7WFR9JDRd "Apple" $16.99 (pending), and 17 more

### What the user sees

- Spending is overstated by $515.27: the app shows $9997.66, the bank says $9482.39.
- "Earnin" is listed twice: once as pending ($58.00) and once as posted ($58.00).
- "Apple" is listed twice: once as pending ($97.67) and once as posted ($97.67).
- "Apple" is listed twice: once as pending ($16.99) and once as posted ($16.99).
- 17 more purchases are listed twice the same way.

### Events

```text
 1  item      registered item_chaos_1
 2  bank      v1: 311 added (real Sandbox history: 20 pending, 7 accounts)
 3  webhook   SYNC_UPDATES_AVAILABLE (initial update)
 4  call      /transactions/sync cursor="" (start): +100 ~0 -0 has_more, next_cursor=c1
 5  call      /transactions/sync cursor=c1: +100 ~0 -0 has_more, next_cursor=c2
 6  call      /transactions/sync cursor=c2: +100 ~0 -0 has_more, next_cursor=c3
 7  call      /transactions/sync cursor=c3: +11 ~0 -0, next_cursor=c4
 8  check     after initial sync
 9  bank      v2: 18 added, 20 pending→posted (pending transactions post)
10  webhook   SYNC_UPDATES_AVAILABLE
11  call      /transactions/sync cursor=c4: +38 ~0 -20, next_cursor=c5
12  check     final
```

### Before: after initial sync

Item status: app shows `healthy`, Plaid says `healthy`.
311 of 311 transactions match the bank.

### After

Item status: app shows `healthy`, Plaid says `healthy`.
329 of 349 transactions match the bank.

| | Transaction | Merchant | App | Bank |
|---|---|---|---|---|
| double count | `Jlo9ZKK549UL3DqNarxet3Rl44pJrBUByxedN` | Earnin | $58.00 pending | removed |
| double count | `k9gkdrrqxkuBX6gkjxAQs4kD55EaqbFLja1Wg` | Apple | $97.67 pending | removed |
| double count | `KqgZMrr54ZuXxpEN9zLQixnpZZkz7WFR9JDRd` | Apple | $16.99 pending | removed |
| double count | `rzb9e44dg9UkKGePWjoNSgDrRRzM1qi7Amk7K` | Payment Thank You-Mobile | $-2835.80 pending | removed |
| double count | `zP39gEEQa9UaEMqJGVdpInyQGGjmroilyjX3x` | Apple | $2.99 pending | removed |
| double count | `BG79agg6D9SoGLB6XMqxIMWy88Ejvwc4paxzd` | Amazon | $72.27 pending | removed |
| double count | `3jmd6DDpGdhgoNBapXrJhEyr11VaedtZjXVmz` | Food S | $20.00 pending | removed |
| double count | `x4z5pZZ7g5Tr6XwMkJvpUDpL4465PQi6zgKyq` | Chick-fil-A | $39.35 pending | removed |
| double count | `Jlo9ZKK549UL3DqNarxet3Rl44pJrBUByxeoe` | Interest charged | $20.00 pending | removed |
| double count | `k9gkdrrqxkuBX6gkjxAQs4kD55EaqbFLja1z7` | Interest charged | $32.00 pending | removed |
| double count | `lv8dazzK9dh6WGBbZdmAT1Jg33MdArHpqNmEg` | Monthly payment | $-540.00 pending | removed |
| double count | `3jmd6DDpGdhgoNBapXrJhEyr11VaedtZjXV8p` | Interest charged | $20.00 pending | removed |
| double count | `x4z5pZZ7g5Tr6XwMkJvpUDpL4465PQi6zgKA1` | Interest charged | $32.00 pending | removed |
| double count | `dWQ8qAA5D8fAykj5LnwahPpWQQokZacJb9n6b` | Monthly payment | $-540.00 pending | removed |
| double count | `5eq6D11g46Hz8RpMjnlbsBr6kkGDemC5nJQgm` | Interest charged | $20.00 pending | removed |

5 more rows like these are not shown.

### Replay

```bash
chaos-lab replay docs/sample-run/fixtures/sandbox-pending-to-posted.seed1.json --adapter examples/naive-adapter.ts
```

## sandbox-login-required

Real ITEM_LOGIN_REQUIRED with a stale LOGIN_REPAIRED. **Failed.**

/sandbox/item/reset_login really breaks the Item: sync returns ITEM_LOGIN_REQUIRED and /item/get reports it. A stale sync webhook arrives during the outage. Then a LOGIN_REPAIRED from an earlier recovery arrives late, even though the Item is still broken.

The app should keep the user's data, show a reconnect prompt, and believe /item/get over a webhook that arrives out of order.

Plaid docs: <https://plaid.com/docs/api/sandbox/#sandboxitemreset_login>, <https://plaid.com/docs/api/items/#itemget>, <https://plaid.com/docs/api/webhooks/>

### What broke (seed 1, page size 100, sandbox data)

- `no-missing-transactions` at during outage: 311 of 311 bank transactions missing: oaDR8orKNWcoP4wDapNAINQv7xknXruoMb9do "Sweetgreen" $-810.00, gqXrQ68RZNfaMdkrmjoDImXjK74kAbfEV5DxL "Popeyes" $4.78, 8XmxaP3nVvtRkMeoE7DyUvoZ3VqDreiW18abK "Earnin" $91.53, and 308 more
- `no-missing-transactions` at final: 311 of 311 bank transactions missing: oaDR8orKNWcoP4wDapNAINQv7xknXruoMb9do "Sweetgreen" $-810.00, gqXrQ68RZNfaMdkrmjoDImXjK74kAbfEV5DxL "Popeyes" $4.78, 8XmxaP3nVvtRkMeoE7DyUvoZ3VqDreiW18abK "Earnin" $91.53, and 308 more

### What the user sees

- [during outage] Spending is understated by $9101.24: the app shows $0.00, the bank says $9101.24.
- [during outage] 311 transactions never show up: "Sweetgreen" $810.00, "Popeyes" $4.78, "Earnin" $91.53, ….
- Spending is understated by $9101.24: the app shows $0.00, the bank says $9101.24.
- 311 transactions never show up: "Sweetgreen" $810.00, "Popeyes" $4.78, "Earnin" $91.53, ….

### Events

```text
 1  item      registered item_chaos_1
 2  bank      v1: 311 added (real Sandbox history: 20 pending, 7 accounts)
 3  webhook   SYNC_UPDATES_AVAILABLE (initial update)
 4  call      /transactions/sync cursor="" (start): +100 ~0 -0 has_more, next_cursor=c1
 5  call      /transactions/sync cursor=c1: +100 ~0 -0 has_more, next_cursor=c2
 6  call      /transactions/sync cursor=c2: +100 ~0 -0 has_more, next_cursor=c3
 7  call      /transactions/sync cursor=c3: +11 ~0 -0, next_cursor=c4
 8  bank      v2: 1 modified (Sandbox changed between steps)
 9  check     after initial sync
10  item      now ITEM_LOGIN_REQUIRED (bank requires re-authentication)
11  webhook   ERROR
12  webhook   SYNC_UPDATES_AVAILABLE (stale retry during the outage)
13  call      /transactions/sync cursor=c4: error ITEM_LOGIN_REQUIRED
14  check     during outage
15  webhook   LOGIN_REPAIRED (from an earlier recovery, delivered late)
16  check     final
```

### Before: after initial sync

Item status: app shows `healthy`, Plaid says `healthy`.
311 of 311 transactions match the bank.

### At during outage

Item status: app shows `login_required`, Plaid says `login_required`.
0 of 311 transactions match the bank.

| | Transaction | Merchant | App | Bank |
|---|---|---|---|---|
| missing | `oaDR8orKNWcoP4wDapNAINQv7xknXruoMb9do` | Sweetgreen | not shown | $-810.00 |
| missing | `gqXrQ68RZNfaMdkrmjoDImXjK74kAbfEV5DxL` | Popeyes | not shown | $4.78 |
| missing | `8XmxaP3nVvtRkMeoE7DyUvoZ3VqDreiW18abK` | Earnin | not shown | $91.53 |
| missing | `EXKzoW1qEntKoLnQvB6wUqz7MAxdJwS4RmQqE` | Grubhub | not shown | $134.00 |
| missing | `WnMolAd1gpuGDbEq7ZpKh1qmQjMaEdh69jMkv` | CASH DEPOSIT | not shown | $-496.00 |
| missing | `AXVlMWeDb4t1pmnXbxBQIyp9kPNzBEh9j5wQa` | Bojangles | not shown | $9.95 |
| missing | `GXzG86prBRtN18xbwnARUrpRL65jgqu6Bo95Z` | Playstudios | not shown | $3.00 |
| missing | `ndDXg9Kq1bFx9Q6RELprUpnkrvKNmDtAeQkjD` | American Airlines | not shown | $186.00 |
| missing | `bnXaNo1bQwuakr3jzdq7Izwdv6NAnVumx7LXr` | Denny's | not shown | $4.79 |
| missing | `mxDeowqlZauBx4DA71WKUWPzQRMn9VsgmXjD3` | Panera Bread | not shown | $15.47 |
| missing | `y1KavRjPzDHgRDX15bKzSKLv9abAlWs43wdzL` | Uber Eats | not shown | $52.34 |
| missing | `9X7v4jxbN5tW5Gn9DxK1TkKR3z5gldU4Gg8p7` | Dunkin' | not shown | $70.61 |
| missing | `vQDrmJ4a93iwJrXnqGWRsWLjp5nraesqz1xM9` | Sweetgreen | not shown | $-810.00 |
| missing | `RnMekAr7XZuL4e6wDnXPt7r3BZn1JgtalAjge` | Royal Farms | not shown | $21.77 |
| missing | `6D6wx4zANLfG9RPn4MgZhe4XNqvJ8Zt89eJBw` | Smart & Final | not shown | $48.25 |

296 more rows like these are not shown.

### After

Item status: app shows `login_required`, Plaid says `login_required`.
0 of 311 transactions match the bank.

| | Transaction | Merchant | App | Bank |
|---|---|---|---|---|
| missing | `oaDR8orKNWcoP4wDapNAINQv7xknXruoMb9do` | Sweetgreen | not shown | $-810.00 |
| missing | `gqXrQ68RZNfaMdkrmjoDImXjK74kAbfEV5DxL` | Popeyes | not shown | $4.78 |
| missing | `8XmxaP3nVvtRkMeoE7DyUvoZ3VqDreiW18abK` | Earnin | not shown | $91.53 |
| missing | `EXKzoW1qEntKoLnQvB6wUqz7MAxdJwS4RmQqE` | Grubhub | not shown | $134.00 |
| missing | `WnMolAd1gpuGDbEq7ZpKh1qmQjMaEdh69jMkv` | CASH DEPOSIT | not shown | $-496.00 |
| missing | `AXVlMWeDb4t1pmnXbxBQIyp9kPNzBEh9j5wQa` | Bojangles | not shown | $9.95 |
| missing | `GXzG86prBRtN18xbwnARUrpRL65jgqu6Bo95Z` | Playstudios | not shown | $3.00 |
| missing | `ndDXg9Kq1bFx9Q6RELprUpnkrvKNmDtAeQkjD` | American Airlines | not shown | $186.00 |
| missing | `bnXaNo1bQwuakr3jzdq7Izwdv6NAnVumx7LXr` | Denny's | not shown | $4.79 |
| missing | `mxDeowqlZauBx4DA71WKUWPzQRMn9VsgmXjD3` | Panera Bread | not shown | $15.47 |
| missing | `y1KavRjPzDHgRDX15bKzSKLv9abAlWs43wdzL` | Uber Eats | not shown | $52.34 |
| missing | `9X7v4jxbN5tW5Gn9DxK1TkKR3z5gldU4Gg8p7` | Dunkin' | not shown | $70.61 |
| missing | `vQDrmJ4a93iwJrXnqGWRsWLjp5nraesqz1xM9` | Sweetgreen | not shown | $-810.00 |
| missing | `RnMekAr7XZuL4e6wDnXPt7r3BZn1JgtalAjge` | Royal Farms | not shown | $21.77 |
| missing | `6D6wx4zANLfG9RPn4MgZhe4XNqvJ8Zt89eJBw` | Smart & Final | not shown | $48.25 |

296 more rows like these are not shown.

### Replay

```bash
chaos-lab replay docs/sample-run/fixtures/sandbox-login-required.seed1.json --adapter examples/naive-adapter.ts
```

## mutation-during-pagination

Sync mutation during pagination. **Failed.**

The data changes after page k of a paginated sync, and the next page returns TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION. One transaction already served on page 1 has since been removed. The app has to throw away the partial pages and restart the loop from the loop's original cursor.

Retrying only the failed page loops on the error. Keeping the partial pages leaves phantom transactions that no longer exist.

Plaid docs: <https://plaid.com/docs/errors/transactions/#transactions_sync_mutation_during_pagination>, <https://plaid.com/docs/api/products/transactions/#transactionssync>

### What broke (seed 1, page size 2, recorded data)

- `no-phantom-transactions` at final: 1 transaction the bank no longer has: k5D6pAAx6lsKE8xjB4nzU4vQbG4qj1uJ5pnnK "Veritas Instrument Renta" $33.92
- `no-missing-transactions` at final: 2 of 8 bank transactions missing: rVDGKwwgGxHaEnjWk5Jvsg3r7R8nmLcdRM4W5 "Monthly payment" $-544.00, pVDylAAPyBHxVjAl7vLwf5DjmMvNpzsJMnG93 "Interest charged" $56.00
- `transaction-fields-current` at final: 1 stale transaction:zqrGAzzaGetZbwVGaAl3snReo5nrWdf3bmrrd "Wegmans" $84.59: amount $82.09 ≠ $84.59
- `sync-restarts-from-original-cursor` at final: after the mutation error at #13, the next call (#14) used cursor=page 3 of loop from v1 instead of restarting with cursor=v1
- `webhook-handlers-succeed` (warning) at final: 1 webhook handler failure:#16 SYNC_UPDATES_AVAILABLE: Request failed with status code 400

### What the user sees

- Spending is understated by $24.58: the app shows $207.54, the bank says $232.12.
- "Veritas Instrument Renta" ($33.92) is shown but no longer exists at the bank.
- 2 transactions never show up: "Monthly payment" $544.00, "Interest charged" $56.00.
- "Wegmans" shows $82.09 but actually cleared at $84.59.

### Events

```text
 1  item      registered item_chaos_1
 2  bank      v1: add nVDGbAAMGrHkyZ4MoEJnspxGBjpAMbc3qbRee "Earnin" $91.53; add WGM7pkkL7xcLxNQPg7Mjs1kR59maEdSPzE85A "Monthly payment" $-534.00; add LZarQPP4rkH1neBV… (initial transaction history)
 3  webhook   SYNC_UPDATES_AVAILABLE (initial update)
 4  call      /transactions/sync cursor="" (start): page 1/2: +2 ~0 -0 has_more
 5  call      /transactions/sync cursor=page 2 of loop from v0: page 2/2: +1 ~0 -0
 6  check     after initial sync
 7  bank      v2: add k5D6pAAx6lsKE8xjB4nzU4vQbG4qj1uJ5pnnK "Veritas Instrument Renta" $33.92; add zqrGAzzaGetZbwVGaAl3snReo5nrWdf3bmrrd "Wegmans" $82.09; add LZarQPP4… (new activity)
 8  fault     after page 2 the bank will change: remove k5D6pAAx6lsKE8xjB4nzU4vQbG4qj1uJ5pnnK "Veritas Instrument Renta" $33.92; modify zqrGAzzaGetZbwVGaAl3sn…
 9  webhook   SYNC_UPDATES_AVAILABLE
10  call      /transactions/sync cursor=v1: page 1/3: +2 ~0 -0 has_more
11  call      /transactions/sync cursor=page 2 of loop from v1: page 2/3: +2 ~0 -0 has_more
12  fault     bank changed mid-pagination, now v3
13  call      /transactions/sync cursor=page 3 of loop from v1: error TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION
14  call      /transactions/sync cursor=page 3 of loop from v1: error TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION
15  call      /transactions/sync cursor=page 3 of loop from v1: error TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION
16  error     SYNC_UPDATES_AVAILABLE handler failed: Request failed with status code 400
17  check     final
```

### Before: after initial sync

Item status: app shows `healthy`, Plaid says `healthy`.
3 of 3 transactions match the bank.

### After

Item status: app shows `healthy`, Plaid says `healthy`.
5 of 9 transactions match the bank.

| | Transaction | Merchant | App | Bank |
|---|---|---|---|---|
| ok | `nVDGbAAMGrHkyZ4MoEJnspxGBjpAMbc3qbRee` | Earnin | $91.53 | $91.53 |
| ok | `WGM7pkkL7xcLxNQPg7Mjs1kR59maEdSPzE85A` | Monthly payment | $-534.00 | $-534.00 |
| ok | `LZarQPP4rkH1neBVJAjrhdqXPQ3zrMCenaMgy` | Monthly payment | $-508.00 | $-508.00 |
| stale | `zqrGAzzaGetZbwVGaAl3snReo5nrWdf3bmrrd` | Wegmans | $82.09 | $84.59 |
| ok | `LZarQPP4rkH1neBVJAjrhdqk98dBp7fenaM8g` | Sweetgreen | $-810.00 | $-810.00 |
| ok | `oVDGWyyJGzH3EemxzaZQsNwK1evnXrupeyDPv` | Monthly payment | $-532.00 | $-532.00 |
| missing | `rVDGKwwgGxHaEnjWk5Jvsg3r7R8nmLcdRM4W5` | Monthly payment | not shown | $-544.00 |
| missing | `pVDylAAPyBHxVjAl7vLwf5DjmMvNpzsJMnG93` | Interest charged | not shown | $56.00 |
| phantom | `k5D6pAAx6lsKE8xjB4nzU4vQbG4qj1uJ5pnnK` | Veritas Instrument Renta | $33.92 | removed |

### Replay

```bash
chaos-lab replay docs/sample-run/fixtures/mutation-during-pagination.seed1.json --adapter examples/naive-adapter.ts
```

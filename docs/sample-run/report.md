# Chaos Lab report

`examples/naive-adapter.ts` on real Plaid Sandbox, plus recorded Sandbox data for the rest. 3 of 3 scenarios failed.

| Scenario | Data | Result |
|---|---|---|
| [sandbox-pending-to-posted](#sandbox-pending-to-posted) | sandbox | **fail** (1/1 seeds) |
| [sandbox-login-required](#sandbox-login-required) | sandbox | **fail** (1/1 seeds) |
| [mutation-during-pagination](#mutation-during-pagination) | recorded | **fail** (1/1 seeds) |

## sandbox-pending-to-posted

If the app ignores `removed`, every posted purchase shows up twice. ([Plaid docs](https://plaid.com/docs/transactions/transactions-data/#pending-and-posted-transactions))

- `no-pending-posted-double-count` (final): 20 pending transactions are stored alongside their posted replacements: pending MMj678V7mQcLVq1q7r6gta1QKL59lBcLvBLdk "Earnin" $58.00 (pending) is still stored alongside its posted replacement A3x6nPWnmzTdx6G6yA1QcyeLJb…
- `no-phantom-transactions` (final): 20 transactions the bank no longer has: MMj678V7mQcLVq1q7r6gta1QKL59lBcLvBLdk "Earnin" $58.00 (pending), 1p45lRBlaghD5p1prodjUrQRd8P5JqupRgpAE "Apple" $97.67 (pending), xVgyrjmrJ8SebNkNozjBUDeGJLzK4vF6jo6r5 "Apple" $16.…

**User sees:**

- Spending is overstated by $515.27: the app shows $12044.28, the bank says $11529.01.
- "Earnin" is listed twice: once as pending ($58.00) and once as posted ($58.00).
- "Apple" is listed twice: once as pending ($97.67) and once as posted ($97.67).
- "Apple" is listed twice: once as pending ($16.99) and once as posted ($16.99).

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

App vs bank (final):

| | Transaction | Merchant | App | Bank |
|---|---|---|---|---|
| double count | `MMj678V7mQcLVq1q7r6gta1QKL59lBcLvBLdk` | Earnin | $58.00 pending | removed |
| double count | `1p45lRBlaghD5p1prodjUrQRd8P5JqupRgpAE` | Apple | $97.67 pending | removed |
| double count | `xVgyrjmrJ8SebNkNozjBUDeGJLzK4vF6jo6r5` | Apple | $16.99 pending | removed |
| double count | `dVDBwL9wrzSr41L1Gl87UPjzDWmrQ7iJKwJVL` | Payment Thank You-Mobile | $-2835.80 pending | removed |
| double count | `aVBKeZGelqSLx1b1QdeRtWBR17rlMgtZwqZyy` | Apple | $2.99 pending | removed |
| double count | `48aDrRdrPWhP14m4roxyTzgVBQxk5ouJzeJGD` | Amazon | $72.27 pending | removed |
| double count | `N176REyR9Zhp9X7XezK8T4qVEezojWtydvyeM` | Food S | $20.00 pending | removed |
| double count | `PpQ6blAbw1hg6zjzo3JLhP9LR1nbkMioaDo3G` | Chick-fil-A | $39.35 pending | removed |

12 more.

Replay: `chaos-lab replay docs/sample-run/fixtures/sandbox-pending-to-posted.seed1.json --adapter examples/naive-adapter.ts`

## sandbox-login-required

The app should keep the user's data, show a reconnect prompt, and believe /item/get over a webhook that arrives out of order. ([Plaid docs](https://plaid.com/docs/api/sandbox/#sandboxitemreset_login))

- `no-missing-transactions` (during outage): 311 of 311 bank transactions missing: rpzWlqDEokf4xkAqkGKVugeBkkwejLf7L4r1y "Sweetgreen" $-810.00, zkPwdJrK1pTvWamoaMEQfn5DwwV5JNflDrAQo "Popeyes" $4.78, B4GKzwZPWEFJmorQoLGDiMJQnn9JPrT4qE9g4 "Earnin" $91.53, and 308 mo…
- `no-missing-transactions` (final): 311 of 311 bank transactions missing: rpzWlqDEokf4xkAqkGKVugeBkkwejLf7L4r1y "Sweetgreen" $-810.00, zkPwdJrK1pTvWamoaMEQfn5DwwV5JNflDrAQo "Popeyes" $4.78, B4GKzwZPWEFJmorQoLGDiMJQnn9JPrT4qE9g4 "Earnin" $91.53, and 308 mo…

**User sees:**

- [during outage] Spending is understated by $9101.24: the app shows $0.00, the bank says $9101.24.
- [during outage] 311 transactions never show up: "Sweetgreen" $810.00, "Popeyes" $4.78, "Earnin" $91.53, ….
- Spending is understated by $9101.24: the app shows $0.00, the bank says $9101.24.
- 311 transactions never show up: "Sweetgreen" $810.00, "Popeyes" $4.78, "Earnin" $91.53, ….

```text
 1  item      registered item_chaos_1
 2  bank      v1: 311 added (real Sandbox history: 20 pending, 7 accounts)
 3  webhook   SYNC_UPDATES_AVAILABLE (initial update)
 4  call      /transactions/sync cursor="" (start): +100 ~0 -0 has_more, next_cursor=c1
 5  call      /transactions/sync cursor=c1: +100 ~0 -0 has_more, next_cursor=c2
 6  call      /transactions/sync cursor=c2: +100 ~0 -0 has_more, next_cursor=c3
 7  call      /transactions/sync cursor=c3: +11 ~0 -0, next_cursor=c4
 8  check     after initial sync
 9  item      now ITEM_LOGIN_REQUIRED (bank requires re-authentication)
10  webhook   ERROR
11  webhook   SYNC_UPDATES_AVAILABLE (stale retry during the outage)
12  call      /transactions/sync cursor=c4: error ITEM_LOGIN_REQUIRED
13  check     during outage
14  webhook   LOGIN_REPAIRED (from an earlier recovery, delivered late)
15  check     final
```

App vs bank (during outage):

| | Transaction | Merchant | App | Bank |
|---|---|---|---|---|
| missing | `rpzWlqDEokf4xkAqkGKVugeBkkwejLf7L4r1y` | Sweetgreen | not shown | $-810.00 |
| missing | `zkPwdJrK1pTvWamoaMEQfn5DwwV5JNflDrAQo` | Popeyes | not shown | $4.78 |
| missing | `B4GKzwZPWEFJmorQoLGDiMJQnn9JPrT4qE9g4` | Earnin | not shown | $91.53 |
| missing | `3yjXePb1x4cPKg6ZgNo3CE4RZZ645KUZG67Em` | Grubhub | not shown | $134.00 |
| missing | `xA4W3xqlm1IlarBQrX6ZcD3vaay3wjf6mj5eJ` | CASH DEPOSIT | not shown | $-496.00 |
| missing | `dxW3PgXE9vudXA7pAkyVFPM7VVqMLeiJoK8R6` | Bojangles | not shown | $9.95 |
| missing | `azgrakXpGvcZrXRaXKnVfW5gXXP5zEIZpwjDP` | Playstudios | not shown | $3.00 |
| missing | `497kQ6bLdNSk3VyJV5LXhzRoNNKRe3CJ8z6L9` | American Airlines | not shown | $186.00 |

303 more.

App vs bank (final):

| | Transaction | Merchant | App | Bank |
|---|---|---|---|---|
| missing | `rpzWlqDEokf4xkAqkGKVugeBkkwejLf7L4r1y` | Sweetgreen | not shown | $-810.00 |
| missing | `zkPwdJrK1pTvWamoaMEQfn5DwwV5JNflDrAQo` | Popeyes | not shown | $4.78 |
| missing | `B4GKzwZPWEFJmorQoLGDiMJQnn9JPrT4qE9g4` | Earnin | not shown | $91.53 |
| missing | `3yjXePb1x4cPKg6ZgNo3CE4RZZ645KUZG67Em` | Grubhub | not shown | $134.00 |
| missing | `xA4W3xqlm1IlarBQrX6ZcD3vaay3wjf6mj5eJ` | CASH DEPOSIT | not shown | $-496.00 |
| missing | `dxW3PgXE9vudXA7pAkyVFPM7VVqMLeiJoK8R6` | Bojangles | not shown | $9.95 |
| missing | `azgrakXpGvcZrXRaXKnVfW5gXXP5zEIZpwjDP` | Playstudios | not shown | $3.00 |
| missing | `497kQ6bLdNSk3VyJV5LXhzRoNNKRe3CJ8z6L9` | American Airlines | not shown | $186.00 |

303 more.

Replay: `chaos-lab replay docs/sample-run/fixtures/sandbox-login-required.seed1.json --adapter examples/naive-adapter.ts`

## mutation-during-pagination

Retrying only the failed page loops on the error. Keeping the partial pages leaves phantom transactions that no longer exist. ([Plaid docs](https://plaid.com/docs/errors/transactions/#transactions_sync_mutation_during_pagination))

- `no-phantom-transactions` (final): 1 transaction the bank no longer has: k5D6pAAx6lsKE8xjB4nzU4vQbG4qj1uJ5pnnK "Veritas Instrument Renta" $33.92
- `no-missing-transactions` (final): 2 of 8 bank transactions missing: rVDGKwwgGxHaEnjWk5Jvsg3r7R8nmLcdRM4W5 "Monthly payment" $-544.00, pVDylAAPyBHxVjAl7vLwf5DjmMvNpzsJMnG93 "Interest charged" $56.00
- `transaction-fields-current` (final): 1 stale transaction:zqrGAzzaGetZbwVGaAl3snReo5nrWdf3bmrrd "Wegmans" $84.59: amount $82.09 ≠ $84.59
- `sync-restarts-from-original-cursor` (final): after the mutation error at #13, the next call (#14) used cursor=page 3 of loop from v1 instead of restarting with cursor=v1
- `webhook-handlers-succeed` (final, warning): 1 webhook handler failure:#16 SYNC_UPDATES_AVAILABLE: Request failed with status code 400

**User sees:**

- Spending is understated by $24.58: the app shows $207.54, the bank says $232.12.
- "Veritas Instrument Renta" ($33.92) is shown but no longer exists at the bank.
- 2 transactions never show up: "Monthly payment" $544.00, "Interest charged" $56.00.
- "Wegmans" shows $82.09 but actually cleared at $84.59.

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

App vs bank (final):

| | Transaction | Merchant | App | Bank |
|---|---|---|---|---|
| stale | `zqrGAzzaGetZbwVGaAl3snReo5nrWdf3bmrrd` | Wegmans | $82.09 | $84.59 |
| missing | `rVDGKwwgGxHaEnjWk5Jvsg3r7R8nmLcdRM4W5` | Monthly payment | not shown | $-544.00 |
| missing | `pVDylAAPyBHxVjAl7vLwf5DjmMvNpzsJMnG93` | Interest charged | not shown | $56.00 |
| phantom | `k5D6pAAx6lsKE8xjB4nzU4vQbG4qj1uJ5pnnK` | Veritas Instrument Renta | $33.92 | removed |

Replay: `chaos-lab replay docs/sample-run/fixtures/mutation-during-pagination.seed1.json --adapter examples/naive-adapter.ts`

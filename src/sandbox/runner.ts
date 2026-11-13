import type {
  BankOp,
  InvariantId,
  InvariantResult,
  ItemStatus,
  NewTimelineEvent,
  RunResult,
  StateCapture,
  Step,
  TimelineEvent,
  Transaction,
} from '../types.ts';
import { Rng } from '../rng.ts';
import { runChecks } from '../engine/invariants.ts';
import { userImpact } from '../engine/impact.ts';
import type { Target } from '../engine/targets.ts';
import { ACCESS_TOKEN, ITEM_ID, itemErrorWebhook, loginRepairedWebhook, syncWebhook } from '../scenarios/helpers.ts';
import type { SandboxApi } from './api.ts';
import { SandboxPlaidClient } from './client.ts';
import type { SandboxScenario, SandboxStep } from './scenarios.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sandbox could not set up the situation the scenario needs. The run proves nothing either way. */
export class InconclusiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InconclusiveError';
  }
}

export interface SandboxRunOptions {
  api: SandboxApi;
  target: Target;
  scenario: SandboxScenario;
  seed: number;
  /** Ceiling for waiting on Sandbox (Item readiness, refresh results). */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Turn two ground-truth snapshots into the bank ops a fixture replays. */
export function diffToOps(before: Transaction[], after: Transaction[]): BankOp[] {
  const prev = new Map(before.map((t) => [t.transaction_id, t]));
  const next = new Map(after.map((t) => [t.transaction_id, t]));
  const removed = new Set([...prev.keys()].filter((id) => !next.has(id)));
  const ops: BankOp[] = [];
  for (const t of after) {
    if (prev.has(t.transaction_id)) continue;
    if (t.pending_transaction_id && removed.has(t.pending_transaction_id)) {
      removed.delete(t.pending_transaction_id);
      ops.push({ op: 'post', pending_id: t.pending_transaction_id, posted: t });
    } else {
      ops.push({ op: 'add', txn: t });
    }
  }
  for (const t of after) {
    const p = prev.get(t.transaction_id);
    if (p && JSON.stringify(p) !== JSON.stringify(t)) {
      const { transaction_id: _id, ...changes } = t;
      ops.push({ op: 'modify', transaction_id: t.transaction_id, changes });
    }
  }
  for (const id of removed) ops.push({ op: 'remove', transaction_id: id });
  return ops;
}

function describeOps(ops: BankOp[]): string {
  const n = (k: BankOp['op']) => ops.filter((o) => o.op === k).length;
  const parts = [
    n('add') && `${n('add')} added`,
    n('post') && `${n('post')} pending→posted`,
    n('modify') && `${n('modify')} modified`,
    n('remove') && `${n('remove')} removed`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no changes';
}

const sameLedger = (a: Transaction[], b: Transaction[]) => {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((t) => [t.transaction_id, JSON.stringify(t)]));
  return b.every((t) => m.get(t.transaction_id) === JSON.stringify(t));
};

/**
 * Run a scenario against real Plaid Sandbox.
 *
 * Ground truth is an independent drain of /transactions/sync (the lab's own
 * cursor) plus /item/get. Every transition the lab observes is also written as
 * fake-bank steps, so the run's `script` replays deterministically offline.
 */
export async function runSandboxScenario(opts: SandboxRunOptions): Promise<RunResult> {
  const { api, target, scenario, seed } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const log = opts.log ?? (() => {});
  const rng = new Rng(seed);

  const timeline: TimelineEvent[] = [];
  const push = (e: NewTimelineEvent) => void timeline.push({ ...e, seq: timeline.length + 1 } as TimelineEvent);
  const recorded: Step[] = [];
  const invariants: InvariantResult[] = [];
  const states: StateCapture[] = [];
  const seen = new Map<string, Transaction>();
  const replacements = new Map<string, string>();

  // Assigned inside exec(); the cast keeps TypeScript from narrowing it to null.
  let item = null as { itemId: string; accessToken: string } | null;
  let truth: Transaction[] = [];
  let version = 0;
  let concurrentGroup = 0;
  const client = new SandboxPlaidClient(api, push, ITEM_ID);

  const remember = (txns: Transaction[]) => {
    for (const t of txns) {
      seen.set(t.transaction_id, t);
      if (t.pending_transaction_id) replacements.set(t.transaction_id, t.pending_transaction_id);
    }
  };

  const recordTruthChange = (next: Transaction[], note: string) => {
    const ops = diffToOps(truth, next);
    truth = next;
    remember(next);
    if (!ops.length) return ops;
    version += 1;
    push({ kind: 'bank', itemId: ITEM_ID, version, summary: describeOps(ops), note });
    recorded.push({ type: 'bank', item_id: ITEM_ID, ops, note });
    return ops;
  };

  const need = () => {
    if (!item) throw new Error(`${scenario.id}: no Item yet (create-item must come first)`);
    return item;
  };

  const realStatus = async (): Promise<ItemStatus> => {
    const r = await api.itemGet(need().accessToken);
    return r.item.error?.error_code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'healthy';
  };

  const settle = async () => {
    const deadline = Date.now() + timeoutMs;
    if (target.observesCalls) {
      let last = -1;
      let quietSince = Date.now();
      while (Date.now() < deadline) {
        if (client.inflight > 0 || client.callCount !== last) {
          last = client.callCount;
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= 400) return;
        await sleep(25);
      }
      return;
    }
    // HTTP + Sandbox: the app talks to Plaid directly, so wait for its visible state to stop changing.
    let prev = '';
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const cur = JSON.stringify(await target.getState(need().itemId));
      if (cur !== prev) {
        prev = cur;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 2_000) return;
      await sleep(250);
    }
  };

  const webhookFor = (code: 'SYNC_UPDATES_AVAILABLE' | 'ERROR' | 'LOGIN_REPAIRED', itemId: string) =>
    code === 'SYNC_UPDATES_AVAILABLE' ? syncWebhook(itemId) : code === 'ERROR' ? itemErrorWebhook(itemId) : loginRepairedWebhook(itemId);

  const exec = async (step: SandboxStep, group?: number): Promise<void> => {
    switch (step.type) {
      case 'create-item': {
        log('creating Sandbox Item');
        item = await api.createItem();
        push({ kind: 'register', itemId: ITEM_ID });
        recorded.push({ type: 'register-item', item_id: ITEM_ID, access_token: ACCESS_TOKEN });
        // Sandbox can report HISTORICAL_UPDATE_COMPLETE a moment before the data is
        // visible, so "ready" means: complete, non-empty, and unchanged across two drains.
        const deadline = Date.now() + timeoutMs;
        let drained = await api.drain(item.accessToken);
        let stable = false;
        while (Date.now() < deadline) {
          await sleep(1_500);
          const again = await api.drain(item.accessToken);
          stable =
            again.status === 'HISTORICAL_UPDATE_COMPLETE' && again.transactions.length > 0 && sameLedger(again.transactions, drained.transactions);
          drained = again;
          if (stable) break;
        }
        if (!stable) throw new InconclusiveError('Sandbox Item never finished its historical pull');
        const pending = drained.transactions.filter((t) => t.pending).length;
        const accounts = new Set(drained.transactions.map((t) => t.account_id)).size;
        recordTruthChange(drained.transactions, `real Sandbox history: ${pending} pending, ${accounts} accounts`);
        await target.registerItem(item.itemId, item.accessToken);
        return;
      }
      case 'create-transactions': {
        const today = new Date().toISOString().slice(0, 10);
        const merchants = ['CHAOS LAB COFFEE', 'CHAOS LAB GROCERY', 'CHAOS LAB RIDESHARE', 'CHAOS LAB PHARMACY'];
        await api.createTransactions(
          need().accessToken,
          Array.from({ length: step.count }, () => ({
            amount: rng.money(3, 80),
            date_transacted: today,
            date_posted: today,
            description: rng.pick(merchants),
          })),
        );
        return;
      }
      case 'refresh': {
        const result = await api.refreshAndWait(need().accessToken, truth);
        if (!result.changed) throw new InconclusiveError('Sandbox /transactions/refresh produced no changes after 3 attempts');
        recordTruthChange(result.transactions, step.note ?? '/transactions/refresh');
        return;
      }
      case 'reset-login':
        await api.resetLogin(need().accessToken);
        push({ kind: 'item-error', itemId: ITEM_ID, errorCode: 'ITEM_LOGIN_REQUIRED', note: step.note });
        recorded.push({ type: 'item-error', item_id: ITEM_ID, error_code: 'ITEM_LOGIN_REQUIRED', note: step.note });
        return;
      case 'webhook': {
        push({ kind: 'webhook', code: step.code, itemId: ITEM_ID, delivery: 'delivered', note: step.note, concurrentGroup: group });
        recorded.push({ type: 'webhook', payload: webhookFor(step.code, ITEM_ID), note: step.note });
        const res = await target.deliverWebhook(webhookFor(step.code, need().itemId));
        if (!res.ok) push({ kind: 'handler-error', code: step.code, message: res.error });
        return;
      }
      case 'drop-webhook':
        push({ kind: 'webhook', code: step.code, itemId: ITEM_ID, delivery: 'dropped', note: step.note });
        recorded.push({ type: 'drop-webhook', payload: webhookFor(step.code, ITEM_ID), note: step.note });
        return;
      case 'concurrent': {
        const g = ++concurrentGroup;
        const before = recorded.length;
        await Promise.all(step.steps.map((s) => exec(s, g)));
        const inner = recorded.splice(before);
        recorded.push({ type: 'concurrent', steps: inner, note: step.note });
        return;
      }
      case 'reconcile': {
        const res = await target.reconcile(need().itemId);
        push({ kind: 'reconcile', itemId: ITEM_ID, outcome: res.outcome, message: res.outcome === 'error' ? res.message : step.note });
        recorded.push({ type: 'reconcile', item_id: ITEM_ID, note: step.note });
        return;
      }
      case 'checkpoint':
        await capture(step.label, step.checks);
        return;
    }
  };

  const capture = async (label: string, checks: InvariantId[]) => {
    await settle();
    const { itemId, accessToken } = need();
    const status = await realStatus();
    if (status === 'healthy') {
      // Sandbox can change on its own. Record any drift before the checkpoint so a
      // replay sees the same data the app could have seen.
      const latest = (await api.drain(accessToken)).transactions;
      if (!sameLedger(latest, truth)) recordTruthChange(latest, 'Sandbox changed between steps');
    }
    push({ kind: 'checkpoint', label });
    if (label !== 'final') recorded.push({ type: 'checkpoint', label, checks });
    const app = await target.getState(itemId);
    states.push({ label, app, truth: { transactions: truth, itemStatus: status } });
    invariants.push(
      ...runChecks(checks, { at: label, itemId: ITEM_ID, app, truth, truthStatus: status, seen, replacements, timeline }),
    );
  };

  await target.begin({ client, seed });
  try {
    for (const step of scenario.steps) {
      log(`${scenario.id}: ${step.type}`);
      await exec(step);
      if (step.type !== 'create-transactions' && step.type !== 'reset-login' && step.type !== 'checkpoint') await settle();
    }
    await capture('final', [...scenario.finalChecks, 'webhook-handlers-succeed']);
  } finally {
    await target.end();
    if (item) await api.removeItem(item.accessToken).catch(() => undefined);
  }

  const impact: string[] = [];
  for (const s of states) {
    if (!invariants.some((r) => r.at === s.label && !r.passed && r.severity === 'error')) continue;
    const lines = userImpact({ app: s.app, truth: s.truth.transactions, truthStatus: s.truth.itemStatus, seen, replacements });
    impact.push(...lines.map((l) => (s.label === 'final' ? l : `[${s.label}] ${l}`)));
  }

  return {
    scenario: scenario.id,
    source: 'sandbox',
    seed,
    pageSize: 100,
    passed: !invariants.some((r) => !r.passed && r.severity === 'error'),
    invariants,
    impact,
    timeline,
    states,
    // Replays offline on the fake bank: the real transitions this run observed.
    script: { pageSize: 100, steps: recorded },
  };
}

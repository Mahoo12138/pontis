// Trigger orchestration (doc 05 §14/§15). PR-B1's requirement is that an
// alarm, a manual click, a worker wake and a recovery attempt cannot all
// replay the same inbox — and that guarantee is assembled here, not inside any
// single collaborator, so it is the part this file tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireRunLock,
  emptyReconProgress,
  PontisDB,
  type BindingRecord,
  type PendingOpRecord,
} from './../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import type { BrowserNode } from '../browser/types';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { ReplicaVerifier } from './verifyReplica';
import { ResyncService } from './resync';
import { SyncCoordinator } from './syncCoordinator';
import { WorkerLoop, type ReconcileDriver } from './workerLoop';
import { FakeServerTransport } from '../../testing/fakeServer';
import { BootstrapStore } from '../store/bootstrap';
import type { SyncTransport } from '../transport/client';
import type { SyncRequestWire, SyncResponseWire } from '../protocol/types';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let server: FakeServerTransport;
let transport: SpyTransport;
let coordinator: SyncCoordinator;
let verifier: ReplicaVerifier;
let resync: ResyncService;
let reconciler: StubReconciler;
let loop: WorkerLoop;
/** The reconciliation entry a full resync drives; recorded, never run for real. */
const resyncDriver = {
  calls: [] as string[],
  resyncFromServer: async (id: string): Promise<'waiting_user' | 'completed' | 'idle'> => {
    resyncDriver.calls.push(id);
    return 'idle';
  },
};

const bindingId = 'binding-1';
const otherBinding = 'binding-2';

/** Counts rounds and holds the connection open long enough to overlap. */
class SpyTransport implements SyncTransport {
  calls: { bindingId: string; ops: number; applied: number }[] = [];
  private waiters: (() => void)[] = [];
  constructor(private inner: FakeServerTransport, private delayMs = 0) {}

  async sync(bindingId: string, req: SyncRequestWire): Promise<SyncResponseWire> {
    this.calls.push({ bindingId, ops: req.operations.length, applied: req.applied_revision });
    this.waiters.splice(0).forEach((wake) => wake());
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.sync(bindingId, req);
  }

  /**
   * Resolves once `n` requests have actually started. A test that needs a round
   * to be mid-flight waits on this rather than on a guessed sleep, which is the
   * difference between a check and a race.
   */
  async until(n: number): Promise<void> {
    while (this.calls.length < n) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

/** Records what the loop asked the reconciler to do. */
class StubReconciler implements ReconcileDriver {
  run: string[] = [];
  recovered: string[] = [];
  resumed: string[] = [];
  failsFor = '';
  /** Whether finishing a round leaves the binding active. Off by default so a
   *  test can tell "the loop waited for the mapping" from "the loop synced it". */
  activates = false;

  runBinding(id: string): Promise<unknown> {
    this.run.push(id);
    if (id === this.failsFor) return Promise.reject(new Error('reconciliation blew up'));
    // Driving a binding to activity is the reconciler's own business; the loop
    // only needs to know the round is over.
    return Promise.resolve(this.activate(id));
  }

  recoverMapping(id: string): Promise<unknown> {
    this.recovered.push(id);
    return Promise.resolve('completed');
  }

  resumeRecovery(id: string): Promise<unknown> {
    this.resumed.push(id);
    return Promise.resolve('idle');
  }

  private async activate(id: string): Promise<string> {
    if (!this.activates) return 'waiting_user';
    await db.bindings.update(id, { state: 'active', appliedRevision: 1, receivedRevision: 1 });
    return 'completed';
  }
}

async function seedBinding(id = bindingId, over: Partial<BindingRecord> = {}): Promise<BindingRecord> {
  const binding: BindingRecord = {
    id,
    spaceId: 'space-1',
    spaceName: 'Personal',
    mode: 'partial',
    state: 'active',
    epoch: 1,
    appliedRevision: 1,
    receivedRevision: 1,
    clientSeq: 0,
    mount: { mode: 'partial', folderBrowserId: 'f1', rootKey: 'main' },
    lastSyncAt: null,
    recovery: null,
    createdAt: Date.now(),
    ...over,
  };
  await db.bindings.put(binding);
  return binding;
}

async function seedQueuedOp(opId: string, title: string): Promise<void> {
  const op: PendingOpRecord = {
    opId,
    bindingId,
    clientSeq: Number(opId.slice(-1)),
    baseRevision: 1,
    status: 'QUEUED',
    type: 'create',
    nodeId: '',
    nodeType: 'bookmark',
    title,
    url: `https://${title}.example.com`,
    parent: { type: 'root', key: 'main' },
    beforeId: undefined,
    browserId: undefined,
    createdAt: Date.now(),
  };
  await db.pendingOps.add(op);
}

// The diagnostics table is not indexed by scope; reading it whole is fine at
// test size and keeps the assertion about what was reported, not how it is keyed.
const messages = async (scope: string): Promise<string[]> =>
  (await db.diagnostics.toArray()).filter((d) => d.scope === scope).map((d) => d.message);

const created = (id: string, title: string): { kind: 'created'; node: BrowserNode } => ({
  kind: 'created',
  node: { id, parentId: 'f1', type: 'bookmark', title, url: `https://${title}.example.com`, index: 0 },
});

beforeEach(() => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  server = new FakeServerTransport();
  transport = new SpyTransport(server, 0);
  coordinator = new SyncCoordinator(db, new RemoteChangeApplier(db, adapter), transport);
  verifier = new ReplicaVerifier(db, adapter, coordinator);
  // Keyed lookups, not a {key: value} wrapper: that shape belongs to
  // chrome.storage.local, not to the core KV abstraction (docs/21 §10).
  const kv = new BootstrapStore({
    get: async (key: string) => (key === 'bootstrap' ? { serverUrl: 'http://x', deviceToken: 'tok' } : undefined),
    set: async () => undefined,
    remove: async (keys: string[]) => undefined,
  });
  resyncDriver.calls = [];
  resync = new ResyncService(db, kv, resyncDriver, verifier);
  reconciler = new StubReconciler();
  loop = new WorkerLoop({ db, adapter, coordinator, reconciler, resync, verifier });
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
});

describe('one round per binding across triggers', () => {
  it('does not let a second trigger replay the same inbox', async () => {
    await seedBinding();
    await seedQueuedOp('op-9', 'Home');

    // A round that stays open long enough for the other triggers to arrive
    // while it still holds the binding.
    const slow = new SpyTransport(server, 25);
    const slowCoordinator = new SyncCoordinator(db, new RemoteChangeApplier(db, adapter), slow);
    const slowLoop = new WorkerLoop({
      db, adapter, coordinator: slowCoordinator, reconciler, resync, verifier,
    });

    // alarm + manual + wake landing on the same instant, as after a browser
    // restart with the user already clicking.
    await Promise.all([
      slowLoop.runSync('alarm'),
      slowLoop.runSync('manual', { rerunOnJoin: true }),
      slowLoop.runSync('wake'),
    ]);
    transport = slow;

    // The invariant is that the intent is carried once, not that only one
    // request ever leaves: the click joined the running pass and was owed a
    // second sweep, which finds nothing left to send.
    expect(slow.calls.reduce((ops, call) => ops + call.ops, 0)).toBe(1);
    expect(slow.calls[0]?.ops).toBe(1);
    // They joined the running pass instead of losing a lock race, so nothing
    // is left to explain away.
    expect(await messages('coordinator')).not.toContain('另一轮正在处理该绑定，本轮跳过');
  });

  it('does not report a skipped round when a wake lands with the alarm', async () => {
    await seedBinding();
    await seedQueuedOp('op-9', 'Home');

    // MV3 kills the worker between alarms, so every alarm restarts it: the
    // module body runs the wake pass while the alarm event is delivered to the
    // listener. These two are not an unlucky collision, they always land
    // together — which read as a skipped round every five minutes, forever.
    await Promise.all([loop.runSync('wake'), loop.runSync('alarm')]);

    expect(await messages('coordinator')).not.toContain('另一轮正在处理该绑定，本轮跳过');
    expect(transport.calls).toHaveLength(1);
  });

  it('serves a trigger that lands while a pass is already running', async () => {
    await seedBinding();
    await seedQueuedOp('op-1', 'First');

    const slow = new SpyTransport(server, 40);
    const slowCoordinator = new SyncCoordinator(db, new RemoteChangeApplier(db, adapter), slow);
    const slowLoop = new WorkerLoop({
      db, adapter, coordinator: slowCoordinator, reconciler, resync, verifier,
    });

    const first = slowLoop.runSync('alarm');
    // Let the running pass get far enough that it has already read the inbox.
    await slow.until(1);
    expect(slow.calls).toHaveLength(1);

    await seedQueuedOp('op-2', 'Second');
    await Promise.all([first, slowLoop.runSync('manual', { rerunOnJoin: true })]);
    transport = slow;

    // Joining must not strand the newer work until the next alarm: it earns one
    // more sweep.
    expect(slow.calls).toHaveLength(2);
    expect(server.journal).toHaveLength(2);
  });
});

describe('what each trigger is allowed to touch', () => {
  it('reconciles a pending binding instead of incrementally syncing it', async () => {
    await seedBinding(bindingId, { state: 'pending_initial', appliedRevision: 0, receivedRevision: 0 });

    await loop.runSync('alarm');

    expect(reconciler.run).toEqual([bindingId]);
    // A binding without a mapping has nothing to sync: the incremental loop
    // must not have spent the inbox (doc 08 §11).
    expect(transport.calls).toHaveLength(0);
  });

  it('hands the binding over to the reconciler and syncs it after it turns active', async () => {
    await seedBinding(bindingId, { state: 'pending_initial', appliedRevision: 0, receivedRevision: 0 });
    await seedQueuedOp('op-9', 'Home');

    await loop.runSync('alarm');

    // Reconciliation ran first, then the ordinary pass picked up the now-active
    // binding — in one trigger, so a user's edits are not left behind.
    reconciler.activates = true;
    // re-run with the binding left active by the round that just finished
    await db.bindings.update(bindingId, { state: 'pending_initial', appliedRevision: 0, receivedRevision: 0 });
    await db.pendingOps.clear();
    await seedQueuedOp('op-9', 'Home');
    await loop.runSync('manual');

    expect(reconciler.run).toEqual([bindingId, bindingId]);
    expect(transport.calls.map((c) => c.bindingId)).toEqual([bindingId]);
  });

  it('keeps going when one binding’s reconciliation crashes', async () => {
    await seedBinding(bindingId, { state: 'pending_initial' });
    await seedBinding(otherBinding, { state: 'pending_initial' });
    reconciler.failsFor = bindingId;

    await expect(loop.runSync('alarm')).resolves.toBeUndefined();

    expect(reconciler.run).toEqual([bindingId, otherBinding]);
    expect(await messages('background')).toContain('本轮对账失败');
  });

  it('attempts recovery for a stuck binding without failing the round', async () => {
    await seedBinding(bindingId, {
      state: 'needs_recovery',
      recovery: { code: 'EPOCH_MISMATCH', message: 'epoch changed' },
    });
    // A second, healthy binding shares the trigger: one stuck binding must not
    // cost the other its round.
    await seedBinding(otherBinding);
    await db.pendingOps.add({
      opId: 'op-9',
      bindingId: otherBinding,
      clientSeq: 1,
      baseRevision: 1,
      status: 'QUEUED',
      type: 'create',
      nodeId: '',
      nodeType: 'bookmark',
      title: 'Home',
      url: 'https://home.example.com',
      parent: { type: 'root', key: 'main' },
      createdAt: Date.now(),
    } as never);

    await loop.runSync('alarm');

    // The device cannot resync against a space it can no longer see, so the
    // stuck binding stays where it is — but it was attempted, and the healthy
    // binding still got its round.
    expect((await db.bindings.get(bindingId))?.state).toBe('needs_recovery');
    expect(resyncDriver.calls).toEqual([bindingId]);
    expect(transport.calls.map((c) => c.bindingId)).toEqual([otherBinding]);
    expect(await messages('background')).not.toContain('恢复尝试失败');
  });

  it('resumes a recovery the trigger ordering would otherwise strand', async () => {
    // The mapping recovery was running when the worker was replaced, and the
    // binding was moved on by the event pipeline. No entry point of this
    // sequence reaches that session any more: the round gate wants an active
    // binding, the recovery entry wants needs_recovery with no session, and a
    // second recovery on the same binding is refused by the server. Left alone,
    // the binding keeps the empty mapping forever.
    await seedBinding(bindingId, { state: 'needs_recovery', appliedRevision: 0, receivedRevision: 0 });
    await db.reconSessions.put({
      id: 'orphan-session',
      bindingId,
      type: 'MAPPING_LOST',
      state: 'RUNNING',
      phase: 'apply',
      driver: 'server',
      journalFloor: 0,
      serverRevision: 0,
      progress: emptyReconProgress(),
      createdAt: 1,
      updatedAt: 1,
    });

    await loop.runSync('wake');

    expect(reconciler.resumed).toEqual([bindingId]);
    // The healthy binding still got its round, so this pass costs nothing.
    expect(transport.calls).toEqual([]);
  });

  it('retries a round that lost the run lock instead of waiting for the alarm', async () => {
    await seedBinding();
    await seedQueuedOp('op-1', 'Waiting');
    // Another holder is inside this binding's round: the single-flight rule says
    // this trigger stands down.
    expect(await acquireRunLock(db, bindingId, 'other-holder')).toBe('other-holder');

    const scheduled = vi.spyOn(loop, 'scheduleSync').mockImplementation(() => undefined);
    await loop.runSync('manual');

    expect(transport.calls).toEqual([]);
    // Standing down is only honest if the work comes back: without this the
    // change already sitting on the server waits for the 5-minute alarm.
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(scheduled.mock.calls[0]![0]).toBeGreaterThan(0);
  });

  it('does no network work for a switched-off binding, and still journals what it edits', async () => {
    await seedBinding(bindingId, {
      state: 'needs_recovery',
      recovery: { code: 'EPOCH_MISMATCH', message: 'epoch changed' },
      enabled: false,
    });
    await seedQueuedOp('op-1', 'Queued before off');

    await loop.runSync('alarm');
    await loop.runIntegrity('daily');

    // Off means off across every step that talks to the server: no incremental
    // round, no recovery attempt, no reconciliation, no drift repair.
    expect(transport.calls).toEqual([]);
    expect(reconciler.run).toEqual([]);
    expect(reconciler.recovered).toEqual([]);
    expect((await db.pendingOps.get('op-1'))?.status).toBe('QUEUED');

    // Capture is deliberately not part of the switch: the journal keeps
    // describing the browser, so switching back on drains what accumulated the
    // same way an offline device does when it reconnects.
    await db.bindings.update(bindingId, { state: 'active', appliedRevision: 1, receivedRevision: 1 });
    await loop.dispatch(created('b-9', 'Made while off'));
    const queued = await db.pendingOps.filter((o) => o.status === 'QUEUED').toArray();
    expect(queued.map((o) => o.title).sort()).toEqual(['Made while off', 'Queued before off']);
  });
});

describe('event capture feeding the loop', () => {
  it('captures a burst in order and spends it in one round', async () => {
    await seedBinding();

    await Promise.all([loop.dispatch(created('b1', 'First')), loop.dispatch(created('b2', 'Second'))]);
    await loop.eventsSettled;

    const queued = await db.pendingOps.where('bindingId').equals(bindingId).toArray();
    expect(queued.map((o) => o.title)).toEqual(['First', 'Second']);
    expect(queued.map((o) => o.clientSeq)).toEqual([1, 2]);

    // One trigger drains both edits; nothing was replayed per event.
    await loop.runSync('debounce');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.ops).toBe(2);
  });

  it('keeps capturing intent through a recovery and spends nothing on the network', async () => {
    // A recovery pauses what the device sends, not what a person does. The op
    // this records waits for the new baseline like any other intent (doc 05 §13).
    await seedBinding(bindingId, { state: 'resyncing' });
    const scheduled = vi.spyOn(loop, 'scheduleSync').mockImplementation(() => undefined);

    await loop.dispatch(created('b-7', 'Made during resync'));

    expect((await db.pendingOps.toArray()).map((o) => o.title)).toEqual(['Made during resync']);
    expect(transport.calls).toEqual([]);
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it('schedules one debounced round after a captured edit', async () => {
    await seedBinding();
    // Spied rather than waited: the point is that a captured edit arms the
    // debounce, not how long the debounce is.
    const scheduled = vi.spyOn(loop, 'scheduleSync').mockImplementation(() => undefined);

    await loop.dispatch(created('b1', 'First'));

    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of schedules into one trigger', async () => {
    const run = vi.spyOn(loop, 'runSync').mockResolvedValue(undefined);

    loop.scheduleSync(5);
    loop.scheduleSync(5);
    loop.scheduleSync(5);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('debounce', { rerunOnJoin: true });
  });
});

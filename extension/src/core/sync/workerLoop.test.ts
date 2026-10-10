// Trigger orchestration (doc 05 §14/§15). PR-B1's requirement is that an
// alarm, a manual click, a worker wake and a recovery attempt cannot all
// replay the same inbox — and that guarantee is assembled here, not inside any
// single collaborator, so it is the part this file tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PontisDB, type BindingRecord, type PendingOpRecord } from './../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import type { BrowserNode } from '../browser/types';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { ReplicaVerifier } from './verifyReplica';
import { ResyncService } from './resync';
import { SyncCoordinator } from './syncCoordinator';
import { WorkerLoop, type ReconcileDriver } from './workerLoop';
import { FakeServerTransport } from '../../testing/fakeServer';
import { BootstrapStore } from '../store/bootstrap';
import type { ApiClient, SyncTransport } from '../transport/client';
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

const bindingId = 'binding-1';
const otherBinding = 'binding-2';

/** Counts rounds and holds the connection open long enough to overlap. */
class SpyTransport implements SyncTransport {
  calls: { bindingId: string; ops: number; applied: number }[] = [];
  constructor(private inner: FakeServerTransport, private delayMs = 0) {}

  async sync(bindingId: string, req: SyncRequestWire): Promise<SyncResponseWire> {
    this.calls.push({ bindingId, ops: req.operations.length, applied: req.applied_revision });
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.sync(bindingId, req);
  }
}

/** Records what the loop asked the reconciler to do. */
class StubReconciler implements ReconcileDriver {
  run: string[] = [];
  recovered: string[] = [];
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
  const client = { deviceSpaces: async () => ({ spaces: [] }) } as unknown as ApiClient;
  resync = new ResyncService(db, client, kv, coordinator, verifier);
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
    await Promise.all([slowLoop.runSync('alarm'), slowLoop.runSync('manual'), slowLoop.runSync('wake')]);
    transport = slow;

    expect(slow.calls).toHaveLength(1);
    expect(slow.calls[0]?.ops).toBe(1);
    transport = slow;
    // The others did not quietly do nothing: they said why.
    expect(await messages('coordinator')).toContain('another round holds this binding, skipping');
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
    expect(await messages('background')).toContain('initial reconciliation round failed');
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
    const sessions = await db.reconSessions.where('bindingId').equals(bindingId).toArray();
    expect(sessions.some((x) => x.type === 'FULL_RESYNC' && x.state === 'FAILED')).toBe(true);
    expect(transport.calls.map((c) => c.bindingId)).toEqual([otherBinding]);
    expect(await messages('background')).not.toContain('recovery attempt failed');
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
    expect(run).toHaveBeenCalledWith('debounce');
  });
});

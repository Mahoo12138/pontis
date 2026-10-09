// SyncCoordinator tests: watermark advancement, inbox persistence before
// received_revision, serial apply, settle cleanup, protocol error handling.

import { beforeEach, describe, expect, it } from 'vitest';
import { acquireRunLock, PontisDB, releaseAllRunLocks, RUN_LOCK_STALE_MS, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { SyncCoordinator, type SyncOutcome } from './syncCoordinator';
import { ApiError, type SyncTransport } from '../transport/client';
import type { ChangeWire, SyncRequestWire, SyncResponseWire } from '../protocol/types';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let applier: RemoteChangeApplier;

const bindingId = 'binding-1';

async function seedBinding(): Promise<BindingRecord> {
  const binding: BindingRecord = {
    id: bindingId,
    spaceId: 'space-1',
    spaceName: 'Personal',
    mode: 'partial',
    state: 'active',
    epoch: 1,
    appliedRevision: 100,
    receivedRevision: 100,
    clientSeq: 0,
    mount: { mode: 'partial', folderBrowserId: 'f1', rootKey: 'main' },
    lastSyncAt: null,
    recovery: null,
    createdAt: Date.now(),
  };
  await db.bindings.put(binding);
  return binding;
}

beforeEach(() => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  applier = new RemoteChangeApplier(db, adapter);
});

function response(overrides: Partial<SyncResponseWire>): SyncResponseWire {
  return {
    protocol_version: 1,
    epoch: 1,
    journal_floor_revision: 0,
    from_revision: 101,
    through_revision: 100,
    server_revision: 110,
    has_more: false,
    operation_results: [],
    changes: [],
    ...overrides,
  };
}

const createAt = (revision: number, nodeId: string): ChangeWire => ({
  revision,
  type: 'create',
  node_id: nodeId,
  payload: {
    type: 'bookmark',
    title: `Node ${nodeId}`,
    url: `https://${nodeId}.example.com`,
    parent: { type: 'root', key: 'main' },
    position: revision - 101,
  },
});

describe('SyncCoordinator', () => {
  it('pushes queued ops, persists inbox, applies serially and settles pending', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    await seedBinding();
    // Local user op waiting in the outbox.
    await db.pendingOps.add({
      opId: 'op-1',
      bindingId,
      clientSeq: 1,
      baseRevision: 100,
      status: 'QUEUED',
      type: 'create',
      nodeId: '',
      nodeType: 'bookmark',
      title: 'Local Bookmark',
      url: 'https://local.example.com',
      parent: { type: 'root', key: 'main' },
      beforeId: null,
      browserId: 'b1',
      createdAt: Date.now(),
    });

    const requests: SyncRequestWire[] = [];
    const transport: SyncTransport = {
      sync: async (_bindingId, req) => {
        requests.push(req);
        return response({
          through_revision: 101,
          operation_results: [
            {
              op_id: 'op-1',
              client_seq: 1,
              status: 'APPLIED',
              reason: '',
              result_revision: 101,
              settle_after_revision: 101,
            },
          ],
          changes: [createAt(101, 'op-1-node')],
        });
      },
    };
    const coordinator = new SyncCoordinator(db, applier, transport);
    const outcome: SyncOutcome = await coordinator.syncBinding(bindingId);

    expect(outcome).toBe('synced');
    // The request carried the queued operation with correct watermarks.
    expect(requests[0]!.applied_revision).toBe(100);
    expect(requests[0]!.received_revision).toBe(100);
    expect(requests[0]!.operations[0]).toMatchObject({ op_id: 'op-1', type: 'create' });

    // Watermarks advanced; inbox applied.
    const binding = await db.bindings.get(bindingId);
    expect(binding?.receivedRevision).toBe(101);
    expect(binding?.appliedRevision).toBe(101);
    expect(await db.remoteChanges.get(`${bindingId}:101`)).toMatchObject({ type: 'create' });

    // Own create回流 mapped the browser node (b1 seeded? no: remote apply created its own).
    // The回流 create added a mapped browser node.
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.some((m) => m.canonicalId === 'op-1-node')).toBe(true);

    // settle_after_revision satisfied → pending op deleted.
    expect(await db.pendingOps.count()).toBe(0);
    expect(binding?.lastSyncAt).not.toBeNull();
  });

  it('keeps resolved pending ops until settle_after_revision is applied', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    await seedBinding();
    await db.pendingOps.add({
      opId: 'op-2',
      bindingId,
      clientSeq: 1,
      baseRevision: 100,
      status: 'QUEUED',
      type: 'delete',
      nodeId: 'n-old',
      createdAt: Date.now(),
    });

    const transport: SyncTransport = {
      sync: async () =>
        response({
          operation_results: [
            { op_id: 'op-2', client_seq: 1, status: 'REBASED', reason: 'anchor_moved', result_revision: 0, settle_after_revision: 105 },
          ],
        }),
    };
    const coordinator = new SyncCoordinator(db, applier, transport);
    await coordinator.syncBinding(bindingId);

    // settle=105 > applied=100 → must NOT be deleted yet.
    const pending = await db.pendingOps.get('op-2');
    expect(pending?.status).toBe('RESOLVED');
    expect(pending?.result?.status).toBe('REBASED');
  });

  it('marks the binding needs_recovery on a protocol error', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    await seedBinding();
    const transport: SyncTransport = {
      sync: async () => {
        throw new ApiError(409, 'EPOCH_MISMATCH', 'canonical epoch changed');
      },
    };
    const coordinator = new SyncCoordinator(db, applier, transport);
    const outcome = await coordinator.syncBinding(bindingId);

    expect(outcome).toBe('needs-recovery');
    const binding = await db.bindings.get(bindingId);
    expect(binding?.state).toBe('needs_recovery');
    expect(binding?.recovery).toMatchObject({ code: 'EPOCH_MISMATCH' });
  });

  it('skips inactive bindings and reports error for transient failures', async () => {
    const transport: SyncTransport = {
      sync: async () => {
        throw new ApiError(0, 'NETWORK_ERROR', 'offline');
      },
    };
    const coordinator = new SyncCoordinator(db, applier, transport);
    expect(await coordinator.syncBinding('missing')).toBe('inactive');

    await seedBinding();
    expect(await coordinator.syncBinding(bindingId)).toBe('error');
    // Network failure must not flip the binding into recovery.
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
  });

  // The inbox is persisted before applying, so a change that cannot be
  // applied must leave both the watermark and the binding state honest.
  it('parks a binding that targets a lost mapping instead of acknowledging it', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    await seedBinding();
    const transport: SyncTransport = {
      sync: async () =>
        response({
          through_revision: 101,
          changes: [
            {
              revision: 101,
              type: 'create',
              node_id: 'n-orphan',
              payload: {
                type: 'bookmark',
                title: 'Orphan',
                url: 'https://orphan.test',
                parent: { type: 'node', id: 'n-never-mapped' },
                position: 0,
              },
            },
          ],
        }),
    };
    const coordinator = new SyncCoordinator(db, applier, transport);
    expect(await coordinator.syncBinding(bindingId)).toBe('needs-recovery');

    const binding = await db.bindings.get(bindingId);
    expect(binding?.state).toBe('needs_recovery');
    expect(binding?.recovery).toMatchObject({ code: 'UNMAPPED_PROJECTION' });
    // received advanced (the stream was read) but applied did not (the state
    // was not reached), so the change is still queued for the repair path.
    expect(binding?.appliedRevision).toBe(100);
    expect(await db.remoteChanges.get(`${bindingId}:101`)).toBeDefined();
    expect(adapter.calls).toEqual([]);
  });

  it('will not run two rounds on one binding at the same time', async () => {
    await seedBinding();
    let reached = false;
    const probe: SyncTransport = {
      sync: () => {
        reached = true;
        return Promise.reject(new Error('must not be called'));
      },
    };
    const guarded = new SyncCoordinator(db, new RemoteChangeApplier(db, adapter), probe);
    expect(await acquireRunLock(db, bindingId, 'someone-else')).toBe('someone-else');

    expect(await guarded.syncBinding(bindingId)).toBe('inactive');
    expect(reached).toBe(false);
    // Skipped, not failed: the round that holds the binding is the one that
    // advances it, and the log says so.
    const skipped = await db.diagnostics.toArray();
    expect(skipped.map((e) => [e.level, e.message])).toEqual([
      ['info', 'another round holds this binding, skipping'],
    ]);

    // A holder that died stops blocking: the next trigger takes the lock over
    // instead of parking the binding forever.
    await db.runLocks.put({ bindingId, token: 'dead', takenAt: Date.now() - RUN_LOCK_STALE_MS - 1 });
    await guarded.syncBinding(bindingId).catch(() => undefined);
    expect(reached).toBe(true);
  });

  it('forgets locks abandoned by a killed worker', async () => {
    await seedBinding();
    expect(await acquireRunLock(db, bindingId, 'killed-worker')).toBe('killed-worker');

    expect(await releaseAllRunLocks(db)).toBe(1);

    // The next trigger is not stuck behind the dead holder's stale window.
    await expect(acquireRunLock(db, bindingId, 'fresh-worker')).resolves.toBe('fresh-worker');
  });
});

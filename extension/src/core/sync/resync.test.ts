// Recovery Intent Review tests (doc 06 §9-§11): needs_recovery with
// unsynced intent parks at waiting_user; resolveIntents executes the
// per-op decisions — kept intents become brand-new ops (doc 06 §10),
// discarded ones let the server state win — and the normal resync path
// converges the binding back to active.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, type BindingRecord, type PendingOpRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { SyncCoordinator } from './syncCoordinator';
import { InitialSyncEngine } from './initialSync';
import { ResyncService } from './resync';
import { FakeServerTransport } from '../../testing/fakeServer';
import type { ApiClient } from '../transport/client';
import { BootstrapStore } from '../store/bootstrap';
import type { ParentRefWire } from '../protocol/types';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let server: FakeServerTransport;
let coordinator: SyncCoordinator;
let engine: InitialSyncEngine;

const bindingId = 'binding-1';
const ROOT: ParentRefWire = { type: 'root', key: 'main' };

async function seedBinding(over: Partial<BindingRecord> = {}): Promise<BindingRecord> {
  const binding: BindingRecord = {
    id: bindingId,
    spaceId: 'space-1',
    spaceName: 'Personal',
    mode: 'partial',
    state: 'active',
    epoch: 1,
    appliedRevision: 1,
    receivedRevision: 1,
    clientSeq: 1,
    mount: { mode: 'partial', folderBrowserId: 'f1', rootKey: 'main' },
    lastSyncAt: null,
    recovery: null,
    createdAt: Date.now(),
    ...over,
  };
  await db.bindings.put(binding);
  return binding;
}

const seedServerNode = (id: string, title: string, url: string, parent: ParentRefWire = ROOT) =>
  server.seed({ type: 'create', node_id: id, payload: { type: url ? 'bookmark' : 'folder', title, url, parent, position: server.journal.length } });

const seedIntent = async (over: Partial<PendingOpRecord> = {}): Promise<PendingOpRecord> => {
  const op: PendingOpRecord = {
    opId: 'op-intent',
    bindingId,
    clientSeq: 1,
    baseRevision: 1,
    status: 'QUEUED',
    type: 'create',
    nodeId: '',
    nodeType: 'bookmark',
    title: 'Intent',
    url: 'https://intent.example.com',
    parent: ROOT,
    beforeId: null,
    createdAt: Date.now(),
    ...over,
  };
  await db.pendingOps.add(op);
  return op;
};

const memoryKV = (): BootstrapStore => {
  let data: Record<string, unknown> = { bootstrap: { serverUrl: 'http://x', deviceToken: 'tok' } };
  return new BootstrapStore({
    get: async (k: string) => data[k],
    set: async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    },
    remove: async (keys: string[]) => {
      for (const k of keys) delete data[k];
    },
  });
};

const deviceSpaces = (epoch: number, floor = 0): ApiClient =>
  ({
    deviceSpaces: async () => ({
      spaces: [{ id: 'space-1', name: 'Personal', epoch, revision: server.revision, journal_floor_revision: floor, created_at: '' }],
    }),
  }) as unknown as ApiClient;

/** Park the binding at the intent review state (doc 06 §11). */
const parkAtReview = async (epoch = 2): Promise<ResyncService> => {
  await seedBinding({
    state: 'needs_recovery',
    recovery: { code: 'EPOCH_MISMATCH', message: 'epoch changed' },
  });
  server.epoch = epoch;
  const resync = new ResyncService(db, deviceSpaces(epoch), memoryKV(), coordinator, engine);
  expect(await resync.attemptRecovery(bindingId)).toBe('waiting');
  expect((await db.bindings.get(bindingId))?.state).toBe('waiting_user');
  return resync;
};

beforeEach(() => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  server = new FakeServerTransport();
  const applier = new RemoteChangeApplier(db, adapter);
  coordinator = new SyncCoordinator(db, applier, server);
  engine = new InitialSyncEngine(db, adapter, server, coordinator);
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
  seedServerNode('n1', 'Docs', ''); // revision 1
});

describe('recovery intent review (doc 06 §10/§11)', () => {
  it('creates a brand-new op for a kept intent (fresh op_id / client_seq / base_revision)', async () => {
    const op = await seedIntent();
    const resync = await parkAtReview();

    // Space lookup fails so the flow stops right after the re-anchor.
    const blocked = new ResyncService(
      db,
      { deviceSpaces: async () => ({ spaces: [] }) } as unknown as ApiClient,
      memoryKV(),
      coordinator,
      engine,
    );
    await blocked.resolveIntents(bindingId, [{ opId: op.opId, decision: 'apply' }]);

    const ops = await db.pendingOps.toArray();
    expect(ops).toHaveLength(1);
    const fresh = ops[0]!;
    expect(fresh.opId).not.toBe(op.opId);
    expect(fresh.clientSeq).toBe(2); // allocated after the old op's seq
    expect(fresh.title).toBe('Intent');
    expect(fresh.status).toBe('QUEUED');
    expect((await db.bindings.get(bindingId))?.state).toBe('needs_recovery');
    const sessions = await db.reconSessions.toArray();
    expect(sessions.some((s) => s.intentReviewed)).toBe(true);
  });

  it('rejects resolveIntents outside the intent review state', async () => {
    await seedBinding();
    const resync = new ResyncService(db, deviceSpaces(1), memoryKV(), coordinator, engine);
    await expect(resync.resolveIntents(bindingId, [])).rejects.toThrow();
  });

  it('replays a kept CREATE against the new baseline and converges to active', async () => {
    const op = await seedIntent();
    const resync = await parkAtReview();

    const outcome = await resync.resolveIntents(bindingId, [{ opId: op.opId, decision: 'apply' }]);

    expect(outcome).toBe('resynced');
    const binding = await db.bindings.get(bindingId);
    expect(binding?.state).toBe('active');
    expect(binding?.epoch).toBe(2);
    // The intent was uploaded once (re-anchor replays revision 1 only).
    expect(
      server.journal.some((c) => c.type === 'create' && (c.payload as { title?: string }).title === 'Intent'),
    ).toBe(true);
    // The created node is mapped in the browser.
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.some((m) => m.canonicalId === 'srv-2')).toBe(true);
    expect((await db.reconSessions.toArray()).every((s) => s.state === 'COMPLETED')).toBe(true);
    // The emergency snapshot is cleaned up after success (doc 06 §9).
    expect(await db.emergencySnapshots.count()).toBe(0);
  });

  it('discarded DELETE lets the server win (no delete op uploaded)', async () => {
    await seedBinding({
      state: 'needs_recovery',
      recovery: { code: 'EPOCH_MISMATCH', message: 'epoch changed' },
    });
    server.epoch = 2;
    // The browser replica mirrors n1.
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'Docs' });
    await db.localNodes.put({
      bindingId,
      browserId: 'b1',
      canonicalId: 'n1',
      type: 'folder',
      title: 'Docs',
      url: null,
      parentBrowserId: 'f1',
      position: 0,
    });
    const op = await seedIntent({ type: 'delete', nodeId: 'n1', title: undefined, url: undefined });
    const resync = new ResyncService(db, deviceSpaces(2), memoryKV(), coordinator, engine);
    expect(await resync.attemptRecovery(bindingId)).toBe('waiting');

    const outcome = await resync.resolveIntents(bindingId, [{ opId: op.opId, decision: 'discard' }]);

    expect(outcome).toBe('resynced');
    // Server wins: n1 survived, no delete ever reached the journal.
    expect(server.journal.some((c) => c.type === 'delete' && c.node_id === 'n1')).toBe(false);
    expect(await adapter.getChildren('f1')).toHaveLength(1);
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
  });

  it('discarding every intent goes straight to resync without uploads', async () => {
    const op = await seedIntent();
    const resync = await parkAtReview();

    const outcome = await resync.resolveIntents(bindingId, [{ opId: op.opId, decision: 'discard' }]);

    expect(outcome).toBe('resynced');
    // Journal unchanged: only the seeded revision-1 create exists.
    expect(server.journal).toHaveLength(1);
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
    expect(await db.emergencySnapshots.count()).toBe(0);
  });
});

// Initial sync / resync / remount engine tests (doc 06): four-case
// classification, four decisions, strict matcher behaviour inside the
// pipeline, create adoption (no duplicates), verify repair, crash-resume,
// full resync, and journal-floor blocking.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { SyncCoordinator } from './syncCoordinator';
import { InitialSyncEngine, isQuiescent } from './initialSync';
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
    appliedRevision: 0,
    receivedRevision: 0,
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

beforeEach(() => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  server = new FakeServerTransport();
  const applier = new RemoteChangeApplier(db, adapter);
  coordinator = new SyncCoordinator(db, applier, server);
  engine = new InitialSyncEngine(db, adapter, server, coordinator);
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
});

const seedServerNode = (id: string, title: string, url: string, parent: ParentRefWire = ROOT) =>
  server.seed({ type: 'create', node_id: id, payload: { type: url ? 'bookmark' : 'folder', title, url, parent, position: server.journal.length } });

describe('initial sync: four-case classification', () => {
  it('server empty + browser non-empty → uploads the browser tree', async () => {
    await seedBinding();
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'A', url: 'https://a.example.com' });
    adapter.seed({ id: 'b2', parentId: 'f1', title: 'B', url: 'https://b.example.com' });

    const session = await engine.start(bindingId);

    expect(session.state).toBe('COMPLETED');
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
    // Journal gained exactly the two uploads.
    expect(server.journal).toHaveLength(2);
    // Adoption: no browser duplicates appeared.
    expect(await adapter.getChildren('f1')).toHaveLength(2);
    // Both nodes mapped to their server-created canonical ids.
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.filter((m) => m.canonicalId)).toHaveLength(2);
    expect(await isQuiescent(db, bindingId)).toBe(true);
  });

  it('server non-empty + browser empty → applies the canonical tree', async () => {
    await seedBinding();
    seedServerNode('n1', 'Docs', '');
    seedServerNode('n2', 'Home', 'https://home.example.com');

    const session = await engine.start(bindingId);

    expect(session.state).toBe('COMPLETED');
    const kids = await adapter.getChildren('f1');
    expect(kids).toHaveLength(2);
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.filter((m) => m.canonicalId === 'n1' || m.canonicalId === 'n2')).toHaveLength(2);
    const binding = await db.bindings.get(bindingId);
    expect(binding?.appliedRevision).toBe(2);
    expect(binding?.receivedRevision).toBe(2);
  });

  it('both empty → empty baseline, immediately active', async () => {
    await seedBinding();
    const session = await engine.start(bindingId);
    expect(session.state).toBe('COMPLETED');
    expect(server.journal).toHaveLength(0);
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
  });
});

describe('initial sync: both non-empty decisions', () => {
  beforeEach(async () => {
    await seedBinding();
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'Same', url: 'https://same.example.com' });
    adapter.seed({ id: 'b-local', parentId: 'f1', title: 'Local only', url: 'https://local.example.com' });
    seedServerNode('n1', 'Whatever', 'https://same.example.com');
    seedServerNode('n2', 'Server only', 'https://server.example.com');
  });

  it('pauses at WAITING_USER with match statistics, then merges without duplicates', async () => {
    const session = await engine.start(bindingId);
    expect(session.state).toBe('WAITING_USER');
    expect(session.progress).toMatchObject({ matched: 1, localOnly: 1, serverOnly: 1 });
    expect((await db.bindings.get(bindingId))?.state).toBe('waiting_user');

    const done = await engine.resume(bindingId, 'merge');
    expect(done.state).toBe('COMPLETED');
    expect((await db.bindings.get(bindingId))?.state).toBe('active');

    // No duplicates beyond the applied server-only node: matched b1,
    // uploaded b-local, and n2 applied in — exactly three children.
    expect(await adapter.getChildren('f1')).toHaveLength(3);
    // Matched pair mapped; local-only node uploaded and adopted.
    const mirrors = await db.localNodes.toArray();
    const byBrowser = new Map(mirrors.map((m) => [m.browserId, m]));
    expect(byBrowser.get('b1')?.canonicalId).toBe('n1');
    expect(byBrowser.get('b-local')?.canonicalId).toBe('srv-3');
    // Server-only node applied into the browser.
    expect(mirrors.some((m) => m.canonicalId === 'n2' && m.browserId !== 'b1')).toBe(true);
  });

  it('use_server removes browser-only subtrees and keeps the mapping', async () => {
    await engine.start(bindingId);
    await engine.resume(bindingId, 'use_server');

    const kids = await adapter.getChildren('f1');
    // b-local removed; b1 kept (its server twin's authoritative title is
    // applied through the normal回流) n2 applied in.
    expect(kids.map((k) => k.title).sort()).toEqual(['Server only', 'Whatever']);
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.some((m) => m.browserId === 'b-local')).toBe(false);
    expect(mirrors.some((m) => m.canonicalId === 'n1')).toBe(true);
  });

  it('use_browser uploads local-only and deletes server-only canonical nodes', async () => {
    await engine.start(bindingId);
    await engine.resume(bindingId, 'use_browser');

    // Browser keeps both of its nodes, no duplicates.
    expect(await adapter.getChildren('f1')).toHaveLength(2);
    // Journal: n1, n2 seeded + create(b-local) + delete(n2).
    expect(server.journal.some((c) => c.type === 'delete' && c.node_id === 'n2')).toBe(true);
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.some((m) => m.browserId === 'b1' && m.canonicalId === 'n1')).toBe(true);
    expect(mirrors.some((m) => m.browserId === 'b-local' && m.canonicalId)).toBe(true);
  });

  it('import copies the whole snapshot under a dated folder without remapping', async () => {
    await engine.start(bindingId);
    const done = await engine.resume(bindingId, 'import');
    expect(done.state).toBe('COMPLETED');

    // Mount folder: original b1, applied n2, plus the Imported folder
    // (the uploaded copy of b1 lives inside it, n1 applied as well).
    const imported = (await adapter.getChildren('f1')).find((k) => k.title.startsWith('Imported'));
    expect(imported).toBeDefined();
    const copied = await adapter.getChildren(imported!.id);
    expect(copied.map((c) => c.url)).toContain('https://same.example.com');
    // The source node was never re-mapped: it keeps its own canonical id.
    const mirrors = await db.localNodes.toArray();
    const byBrowser = new Map(mirrors.map((m) => [m.browserId, m]));
    expect(byBrowser.get('b1')?.canonicalId).toBe('n1');
  });

  it('resumes from a persisted decision with a fresh engine (MV3 crash)', async () => {
    const session = await engine.start(bindingId);
    expect(session.state).toBe('WAITING_USER');
    // The user's decision was persisted, then the worker died; a new
    // instance picks the session (and decision) back up.
    await db.reconSessions.update(session.id, { decision: 'merge' });

    const engine2 = new InitialSyncEngine(db, adapter, server, coordinator);
    const done = await engine2.start(bindingId);
    expect(done.state).toBe('COMPLETED');
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
  });
});

describe('initial sync: upload mechanics', () => {
  it('uploads nested browser-only folders level by level', async () => {
    await seedBinding();
    adapter.seed({ id: 'bf', parentId: 'f1', title: 'Work' });
    adapter.seed({ id: 'bc', parentId: 'bf', title: 'Spec', url: 'https://spec.example.com' });

    const session = await engine.start(bindingId);
    expect(session.state).toBe('COMPLETED');
    expect(server.journal).toHaveLength(2); // folder + child
    expect(await adapter.getChildren('f1')).toHaveLength(1);
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.filter((m) => m.canonicalId)).toHaveLength(2);
  });

  it('never double-uploads nodes already captured by the event pipeline', async () => {
    await seedBinding();
    adapter.seed({ id: 'bx', parentId: 'f1', title: 'Captured', url: 'https://captured.example.com' });
    // Simulate EventProcessor output: mirror + QUEUED create op.
    await db.localNodes.put({
      bindingId,
      browserId: 'bx',
      canonicalId: null,
      type: 'bookmark',
      title: 'Captured',
      url: 'https://captured.example.com',
      parentBrowserId: 'f1',
      position: null,
    });
    await db.pendingOps.add({
      opId: 'op-x',
      bindingId,
      clientSeq: 1,
      baseRevision: 0,
      status: 'QUEUED',
      type: 'create',
      nodeId: '',
      nodeType: 'bookmark',
      title: 'Captured',
      url: 'https://captured.example.com',
      parent: ROOT,
      beforeId: null,
      browserId: 'bx',
      createdAt: Date.now(),
    });

    const session = await engine.start(bindingId);
    expect(session.state).toBe('COMPLETED');
    // Exactly one create reached the server.
    expect(server.journal).toHaveLength(1);
    // The pre-existing op was adopted, not duplicated.
    expect(await adapter.getChildren('f1')).toHaveLength(1);
    const mirror = await db.localNodes.get([bindingId, 'bx']);
    expect(mirror?.canonicalId).toBe('srv-1');
  });

  it('verifies and repairs nodes added during reconciliation', async () => {
    await seedBinding();
    seedServerNode('n1', 'Home', 'https://home.example.com');
    const session = await engine.start(bindingId);
    expect(session.state).toBe('COMPLETED');

    // A user add that event capture missed (deferred local change).
    adapter.seed({ id: 'b-late', parentId: 'f1', title: 'Late', url: 'https://late.example.com' });

    const report = await engine.verifyAndRepair(bindingId);
    expect(report.ok).toBe(true);
    const mirror = await db.localNodes.get([bindingId, 'b-late']);
    expect(mirror?.canonicalId).toBe('srv-2');
    expect(await adapter.getChildren('f1')).toHaveLength(2);
  });
});

describe('full resync (doc 06 §7)', () => {
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

  it('re-anchors epoch + watermarks and replays without duplicates', async () => {
    await seedBinding();
    seedServerNode('n1', 'Docs', '');
    await engine.start(bindingId);
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(1);

    // Epoch bump behind our back + a new canonical node.
    server.epoch = 2;
    seedServerNode('n3', 'New', 'https://new.example.com');
    await db.bindings.update(bindingId, {
      state: 'needs_recovery',
      recovery: { code: 'EPOCH_MISMATCH', message: 'epoch changed' },
    });

    const client = {
      deviceSpaces: async () => ({
        spaces: [{ id: 'space-1', name: 'Personal', epoch: 2, revision: server.revision, journal_floor_revision: 0, created_at: '' }],
      }),
    } as unknown as ApiClient;
    const resync = new ResyncService(db, client, memoryKV(), coordinator, engine);
    const outcome = await resync.attemptRecovery(bindingId);

    expect(outcome).toBe('resynced');
    const binding = await db.bindings.get(bindingId);
    expect(binding?.state).toBe('active');
    expect(binding?.epoch).toBe(2);
    expect(binding?.appliedRevision).toBe(2);
    // Mapping survived; ensure-state replay created no duplicates.
    expect(await adapter.getChildren('f1')).toHaveLength(2);
    expect(await db.emergencySnapshots.count()).toBe(1);
  });

  it('protects unsynced intent instead of resyncing (doc 06 §10/§11)', async () => {
    await seedBinding({ state: 'needs_recovery', recovery: { code: 'EPOCH_MISMATCH', message: 'x' } });
    await db.pendingOps.add({
      opId: 'op-1',
      bindingId,
      clientSeq: 1,
      baseRevision: 5,
      status: 'QUEUED',
      type: 'create',
      nodeId: '',
      title: 'Intent',
      parent: ROOT,
      createdAt: Date.now(),
    });

    const client = {
      deviceSpaces: async () => ({ spaces: [] }),
    } as unknown as ApiClient;
    const resync = new ResyncService(
      db,
      client,
      memoryKV(),
      coordinator,
      engine,
    );
    const outcome = await resync.attemptRecovery(bindingId);

    expect(outcome).toBe('waiting');
    expect((await db.bindings.get(bindingId))?.state).toBe('waiting_user');
    expect(await db.pendingOps.get('op-1')).toBeDefined();
    expect(await db.emergencySnapshots.count()).toBe(1);
    const sessions = await db.reconSessions.toArray();
    expect(sessions.some((s) => s.state === 'WAITING_USER' && s.type === 'FULL_RESYNC')).toBe(true);
  });

  it('is a noop for healthy bindings', async () => {
    const client = { deviceSpaces: async () => ({ spaces: [] }) } as unknown as ApiClient;
    const resync = new ResyncService(db, client, memoryKV(), coordinator, engine);
    expect(await resync.attemptRecovery(bindingId)).toBe('noop');
  });
});

describe('mount_missing recovery', () => {
  it('remounts into a new folder and rebuilds the mapping', async () => {
    await seedBinding({ state: 'mount_missing' });
    // Stale replica state bound to the lost folder.
    await db.localNodes.put({
      bindingId,
      browserId: 'b1',
      canonicalId: 'n1',
      type: 'bookmark',
      title: 'Old',
      url: 'https://old.example.com',
      parentBrowserId: 'f1',
      position: 0,
    });
    seedServerNode('n1', 'Docs', '');
    adapter.seed({ id: 'f2', parentId: '0', title: 'New home' });

    const session = await engine.remount(bindingId, 'f2');
    expect(session.state).toBe('COMPLETED');
    const binding = await db.bindings.get(bindingId);
    expect(binding?.state).toBe('active');
    expect(binding?.mount.folderBrowserId).toBe('f2');
    // The stale mirror is gone: nothing left pointing at the lost folder.
    const staleMirrors = (await db.localNodes.toArray()).filter((m) => m.parentBrowserId === 'f1');
    expect(staleMirrors).toHaveLength(0);
    const kids = await adapter.getChildren('f2');
    expect(kids).toHaveLength(1);
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.some((m) => m.canonicalId === 'n1' && m.parentBrowserId === 'f2')).toBe(true);
  });
});

describe('journal floor', () => {
  it('waits for the user when pruned history blocks a full replay', async () => {
    await seedBinding();
    server.floor = 1;
    seedServerNode('n1', 'Docs', ''); // revision 2, revision 1 pruned

    const session = await engine.start(bindingId);
    expect(session.state).toBe('WAITING_USER');
    expect(session.error).toContain('journal history expired');
    expect((await db.bindings.get(bindingId))?.state).toBe('waiting_user');
  });
});

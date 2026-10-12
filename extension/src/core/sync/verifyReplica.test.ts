// Replica verification (doc 06 §14, doc 05 §14): does the browser actually
// hold what this device claims to hold, and can drift that event capture
// missed be repaired through the ordinary outbox?
//
// What used to live beside these tests — a client-side planner that fetched the
// journal, classified four cases and committed its own mappings — is gone; the
// server's reconciliation engine owns that (doc 07/08). The cases that planner
// also exercised (level-by-level upload, no double upload) are kept here because
// the behaviour itself survives inside verifyAndRepair.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { SyncCoordinator } from './syncCoordinator';
import { isQuiescent, ReplicaVerifier } from './verifyReplica';
import { FakeServerTransport } from '../../testing/fakeServer';
import type { ParentRefWire } from '../protocol/types';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let server: FakeServerTransport;
let coordinator: SyncCoordinator;
let verifier: ReplicaVerifier;

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

/** A browser node this device already mirrors under a canonical id. */
async function seedMappedNode(canonicalId: string, browserId: string, title: string, url: string | null): Promise<void> {
  await db.localNodes.put({
    bindingId,
    browserId,
    canonicalId,
    type: url === null ? 'folder' : 'bookmark',
    title,
    url,
    parentBrowserId: 'f1',
    position: 0,
  } as never);
}

beforeEach(() => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  server = new FakeServerTransport();
  const applier = new RemoteChangeApplier(db, adapter);
  coordinator = new SyncCoordinator(db, applier, server);
  verifier = new ReplicaVerifier(db, adapter, coordinator);
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
});

describe('verifyAndRepair uploads what only the browser has', () => {
  it('walks a browser-only subtree one level at a time', async () => {
    await seedBinding();
    adapter.seed({ id: 'bf', parentId: 'f1', title: 'Work' });
    adapter.seed({ id: 'bc', parentId: 'bf', title: 'Spec', url: 'https://spec.example.com' });

    const report = await verifier.verifyAndRepair(bindingId);

    expect(report.ok).toBe(true);
    // A nested folder cannot be created before its parent has a canonical id
    // to name, so this takes two passes and the journal ends up with both.
    expect(server.journal.map((c) => c.type)).toEqual(['create', 'create']);
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.filter((m) => m.canonicalId)).toHaveLength(2);
  });

  it('never double-uploads a node the event pipeline already captured', async () => {
    await seedBinding();
    adapter.seed({ id: 'bx', parentId: 'f1', title: 'Captured', url: 'https://captured.example.com' });
    // Exactly what EventProcessor leaves behind: a provisional mirror and one
    // QUEUED create op.
    await db.localNodes.put({
      bindingId,
      browserId: 'bx',
      canonicalId: null,
      type: 'bookmark',
      title: 'Captured',
      url: 'https://captured.example.com',
      parentBrowserId: 'f1',
      position: null,
    } as never);
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

    await verifier.verifyAndRepair(bindingId);

    // One create reached the server, and the provisional mirror adopted it
    // instead of being replaced by a duplicate bookmark.
    expect(server.journal).toHaveLength(1);
    expect((await db.localNodes.get([bindingId, 'bx']))?.canonicalId).toBe('srv-1');
  });
});

describe('verifyScan is a read-only classification', () => {
  it('names field drift without proposing anything to the server', async () => {
    await seedBinding({ appliedRevision: 1, receivedRevision: 1 });
    await seedMappedNode('n1', 'b1', 'Home', 'https://home.example.com');
    server.seed({
      type: 'create',
      node_id: 'n1',
      payload: { type: 'bookmark', title: 'Home', url: 'https://home.example.com', parent: ROOT, position: 0 },
    });

    // The user renamed in the browser and capture missed it.
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'Renamed', url: 'https://home.example.com' });

    const report = await verifier.verifyScan(bindingId);

    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.kind)).toContain('field_mismatch');
    // Scanning must not itself upload or mutate anything.
    expect(server.journal).toHaveLength(1);
    expect(await db.pendingOps.count()).toBe(0);
  });

  it('reports a mirror whose browser node is gone as an orphan', async () => {
    await seedBinding({ appliedRevision: 1, receivedRevision: 1 });
    await seedMappedNode('n1', 'b-gone', 'Ghost', 'https://ghost.example.com');

    const report = await verifier.verifyScan(bindingId);

    expect(report.problems.map((p) => p.browserId)).toContain('b-gone');
    expect(report.problems.some((p) => p.kind === 'orphan_mirror')).toBe(true);
  });

  it('keeps a policy-managed folder out of the managed scope entirely', async () => {
    await seedBinding({ appliedRevision: 1, receivedRevision: 1 });
    // What an enterprise policy drops inside the bookmark bar. Chrome lists it
    // and refuses every write into it, so a scan that treated it as ours would
    // report missing_mirror forever and the repair would upload a folder this
    // device can never rename, move or delete.
    adapter.seed({
      id: 'managed', parentId: 'f1', title: 'Company bookmarks',
      folderType: 'managed', unmodifiable: true,
    });
    adapter.seed({ id: 'in-managed', parentId: 'managed', title: 'HR', url: 'https://hr.example.com' });

    const report = await verifier.verifyScan(bindingId);

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);

    const repaired = await verifier.verifyAndRepair(bindingId);
    expect(repaired.ok).toBe(true);
    expect(server.journal).toHaveLength(0);
    expect(await db.localNodes.toArray()).toHaveLength(0);
  });

  it('repairs the drift it just reported', async () => {
    await seedBinding({ appliedRevision: 1, receivedRevision: 1 });
    await seedMappedNode('n1', 'b1', 'Home', 'https://home.example.com');
    server.seed({
      type: 'create',
      node_id: 'n1',
      payload: { type: 'bookmark', title: 'Home', url: 'https://home.example.com', parent: ROOT, position: 0 },
    });
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'Renamed', url: 'https://home.example.com' });

    const report = await verifier.verifyAndRepair(bindingId);

    expect(report.ok).toBe(true);
    expect(server.journal.some((c) => c.type === 'update_title' && c.node_id === 'n1')).toBe(true);
    expect((await db.localNodes.get([bindingId, 'b1']))?.title).toBe('Renamed');
  });
});

describe('isQuiescent', () => {
  it('is false while the watermarks or the queues still differ', async () => {
    await seedBinding({ appliedRevision: 3, receivedRevision: 4 });
    expect(await isQuiescent(db, bindingId)).toBe(false);

    await db.bindings.update(bindingId, { receivedRevision: 3 });
    expect(await isQuiescent(db, bindingId)).toBe(true);

    await db.pendingOps.add({
      opId: 'op-1',
      bindingId,
      clientSeq: 1,
      baseRevision: 3,
      status: 'QUEUED',
      type: 'update_title',
      nodeId: 'n1',
      title: 'x',
      parent: ROOT,
      createdAt: Date.now(),
    } as never);
    expect(await isQuiescent(db, bindingId)).toBe(false);
  });

});

describe('verification repairs the drift a missed event hides', () => {
  it('sees a bookmark that moved, and sends the move out', async () => {
    // The shape a missed event leaves behind: the browser holds the node under
    // a different folder, the mirror still names the old one, and title and url
    // agree perfectly — so a scan that reads only those two calls it synced.
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'dev', parentId: 'f1', title: 'Dev' });
    adapter.seed({ id: 'b1', parentId: 'dev', title: 'Go', url: 'https://go.dev' });
    await seedMappedNode('n-root', 'dev', 'Dev', null);
    await seedMappedNode('n-go', 'b1', 'Go', 'https://go.dev');
    await seedBinding();
    server.seed({ type: 'create', node_id: 'n-root', payload: { type: 'folder', title: 'Dev', url: '', parent: ROOT, position: 0 } });
    server.seed({ type: 'create', node_id: 'n-go', payload: { type: 'bookmark', title: 'Go', url: 'https://go.dev', parent: ROOT, position: 1 } });

    const before = await verifier.verifyScan(bindingId);
    expect(before.problems.some((pr) => pr.kind === 'parent_mismatch' && pr.browserId === 'b1')).toBe(true);
    expect(before.ok).toBe(false);

    const report = await verifier.verifyAndRepair(bindingId);
    // Out of the mirror, onto the server, and the two sides agree again.
    expect(server.journal.some((c) => c.type === 'move' && c.node_id === 'n-go')).toBe(true);
    expect(report.ok).toBe(true);
    expect(await db.pendingOps.count()).toBe(0);
  });
});

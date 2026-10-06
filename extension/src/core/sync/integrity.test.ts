// Periodic integrity check tests (doc 05 §14): a healthy replica is a
// no-op; minor drift (≤30% of the managed scope missing mirrors) is
// repaired with targeted ops; major drift hands the binding to
// MAPPING_LOST reconciliation instead of mass-CREATEing.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { SyncCoordinator } from './syncCoordinator';
import { InitialSyncEngine } from './initialSync';
import { integrityCheck } from './integrity';
import { FakeServerTransport } from '../../testing/fakeServer';
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

/** Seed one folder node (n1) plus consistent server/browser/mirror state. */
async function seedMappedNode(id: string, browserId: string, title: string, url: string): Promise<void> {
  server.seed({
    type: 'create',
    node_id: id,
    payload: {
      type: url ? 'bookmark' : 'folder',
      title,
      url,
      parent: url ? { type: 'node', id: 'n1' } : ROOT,
      position: server.journal.length,
    },
  });
  adapter.seed({ id: browserId, parentId: url ? 'b1' : 'f1', title, url: url || undefined });
  await db.localNodes.put({
    bindingId,
    browserId,
    canonicalId: id,
    type: url ? 'bookmark' : 'folder',
    title,
    url: url || null,
    parentBrowserId: url ? 'b1' : 'f1',
    position: server.journal.length,
  });
}

/** Aligned watermarks after seeding, so verifyAndRepair's sync is quiet. */
const alignWatermarks = async (): Promise<void> => {
  await db.bindings.update(bindingId, {
    appliedRevision: server.revision,
    receivedRevision: server.revision,
  });
};

beforeEach(() => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  server = new FakeServerTransport();
  const applier = new RemoteChangeApplier(db, adapter);
  coordinator = new SyncCoordinator(db, applier, server);
  engine = new InitialSyncEngine(db, adapter, server, coordinator);
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
});

describe('periodic integrity (doc 05 §14)', () => {
  it('is a no-op when the replica is healthy', async () => {
    await seedBinding();
    await seedMappedNode('n1', 'b1', 'Docs', '');
    await seedMappedNode('n2', 'b2', 'Go', 'https://go.dev');
    await alignWatermarks();

    expect(await integrityCheck(db, engine, bindingId)).toBe('ok');
    expect(server.journal).toHaveLength(2); // nothing uploaded
  });

  it('repairs field drift with targeted update ops', async () => {
    await seedBinding();
    await seedMappedNode('n1', 'b1', 'Docs', '');
    await seedMappedNode('n2', 'b2', 'Go', 'https://go.dev');
    await alignWatermarks();

    // User rename that event capture missed: browser is ahead of the mirror.
    adapter.seed({ id: 'b2', parentId: 'b1', title: 'Go Lang', url: 'https://go.dev' });

    expect(await integrityCheck(db, engine, bindingId)).toBe('repaired');
    expect(server.journal.some((c) => c.type === 'update_title' && c.node_id === 'n2')).toBe(true);
    expect((await db.localNodes.get([bindingId, 'b2']))?.title).toBe('Go Lang');
  });

  it('repairs a minor missing mirror by uploading the unmapped node', async () => {
    await seedBinding();
    await seedMappedNode('n1', 'b1', 'Docs', '');
    await seedMappedNode('n2', 'b2', 'A', 'https://a.example.com');
    await seedMappedNode('n3', 'b3', 'B', 'https://b.example.com');
    await seedMappedNode('n4', 'b4', 'C', 'https://c.example.com');
    await alignWatermarks();

    // One unmapped browser node: 1/4 = 25% ≤ 30% threshold.
    adapter.seed({ id: 'b-extra', parentId: 'f1', title: 'Extra', url: 'https://extra.example.com' });

    expect(await integrityCheck(db, engine, bindingId)).toBe('repaired');
    const mirror = await db.localNodes.get([bindingId, 'b-extra']);
    expect(mirror?.canonicalId).toBe('srv-5');
    expect(server.journal).toHaveLength(5);
  });

  it('hands major mapping loss to MAPPING_LOST reconciliation instead of mass-CREATEing', async () => {
    await seedBinding();
    await seedMappedNode('n1', 'b1', 'Docs', '');
    await alignWatermarks();

    // Four unmapped browser nodes against one managed mirror: ratio 4.0.
    adapter.seed({ id: 'bx1', parentId: 'f1', title: 'X1', url: 'https://x1.example.com' });
    adapter.seed({ id: 'bx2', parentId: 'f1', title: 'X2', url: 'https://x2.example.com' });
    adapter.seed({ id: 'bx3', parentId: 'f1', title: 'X3', url: 'https://x3.example.com' });
    adapter.seed({ id: 'bx4', parentId: 'f1', title: 'X4', url: 'https://x4.example.com' });

    expect(await integrityCheck(db, engine, bindingId)).toBe('mapping_lost');
    // The reconciliation session is running; nothing was mass-uploaded.
    expect(server.journal).toHaveLength(1);
    const sessions = await db.reconSessions.toArray();
    expect(sessions.some((s) => s.type === 'MAPPING_LOST')).toBe(true);
  });
});

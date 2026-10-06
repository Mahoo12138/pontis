// Cross-space transfer tests (doc 03 §7): transfer op generation on a
// cross-mount drag, coordinator upload + mapping rebuild on ack, and the
// web-initiated path (server journal drives both appliers; no special
// client handling).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PontisDB, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { EventProcessor } from './eventProcessor';
import { SyncCoordinator } from './syncCoordinator';
import { FakeServerTransport } from '../../testing/fakeServer';
import type { TransferRequestWire } from '../protocol/types';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let applier: RemoteChangeApplier;
let processor: EventProcessor;
let fake: FakeServerTransport;
let coordinator: SyncCoordinator;

const b1 = 'binding-1';
const b2 = 'binding-2';

async function seedBinding(id: string, spaceId: string, mountId: string): Promise<BindingRecord> {
  const binding: BindingRecord = {
    id,
    spaceId,
    spaceName: spaceId,
    mode: 'partial',
    state: 'active',
    epoch: 1,
    appliedRevision: 100,
    receivedRevision: 100,
    clientSeq: 0,
    mount: { mode: 'partial', folderBrowserId: mountId, rootKey: 'main' },
    lastSyncAt: null,
    recovery: null,
    createdAt: Date.now(),
  };
  await db.bindings.put(binding);
  return binding;
}

/** Two partial-mount bindings over one browser tree; mirrors for the
 *  "Dev" folder (c1) with a child bookmark "Go" (c2) in binding-1. */
async function seedTwoBindings(): Promise<void> {
  await seedBinding(b1, 'space-1', 'f1');
  await seedBinding(b2, 'space-2', 'f2');
  adapter.seed({ id: 'f1', parentId: '0', title: 'Space1' });
  adapter.seed({ id: 'f2', parentId: '0', title: 'Space2' });
  adapter.seed({ id: 'n', parentId: 'f1', title: 'Dev' });
  adapter.seed({ id: 'b', parentId: 'n', title: 'Go', url: 'https://go.dev' });
  await db.localNodes.bulkPut([
    { bindingId: b1, browserId: 'n', canonicalId: 'c1', type: 'folder', title: 'Dev', url: null, parentBrowserId: 'f1', position: 0 },
    { bindingId: b1, browserId: 'b', canonicalId: 'c2', type: 'bookmark', title: 'Go', url: 'https://go.dev', parentBrowserId: 'n', position: 0 },
  ]);
}

const movedNode = () => ({
  id: 'n',
  parentId: 'f2',
  title: 'Dev',
  url: null,
  type: 'folder' as const,
  index: 0,
});

beforeEach(() => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  applier = new RemoteChangeApplier(db, adapter);
  processor = new EventProcessor(db, adapter);
  fake = new FakeServerTransport();
  coordinator = new SyncCoordinator(db, applier, fake, fake);
});

describe('cross-space transfer', () => {
  it('generates a transfer intent when a node is dragged across mounts', async () => {
    await seedTwoBindings();

    const disposition = await processor.handleEvent(b1, { kind: 'moved', node: movedNode(), oldParentId: 'f1' });

    expect(disposition).toBe('local-op');
    const ops = await db.pendingOps.where('bindingId').equals(b1).toArray();
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.type).toBe('transfer');
    expect(op.status).toBe('QUEUED');
    expect(op.nodeId).toBe('c1');
    expect(op.targetSpaceId).toBe('space-2');
    expect(op.targetParent).toEqual({ type: 'root', key: 'main' });
    expect(op.browserId).toBe('n');
    expect(op.browserParentId).toBe('f2');
  });

  it('uploads the transfer and rebuilds both mappings from the response', async () => {
    await seedTwoBindings();
    await processor.handleEvent(b1, { kind: 'moved', node: movedNode(), oldParentId: 'f1' });
    // The browser completes the drag physically before the coordinator runs.
    await adapter.move('n', 'f2', 0);
    const queued = (await db.pendingOps.where('bindingId').equals(b1).toArray())[0]!;

    const handler = vi.fn(async (req: TransferRequestWire) => {
      expect(req.transfer_id).toBe(queued.opId);
      expect(req.source_space_id).toBe('space-1');
      expect(req.target_space_id).toBe('space-2');
      expect(req.node_id).toBe('c1');
      expect(req.target_parent).toEqual({ type: 'root', key: 'main' });
      return {
        transfer_id: req.transfer_id,
        source_revision: 101,
        target_revision: 100,
        mapping: [
          { source_node_id: 'c1', target_node_id: 'nc1' },
          { source_node_id: 'c2', target_node_id: 'nc2' },
        ],
      };
    });
    fake.transferHandler = handler;

    await coordinator.syncBinding(b1);

    // The intent went through /sync/transfers exactly once and is settled.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await db.pendingOps.get(queued.opId)).toBeUndefined();

    // Source binding: mirrors dropped; the /sync round carried no ops.
    expect(await db.localNodes.get([b1, 'n'])).toBeUndefined();
    expect(await db.localNodes.get([b1, 'b'])).toBeUndefined();

    // Target binding: same browser ids, fresh canonical ids, re-rooted.
    const rootMirror = await db.localNodes.get([b2, 'n']);
    expect(rootMirror).toMatchObject({ canonicalId: 'nc1', parentBrowserId: 'f2', title: 'Dev' });
    const childMirror = await db.localNodes.get([b2, 'b']);
    expect(childMirror).toMatchObject({ canonicalId: 'nc2', parentBrowserId: 'n' });

    // The browser tree still holds the subtree exactly once (no re-create).
    const f2Children = await adapter.getChildren('f2');
    expect(f2Children.filter((c) => c.id === 'n')).toHaveLength(1);
  });

  it('converges a web-initiated transfer through the normal change stream', async () => {
    // Web-initiated: the server moved c1 (with child c2) from space-1 to
    // space-2 atomically; both journals carry the plain create/delete
    // changes and each binding's applier just does its normal job.
    await seedTwoBindings();
    const fake1 = new FakeServerTransport();
    fake1.revision = 100; // align with the binding watermarks
    fake1.seed({ type: 'delete', node_id: 'c1', payload: { count: 2 } });
    const fake2 = new FakeServerTransport();
    fake2.revision = 100;
    fake2.seed({
      type: 'create',
      node_id: 'nc1',
      payload: { type: 'folder', title: 'Dev', url: '', parent: { type: 'root', key: 'main' }, position: 0 },
    });
    fake2.seed({
      type: 'create',
      node_id: 'nc2',
      payload: { type: 'bookmark', title: 'Go', url: 'https://go.dev', parent: { type: 'node', id: 'nc1' }, position: 0 },
    });

    await new SyncCoordinator(db, applier, fake1).syncBinding(b1);
    // Source: browser nodes removed, mirrors dropped, revision advanced.
    expect(await adapter.getNode('n')).toBeNull();
    expect(await adapter.getNode('b')).toBeNull();
    expect(await db.localNodes.get([b1, 'n'])).toBeUndefined();
    expect((await db.bindings.get(b1))!.appliedRevision).toBe(101);

    await new SyncCoordinator(db, applier, fake2).syncBinding(b2);
    // Target: fresh nodes created, exactly once, mirrors established.
    const f2Children = await adapter.getChildren('f2');
    const created = f2Children.filter((c) => c.title === 'Dev');
    expect(created).toHaveLength(1);
    const createdChildren = await adapter.getChildren(created[0]!.id);
    expect(createdChildren.map((c) => c.title)).toEqual(['Go']);
    const m1 = await db.localNodes.where('[bindingId+canonicalId]').equals([b2, 'nc1']).first();
    const m2 = await db.localNodes.where('[bindingId+canonicalId]').equals([b2, 'nc2']).first();
    expect(m1?.browserId).toBe(created[0]!.id);
    expect(m2?.parentBrowserId).toBe(created[0]!.id);
    expect((await db.bindings.get(b2))!.appliedRevision).toBe(102);
  });
});

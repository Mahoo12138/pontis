// EventProcessor tests: local ops write mirror + pending in one
// transaction; expected mutations match without generating local ops.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { EventProcessor } from './eventProcessor';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let processor: EventProcessor;

const bindingId = 'binding-1';

async function seedBinding(mountFolderId: string): Promise<BindingRecord> {
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
    mount: { mode: 'partial', folderBrowserId: mountFolderId, rootKey: 'main' },
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
  processor = new EventProcessor(db, adapter);
});

describe('EventProcessor', () => {
  it('creates mirror + pending op atomically for a local created event', async () => {
    // Mount root f1: mapped sibling b1 at index 0, created node b2 at 1,
    // and a mapped sibling b3 after it → before_id must be b3's canonical id.
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const sibling = adapter.seed({ id: 'b1', parentId: 'f1', title: 'GitHub', url: 'https://github.com' });
    await db.localNodes.put({
      bindingId,
      browserId: 'b1',
      canonicalId: 'n-gh',
      type: 'bookmark',
      title: 'GitHub',
      url: 'https://github.com',
      parentBrowserId: 'f1',
      position: 0,
    });
    const binding = await seedBinding('f1');

    const created = adapter.seed({ id: 'b2', parentId: 'f1', title: 'Go', url: 'https://go.dev' });
    const after = adapter.seed({ id: 'b3', parentId: 'f1', title: 'Docs', url: 'https://docs.example.com' });
    await db.localNodes.put({
      bindingId,
      browserId: 'b3',
      canonicalId: 'n-docs',
      type: 'bookmark',
      title: 'Docs',
      url: 'https://docs.example.com',
      parentBrowserId: 'f1',
      position: 2,
    });
    const disposition = await processor.handleEvent(binding.id, { kind: 'created', node: created });

    expect(disposition).toBe('local-op');
    const mirror = await db.localNodes.get([bindingId, 'b2']);
    expect(mirror).toMatchObject({ canonicalId: null, title: 'Go', parentBrowserId: 'f1' });
    const pending = await db.pendingOps.toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      type: 'create',
      status: 'QUEUED',
      clientSeq: 1,
      baseRevision: 100,
      browserId: 'b2',
      parent: { type: 'root', key: 'main' },
      // before_id → next mapped sibling's canonical id (doc 05 §12)
      beforeId: 'n-docs',
    });
    const updated = await db.bindings.get(bindingId);
    expect(updated?.clientSeq).toBe(1);
    expect(sibling.index).toBe(0);
  });

  it('ignores events outside the managed scope', async () => {
    adapter.seed({ id: 'other', parentId: '0', title: 'Unmanaged' });
    const binding = await seedBinding('f1');
    const node = adapter.seed({ id: 'x1', parentId: 'other', title: 'Local', url: 'https://x' });
    const disposition = await processor.handleEvent(binding.id, { kind: 'created', node });
    expect(disposition).toBe('ignored');
    expect(await db.pendingOps.count()).toBe(0);
  });

  it('resolves a provisional create expectation instead of queuing a local op', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const binding = await seedBinding('f1');
    await db.expectedMutations.add({
      bindingId,
      revision: 101,
      kind: 'create',
      canonicalId: 'n-remote',
      browserId: null,
      parentBrowserId: 'f1',
      position: 0,
      title: 'Docs',
      url: 'https://docs.example.com',
      createdAt: Date.now(),
    });

    const node = adapter.seed({ id: 'b9', parentId: 'f1', title: 'Docs', url: 'https://docs.example.com' });
    const disposition = await processor.handleEvent(binding.id, { kind: 'created', node });

    expect(disposition).toBe('expected');
    expect(await db.pendingOps.count()).toBe(0);
    expect(await db.expectedMutations.count()).toBe(0);
    const mirror = await db.localNodes.get([bindingId, 'b9']);
    expect(mirror).toMatchObject({ canonicalId: 'n-remote', title: 'Docs' });
  });

  it('queues one update op per changed field', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const binding = await seedBinding('f1');
    await db.localNodes.put({
      bindingId,
      browserId: 'b1',
      canonicalId: 'n-1',
      type: 'bookmark',
      title: 'Old Title',
      url: 'https://old.example.com',
      parentBrowserId: 'f1',
      position: 0,
    });
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'Old Title', url: 'https://old.example.com' });

    const node = { id: 'b1', parentId: 'f1', title: 'New Title', url: 'https://new.example.com', type: 'bookmark' as const, index: 0 };
    const disposition = await processor.handleEvent(binding.id, { kind: 'changed', node });

    expect(disposition).toBe('local-op');
    const ops = (await db.pendingOps.toArray()).sort((a, b) => a.clientSeq - b.clientSeq);
    expect(ops.map((o) => o.type)).toEqual(['update_title', 'update_url']);
    expect(ops[0]).toMatchObject({ nodeId: 'n-1', title: 'New Title', baseRevision: 100 });
    const b = await db.bindings.get(bindingId);
    expect(b?.clientSeq).toBe(2);
  });

  it('queues a delete op and removes the mirror subtree', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'folder', parentId: 'f1', title: 'Dev' });
    adapter.seed({ id: 'child', parentId: 'folder', title: 'Go', url: 'https://go.dev' });
    const binding = await seedBinding('f1');
    await db.localNodes.bulkPut([
      { bindingId, browserId: 'folder', canonicalId: 'n-folder', type: 'folder', title: 'Dev', url: null, parentBrowserId: 'f1', position: 0 },
      { bindingId, browserId: 'child', canonicalId: 'n-child', type: 'bookmark', title: 'Go', url: 'https://go.dev', parentBrowserId: 'folder', position: null },
    ]);

    const removed = { id: 'folder', parentId: 'f1', title: 'Dev', url: null, type: 'folder' as const, index: 0 };
    const disposition = await processor.handleEvent(binding.id, { kind: 'removed', node: removed });

    expect(disposition).toBe('local-op');
    const pending = await db.pendingOps.toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ type: 'delete', nodeId: 'n-folder' });
    expect(await db.localNodes.count()).toBe(0);
  });

  it('pauses the binding as mount_missing when the mount root is deleted', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const binding = await seedBinding('f1');
    const removed = { id: 'f1', parentId: '0', title: 'Sync', url: null, type: 'folder' as const, index: 0 };
    const disposition = await processor.handleEvent(binding.id, { kind: 'removed', node: removed });
    expect(disposition).toBe('ignored');
    const updated = await db.bindings.get(bindingId);
    expect(updated?.state).toBe('mount_missing');
  });

  it('still folds an edit into a create that has never left the device', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const binding = await seedBinding('f1');
    await db.bindings.update(binding.id, { clientSeq: 1 });
    adapter.seed({ id: 'b2', parentId: 'f1', title: 'Go', url: 'https://go.dev' });
    await db.localNodes.put({
      bindingId, browserId: 'b2', canonicalId: null, type: 'bookmark',
      title: 'Go', url: 'https://go.dev', parentBrowserId: 'f1', position: null,
    });
    await db.pendingOps.add({
      opId: 'op-create', bindingId, clientSeq: 1, baseRevision: 100, status: 'QUEUED',
      type: 'create', nodeId: 'n-new', nodeType: 'bookmark', title: 'Go',
      url: 'https://go.dev', parent: { type: 'root', key: 'main' }, browserId: 'b2',
      createdAt: Date.now(),
    });

    const node = { id: 'b2', parentId: 'f1', title: 'Go (renamed)', url: 'https://go.dev', type: 'bookmark' as const, index: 0 };
    expect(await processor.handleEvent(binding.id, { kind: 'changed', node })).toBe('local-op');

    const ops = await db.pendingOps.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ opId: 'op-create', title: 'Go (renamed)' });
  });

  it('freezes a create that is already in flight and makes the edit its own op', async () => {
    // The body has been handed to the transport. Rewriting it now means the
    // retry sends a different request under the same op_id, which the server
    // refuses as OP_ID_REUSED — and the edit is lost either way (doc 04).
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const binding = await seedBinding('f1');
    await db.bindings.update(binding.id, { clientSeq: 1 });
    adapter.seed({ id: 'b2', parentId: 'f1', title: 'Go', url: 'https://go.dev' });
    await db.localNodes.put({
      bindingId, browserId: 'b2', canonicalId: null, type: 'bookmark',
      title: 'Go', url: 'https://go.dev', parentBrowserId: 'f1', position: null,
    });
    await db.pendingOps.add({
      opId: 'op-create', bindingId, clientSeq: 1, baseRevision: 100, status: 'IN_FLIGHT',
      type: 'create', nodeId: 'n-new', nodeType: 'bookmark', title: 'Go',
      url: 'https://go.dev', parent: { type: 'root', key: 'main' }, browserId: 'b2',
      createdAt: Date.now(),
    });

    const node = { id: 'b2', parentId: 'f1', title: 'Go (renamed)', url: 'https://go.dev', type: 'bookmark' as const, index: 0 };
    expect(await processor.handleEvent(binding.id, { kind: 'changed', node })).toBe('local-op');

    const create = await db.pendingOps.get('op-create');
    expect(create).toMatchObject({ title: 'Go', status: 'IN_FLIGHT' });
    const followUp = (await db.pendingOps.toArray()).find((o) => o.type === 'update_title');
    // Addressed by the canonical id the create itself named, and sequenced
    // after it, so the server applies the rename to the node it just made.
    expect(followUp).toMatchObject({ nodeId: 'n-new', title: 'Go (renamed)', status: 'QUEUED' });
    expect(followUp!.clientSeq).toBeGreaterThan(create!.clientSeq);
    const mirror = await db.localNodes.get([bindingId, 'b2']);
    expect(mirror?.title).toBe('Go (renamed)');
  });

  it('freezes an in-flight create when the node moves under it', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'folder', parentId: 'f1', title: 'Dev' });
    const binding = await seedBinding('f1');
    await db.bindings.update(binding.id, { clientSeq: 1 });
    adapter.seed({ id: 'b2', parentId: 'folder', title: 'Go', url: 'https://go.dev' });
    await db.localNodes.bulkPut([
      { bindingId, browserId: 'folder', canonicalId: 'n-folder', type: 'folder', title: 'Dev', url: null, parentBrowserId: 'f1', position: 0 },
      { bindingId, browserId: 'b2', canonicalId: null, type: 'bookmark', title: 'Go', url: 'https://go.dev', parentBrowserId: 'f1', position: null },
    ]);
    await db.pendingOps.add({
      opId: 'op-create', bindingId, clientSeq: 1, baseRevision: 100, status: 'IN_FLIGHT',
      type: 'create', nodeId: 'n-new', nodeType: 'bookmark', title: 'Go',
      url: 'https://go.dev', parent: { type: 'root', key: 'main' }, browserId: 'b2',
      createdAt: Date.now(),
    });

    const node = { id: 'b2', parentId: 'folder', title: 'Go', url: 'https://go.dev', type: 'bookmark' as const, index: 0 };
    expect(await processor.handleEvent(binding.id, { kind: 'moved', node, oldParentId: 'f1' })).toBe('local-op');

    expect((await db.pendingOps.get('op-create'))?.parent).toMatchObject({ type: 'root', key: 'main' });
    const move = (await db.pendingOps.toArray()).find((o) => o.type === 'move');
    expect(move).toMatchObject({ nodeId: 'n-new', parent: { type: 'node', id: 'n-folder' } });
  });

  it('queues a delete after an in-flight create instead of un-sending it', async () => {
    // Deleting the queued op would leave the server holding a node this
    // device no longer mentions anywhere, and the create回流 would put the
    // bookmark back in the browser.
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const node = adapter.seed({ id: 'b2', parentId: 'f1', title: 'Go', url: 'https://go.dev' });
    const binding = await seedBinding('f1');
    await db.bindings.update(binding.id, { clientSeq: 1 });
    await db.localNodes.put({
      bindingId, browserId: 'b2', canonicalId: null, type: 'bookmark',
      title: 'Go', url: 'https://go.dev', parentBrowserId: 'f1', position: null,
    });
    await db.pendingOps.add({
      opId: 'op-create', bindingId, clientSeq: 1, baseRevision: 100, status: 'IN_FLIGHT',
      type: 'create', nodeId: 'n-new', nodeType: 'bookmark', title: 'Go',
      url: 'https://go.dev', parent: { type: 'root', key: 'main' }, browserId: 'b2',
      createdAt: Date.now(),
    });

    expect(await processor.handleEvent(binding.id, { kind: 'removed', node })).toBe('local-op');

    expect(await db.pendingOps.get('op-create')).toBeTruthy();
    const deleteOp = (await db.pendingOps.toArray()).find((o) => o.type === 'delete');
    expect(deleteOp).toMatchObject({ nodeId: 'n-new', status: 'QUEUED' });
    expect(await db.localNodes.count()).toBe(0);
  });

  it('captures user intent while a recovery is running', async () => {
    // Sending is what recovery pauses. Dropping the event here loses a move no
    // later scan can see: browser and mirror are both silent about it, so they
    // still agree (doc 05 §13).
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    for (const state of ['resyncing', 'needs_recovery', 'waiting_user'] as const) {
      const binding = await seedBinding('f1');
      await db.bindings.update(binding.id, { state });
      const node = adapter.seed({ id: `b-${state}`, parentId: 'f1', title: 'Made during it', url: 'https://x' });

      expect(await processor.handleEvent(binding.id, { kind: 'created', node })).toBe('local-op');
    }
    expect((await db.pendingOps.toArray()).filter((o) => o.status === 'QUEUED')).toHaveLength(3);
  });
});

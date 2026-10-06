import { describe, expect, it } from 'vitest';

import { FakeSyncServer, createTestReplica } from '../src/testing';
import { ReplicaDB, ReplicaStore } from '../src';

describe('event capture (doc 05 §5, §8-9)', () => {
  it('captures a local create as mirror + queued op in one unit', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });

    const folder = await a.adapter.create(a.rootId, 'folder', 'Development');
    await a.adapter.create(folder.id, 'bookmark', 'GitHub', 'https://github.com');

    const binding = await a.store.getBinding(a.bindingId);
    expect(binding!.maxClientSeq).toBe(2);

    const queued = await a.store.listQueuedOps(a.bindingId);
    expect(queued).toHaveLength(2);

    const create = queued[0]!;
    expect(create.state).toBe('QUEUED');
    expect(create.clientSeq).toBe(1);
    expect(create.baseRevision).toBe(0);
    const op = create.op as Record<string, unknown>;
    expect(op.type).toBe('create');
    expect(op.title).toBe('Development');
    expect(op.parent).toEqual({ type: 'root', key: 'main' });
    expect(op.client_seq).toBe(1);
    expect(String(op.op_id)).toMatch(/^[0-9a-f-]{36}$/);

    // The bookmark anchors on its folder's canonical id.
    const bookmarkOp = queued[1]!.op as Record<string, unknown>;
    expect(bookmarkOp.parent).toEqual({ type: 'node', id: op.node_id });
    expect(bookmarkOp.before_id).toBeUndefined();

    // The mirror holds the mapping already (same capture transaction).
    const mirror = await a.store.getMirrorByBrowser(a.bindingId, folder.id);
    expect(mirror!.canonicalId).toBe(op.node_id);
  });

  it('captures a move with the next mapped sibling as anchor (doc 05 §12)', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });

    const x = await a.adapter.create(a.rootId, 'bookmark', 'X', 'https://x.example');
    const y = await a.adapter.create(a.rootId, 'bookmark', 'Y', 'https://y.example');
    await a.coordinator.drain();

    // Move X before Y: anchor = Y's canonical id (doc 05 §12).
    await a.adapter.move(x.id, a.rootId, 0);

    const queued = await a.store.listQueuedOps(a.bindingId);
    expect(queued).toHaveLength(1);
    const op = queued[0]!.op as Record<string, unknown>;
    expect(op.type).toBe('move');
    const yMirror = await a.store.getMirrorByBrowser(a.bindingId, y.id);
    expect(op.before_id).toBe(yMirror!.canonicalId);
    void x;
  });

  it('captures delete with the whole subtree mapping dropped', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });

    const folder = await a.adapter.create(a.rootId, 'folder', 'Gone');
    await a.adapter.create(folder.id, 'bookmark', 'Inner', 'https://inner.example');
    await a.coordinator.drain();

    await a.adapter.remove(folder.id);

    const queued = await a.store.listQueuedOps(a.bindingId);
    expect(queued).toHaveLength(1);
    expect((queued[0]!.op as Record<string, unknown>).type).toBe('delete');
    expect(await a.store.getMirrorByBrowser(a.bindingId, folder.id)).toBeUndefined();
  });

  it('treats events matching a persisted expectation as remote, not local', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });

    // The applier persists the expectation BEFORE the browser call.
    await a.store.putExpectation({
      bindingId: a.bindingId,
      kind: 'create',
      canonicalId: 'remote-1',
      parentBrowserId: a.rootId,
      type: 'bookmark',
      title: 'Remote',
      url: 'https://remote.example',
    });
    await a.adapter.create(a.rootId, 'bookmark', 'Remote', 'https://remote.example');

    // No operation queued: the event resolved the expectation.
    expect(await a.store.listQueuedOps(a.bindingId)).toHaveLength(0);
    const mirror = await a.store.getMirrorByCanonical(a.bindingId, 'remote-1');
    expect(mirror).toBeDefined();
    expect(mirror!.title).toBe('Remote');
    expect(await a.store.countExpectations(a.bindingId)).toBe(0);
    void server;
  });
});

describe('replica store', () => {
  it('advances received_revision only inside the ingest transaction', async () => {
    const db = new ReplicaDB('store-ingest');
    const store = new ReplicaStore(db);
    await store.ensureBinding({ bindingId: 'b', spaceId: 's', deviceId: 'd', deviceName: 'd' });

    await store.ingestResponse('b', {
      epoch: 1,
      through_revision: 2,
      operation_results: [],
      changes: [
        { revision: 1, type: 'create', node_id: 'n1', payload: { type: 'bookmark', title: 'A', parent: { type: 'root', key: 'main' }, position: 0 } },
        { revision: 2, type: 'create', node_id: 'n2', payload: { type: 'bookmark', title: 'B', parent: { type: 'root', key: 'main' }, position: 1 } },
      ],
    });

    const binding = await store.getBinding('b');
    expect(binding!.receivedRevision).toBe(2);
    expect(await store.unappliedCount('b')).toBe(2);

    // Duplicate delivery is a no-op.
    await store.ingestResponse('b', {
      epoch: 1,
      through_revision: 2,
      operation_results: [],
      changes: [
        { revision: 1, type: 'create', node_id: 'n1', payload: { type: 'bookmark', title: 'A', parent: { type: 'root', key: 'main' }, position: 0 } },
      ],
    });
    expect(await store.unappliedCount('b')).toBe(2);
  });
});

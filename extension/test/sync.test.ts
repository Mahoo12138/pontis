import { describe, expect, it } from 'vitest';

import { assertConverged, createTestReplica, FakeSyncServer, projection } from '../src/testing';

describe('sync coordinator against the fake server (doc 05 §6-11)', () => {
  it('flushes the outbox, applies echoes and remote creates, and converges', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });

    const folder = await a.adapter.create(a.rootId, 'folder', 'Development');
    await a.adapter.create(folder.id, 'bookmark', 'GitHub', 'https://github.com');
    await a.coordinator.drain();

    // Own echoes settled the ops; nothing pending; applied == head.
    expect(await a.store.pendingCount(a.bindingId)).toBe(0);
    const settled = await a.store.settledOps(a.bindingId);
    expect(settled.map((r) => r.result!.status)).toEqual(['APPLIED', 'APPLIED']);

    // A server-side node flows down through the inbox.
    const remote = server.seed({ type: 'root', key: 'main' }, 'bookmark', 'From elsewhere', 'https://elsewhere.example');
    await a.coordinator.drain();

    const got = await projection(a);
    expect(got.order.get('root:main')).toEqual([settled ? (await a.store.getMirrorByBrowser(a.bindingId, folder.id))!.canonicalId : '', remote]);
    await assertConverged(server, [a]);
  });

  it('survives a lost response: receipts settle the retry without new revisions', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });

    await a.adapter.create(a.rootId, 'bookmark', 'One', 'https://one.example');
    await a.adapter.create(a.rootId, 'bookmark', 'Two', 'https://two.example');

    // Server commits, the client never sees the response (doc 21 §7).
    a.transport.armResponseLoss();
    await expect(a.coordinator.syncRound()).rejects.toThrow('response lost');

    // The ops stay queued; the server already consumed the revisions.
    expect(await a.store.listQueuedOps(a.bindingId)).toHaveLength(2);
    expect(server.getHead()).toBe(2);

    // The retry replays receipts and converges without extra revisions.
    await a.coordinator.drain();
    expect(server.getHead()).toBe(2);
    expect(await a.store.pendingCount(a.bindingId)).toBe(0);
    await assertConverged(server, [a]);
  });

  it('is idempotent under duplicate request delivery', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });

    await a.adapter.create(a.rootId, 'bookmark', 'Once', 'https://once.example');
    a.transport.armDuplicate();

    await a.coordinator.drain();
    expect(server.getHead()).toBe(1);
    await assertConverged(server, [a]);
  });

  it('settles a same-field conflict on the canonical winning state', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });
    const b = await createTestReplica(server, { name: 'B' });

    const node = await a.adapter.create(a.rootId, 'bookmark', 'Origin', 'https://x.example');
    await a.coordinator.drain();
    await b.coordinator.drain(); // B pulls the node down

    // Concurrent different-value renames of the same node.
    await a.adapter.update(node.id, { title: 'From A' });
    const bBrowserId = (await b.store.getMirrorByCanonical(b.bindingId, (await a.store.getMirrorByBrowser(a.bindingId, node.id))!.canonicalId))!.browserId;
    await b.adapter.update(bBrowserId, { title: 'From B' });

    await a.coordinator.drain();
    await b.coordinator.drain();

    // Exactly one of them conflicts; both converge on the same state.
    const conflictsA = (await a.store.settledOps(a.bindingId)).filter((r) => r.result?.status === 'CONFLICT');
    const conflictsB = (await b.store.settledOps(b.bindingId)).filter((r) => r.result?.status === 'CONFLICT');
    expect(conflictsA.length + conflictsB.length).toBe(1);
    await assertConverged(server, [a, b]);
  });

  it('keeps offline-created data and recovers a create whose parent was deleted', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });
    const b = await createTestReplica(server, { name: 'B' });

    const folder = await a.adapter.create(a.rootId, 'folder', 'Shell');
    await a.coordinator.drain();
    await b.coordinator.drain();

    // A goes offline: B deletes the folder, A creates inside it.
    a.coordinator.online = false;
    const bFolderId = (await b.store.getMirrorByCanonical(b.bindingId, (await a.store.getMirrorByBrowser(a.bindingId, folder.id))!.canonicalId))!.browserId;
    await b.adapter.remove(bFolderId);
    await b.coordinator.drain();
    await a.adapter.create(folder.id, 'bookmark', 'Precious', 'https://precious.example');

    // Back online: the create must surface, not vanish (doc 21 §8).
    a.coordinator.online = true;
    await a.coordinator.drain();
    await b.coordinator.drain();

    const tree = server.tree();
    const recovered = [...tree.nodes.values()].filter((n) => n.title === 'Precious');
    expect(recovered).toHaveLength(1); // exists in the canonical tree
    await assertConverged(server, [a, b]);
  });

  it('resumes from the persisted inbox after a crash between ingest and apply', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });

    await a.adapter.create(a.rootId, 'bookmark', 'Durable', 'https://durable.example');

    // The response persisted into IndexedDB, then the worker died before
    // applying (doc 05 §6). A fresh engine over the same store resumes.
    const queued = await a.store.listQueuedOps(a.bindingId);
    expect(queued).toHaveLength(1);
    const resp = server.sync(a.bindingId, {
      protocol_version: 1,
      epoch: 1,
      applied_revision: 0,
      received_revision: 0,
      operations: queued.map((row) => row.op as never),
      max_changes: 500,
    });
    await a.store.ingestResponse(a.bindingId, resp);

    // Simulate the crash: a brand-new coordinator over the same Dexie db.
    const { SyncCoordinator } = await import('../src/engine/coordinator');
    const revived = new SyncCoordinator(a.store, a.adapter, a.transport, a.bindingId);
    await revived.drain();

    expect(await a.store.unappliedCount(a.bindingId)).toBe(0);
    await assertConverged(server, [a]);
  });

  it('applies inbox changes in strict revision order', async () => {
    const server = new FakeSyncServer();
    const a = await createTestReplica(server, { name: 'A' });

    // 101: move the child out of the folder, 102: delete the folder.
    // Applied out of order, the recursive delete would swallow the child
    // (doc 05 §7).
    const folder = await a.adapter.create(a.rootId, 'folder', 'Container');
    const child = await a.adapter.create(folder.id, 'bookmark', 'Child', 'https://child.example');
    await a.coordinator.drain();

    const folderCid = (await a.store.getMirrorByBrowser(a.bindingId, folder.id))!.canonicalId;
    const childCid = (await a.store.getMirrorByBrowser(a.bindingId, child.id))!.canonicalId;

    server.sync('other-binding', {
      protocol_version: 1,
      epoch: 1,
      applied_revision: 0,
      received_revision: 0,
      operations: [
        { op_id: '00000000-0000-7000-8000-000000000001', client_seq: 1, base_revision: 2, type: 'move', node_id: childCid, parent: { type: 'root', key: 'main' } },
        { op_id: '00000000-0000-7000-8000-000000000002', client_seq: 2, base_revision: 2, type: 'delete', node_id: folderCid },
      ],
      max_changes: 500,
    });

    // A ingests both changes at once and must apply them in revision
    // order: the child survives the container's delete.
    await a.coordinator.drain();

    const tree = server.tree();
    expect(tree.nodes.has(folderCid)).toBe(false);
    expect(tree.nodes.has(childCid)).toBe(true);
    expect(tree.order.get('root:main')).toContain(childCid);
    await assertConverged(server, [a]);
  });
});

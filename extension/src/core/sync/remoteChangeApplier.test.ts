// RemoteChangeApplier tests: expectation-before-API ordering, strict
// serial apply, ensure-state idempotency, applied_revision advancement.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, findMirrorByCanonical, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import type { BrowserAdapter } from '../browser/types';
import { RemoteChangeApplier } from './remoteChangeApplier';
import type { ChangeWire } from '../protocol/types';

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
    receivedRevision: 101,
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

function createChange(revision: number, nodeId: string): ChangeWire {
  return {
    revision,
    type: 'create',
    node_id: nodeId,
    payload: {
      type: 'bookmark',
      title: 'GitHub',
      url: 'https://github.com',
      parent: { type: 'root', key: 'main' },
      position: 0,
    },
  };
}

// Dexie ends a transaction once the task queue turns over without new
// requests, and every chrome.* call settles exactly that way. A transaction
// body that awaits the browser therefore dies with PrematureCommitError and
// the whole round is lost — a double answering in a microtask cannot show it.
function onMacrotasks(inner: FakeBrowserAdapter): BrowserAdapter {
  const wrapped: Record<string, unknown> = {};
  const proto = Object.getPrototypeOf(inner) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const method = proto[name];
    if (name === 'constructor' || typeof method !== 'function') continue;
    wrapped[name] = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return (method as (...a: unknown[]) => unknown).apply(inner, args);
    };
  }
  return wrapped as unknown as BrowserAdapter;
}

describe('RemoteChangeApplier', () => {
  it('persists the expectation before calling the browser API', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    await seedBinding();
    let expectationAtApiTime: unknown[] | null = null;
    const probe = new FakeBrowserAdapter({
      onMutation: async () => {
        expectationAtApiTime = await db.expectedMutations.toArray();
      },
    });
    const probed = new RemoteChangeApplier(db, probe);

    await probed.applyChange(bindingId, createChange(101, 'n-1'));

    expect(probe.calls).toEqual(['create:f1:GitHub']);
    expect(expectationAtApiTime).not.toBeNull();
    expect(expectationAtApiTime).toHaveLength(1);
    // After success the mirror is mapped, and the expectation now names the
    // browser node it created: it stays until the onCreated echo consumes it,
    // which is what stops our own create from being uploaded as user intent.
    const mirror = await findMirrorByCanonical(db, bindingId, 'n-1');
    expect(mirror).toMatchObject({ canonicalId: 'n-1', title: 'GitHub', parentBrowserId: 'f1' });
    const outstanding = await db.expectedMutations.toArray();
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]).toMatchObject({ kind: 'create', canonicalId: 'n-1', browserId: mirror!.browserId });
    const binding = await db.bindings.get(bindingId);
    expect(binding?.appliedRevision).toBe(101);
  });

  it('applies changes strictly serially and advances applied_revision per change', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    await seedBinding();
    await applier.applyChange(bindingId, createChange(101, 'n-1'));
    await applier.applyChange(bindingId, {
      revision: 102,
      type: 'update_title',
      node_id: 'n-1',
      payload: { title: 'GitHub Repo' },
    });

    expect(adapter.calls).toEqual(['create:f1:GitHub', 'update:b1']);
    const binding = await db.bindings.get(bindingId);
    expect(binding?.appliedRevision).toBe(102);
    const mirror = await findMirrorByCanonical(db, bindingId, 'n-1');
    expect(mirror?.title).toBe('GitHub Repo');
  });

  it('is idempotent via ensure-state when the target is already satisfied', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    await seedBinding();
    await applier.applyChange(bindingId, createChange(101, 'n-1'));
    adapter.calls.length = 0;

    // Same change again (e.g. crash recovery replay): no extra API call.
    // applied_revision is already past 101, so emulate a re-apply from a
    // lagged watermark by resetting it.
    await db.bindings.update(bindingId, { appliedRevision: 100 });
    await applier.applyChange(bindingId, createChange(101, 'n-1'));

    expect(adapter.calls).toEqual([]); // ensure-state satisfied, nothing done
    expect(await db.expectedMutations.count()).toBe(1); // still awaiting its echo, not doubled
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(101);
  });

  it('never gives one canonical id a second browser node', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'Same', url: 'https://github.com' });
    await seedBinding();
    // The first reconciliation mapped this browser node to the server node;
    // the mirror carries the title the browser shows.
    await db.localNodes.put({
      bindingId,
      browserId: 'b1',
      canonicalId: 'n-1',
      type: 'bookmark',
      title: 'Same',
      url: 'https://github.com',
      parentBrowserId: 'f1',
      position: 0,
    });

    // The server's create for n-1 arrives with its own title. Creating here
    // would split one server node across two bookmarks.
    await applier.applyChange(bindingId, createChange(101, 'n-1'));

    expect(adapter.calls).toEqual([]);
    expect(await adapter.getChildren('f1')).toHaveLength(1);
    expect((await db.localNodes.toArray()).filter((m) => m.canonicalId === 'n-1')).toHaveLength(1);
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(101);
  });

  it('recreates a mapped node the browser lost, and only that one', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'GitHub', url: 'https://github.com' });
    await seedBinding();
    await db.localNodes.put({
      bindingId,
      browserId: 'b1',
      canonicalId: 'n-1',
      type: 'bookmark',
      title: 'GitHub',
      url: 'https://github.com',
      parentBrowserId: 'f1',
      position: 0,
    });
    // The user deleted it by hand: the mirror is stale, not satisfied.
    await adapter.removeBookmark('b1');
    adapter.calls.length = 0;

    await applier.applyChange(bindingId, createChange(101, 'n-1'));

    expect(adapter.calls).toEqual(['create:f1:GitHub']);
    const kids = await adapter.getChildren('f1');
    expect(kids.map((k) => k.title)).toEqual(['GitHub']);
    const mapped = await db.localNodes.toArray();
    expect(mapped.filter((m) => m.canonicalId === 'n-1')).toHaveLength(1);
    expect(mapped.some((m) => m.browserId === 'b1')).toBe(false);
  });

  it('rejects non-contiguous revisions', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    await seedBinding();
    await expect(applier.applyChange(bindingId, createChange(102, 'n-1'))).rejects.toThrow(/non-contiguous/);
  });

  // A delete for a folder must use the subtree verb: the browser refuses to
  // drop a non-empty container with the single-item call, so a test double
  // that recursed anyway would hide a permanent failure on real Chromium.
  it('deletes a mapped non-empty folder through the subtree verb', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const binding = await seedBinding();
    adapter.seed({ id: 'd1', parentId: 'f1', title: 'Nested' });
    adapter.seed({ id: 'd2', parentId: 'd1', title: 'Leaf', url: 'https://leaf.test' });
    await db.localNodes.bulkPut([
      { bindingId, browserId: 'd1', canonicalId: 'n-folder', type: 'folder', title: 'Nested', url: null, parentBrowserId: 'f1', position: 0 },
      { bindingId, browserId: 'd2', canonicalId: 'n-leaf', type: 'bookmark', title: 'Leaf', url: 'https://leaf.test', parentBrowserId: 'd1', position: 0 },
    ]);

    await applier.applyChange(bindingId, {
      revision: 101,
      type: 'delete',
      node_id: 'n-folder',
      payload: { count: 2 },
    });

    expect(adapter.calls).toEqual(['removeSubtree:d1']);
    expect(await adapter.getNode('d1')).toBeNull();
    expect(await db.localNodes.get([bindingId, 'd1'])).toBeUndefined();
    // The whole subtree mapping goes, not just the requested row.
    expect(await db.localNodes.get([bindingId, 'd2'])).toBeUndefined();
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(101);
  });

  it('deletes a mapped bookmark through the bookmark verb', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const binding = await seedBinding();
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'GitHub', url: 'https://github.com' });
    await db.localNodes.put({
      bindingId, browserId: 'b1', canonicalId: 'n-1', type: 'bookmark',
      title: 'GitHub', url: 'https://github.com', parentBrowserId: 'f1', position: 0,
    });

    await applier.applyChange(bindingId, { revision: 101, type: 'delete', node_id: 'n-1', payload: { count: 1 } });

    expect(adapter.calls).toEqual(['removeBookmark:b1']);
  });

  // The user may have deleted it locally already; that satisfies the change
  // rather than rejecting the round forever.
  it('treats a delete of an already-absent browser node as satisfied', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const binding = await seedBinding();
    await db.localNodes.put({
      bindingId, browserId: 'gone', canonicalId: 'n-1', type: 'bookmark',
      title: 'GitHub', url: 'https://github.com', parentBrowserId: 'f1', position: 0,
    });

    await applier.applyChange(bindingId, { revision: 101, type: 'delete', node_id: 'n-1', payload: { count: 1 } });

    expect(adapter.calls).toEqual([]);
    expect(await db.localNodes.get([bindingId, 'gone'])).toBeUndefined();
    expect(await db.expectedMutations.count()).toBe(0);
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(101);
  });

  it('recovers an unresolved provisional create after a simulated crash', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    const binding = await seedBinding();
    // Crash simulation: expectation persisted, browser API succeeded,
    // mirror transaction never committed.
    await db.expectedMutations.add({
      bindingId,
      revision: 101,
      kind: 'create',
      canonicalId: 'n-1',
      browserId: null,
      parentBrowserId: 'f1',
      position: 0,
      title: 'GitHub',
      url: 'https://github.com',
      createdAt: Date.now(),
    });
    const orphan = adapter.seed({ id: 'orphan', parentId: 'f1', title: 'GitHub', url: 'https://github.com' });

    await applier.recover(bindingId);

    expect(await db.expectedMutations.count()).toBe(0);
    const mirror = await findMirrorByCanonical(db, bindingId, 'n-1');
    expect(mirror).toMatchObject({ browserId: orphan.id, canonicalId: 'n-1' });
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(101);
    void binding;
  });

  it('keeps browser reads out of the create mirror transaction', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    await seedBinding();

    const applier2 = new RemoteChangeApplier(db, onMacrotasks(adapter));
    await expect(applier2.applyChange(bindingId, createChange(101, 'n-1'))).resolves.toBeUndefined();

    expect((await adapter.getChildren('f1')).map((k) => k.title)).toEqual(['GitHub']);
    expect((await findMirrorByCanonical(db, bindingId, 'n-1'))?.position).toBe(0);
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(101);
  });

  it('keeps browser reads out of the recovery commit transaction', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'GitHub', url: 'https://github.com' });
    await seedBinding();
    await db.localNodes.put({
      bindingId, browserId: 'b1', canonicalId: 'n-1', type: 'bookmark',
      title: 'GitHub', url: 'https://github.com', parentBrowserId: 'f1', position: null,
    });
    // Crash simulation: the browser API landed, the expectation is settled,
    // and the mirror still has to be repaired (doc 05 §10).
    await db.expectedMutations.add({
      bindingId,
      revision: 101,
      kind: 'create',
      canonicalId: 'n-1',
      browserId: 'b1',
      parentBrowserId: 'f1',
      position: 0,
      title: 'GitHub',
      url: 'https://github.com',
      createdAt: Date.now(),
    });

    const applier2 = new RemoteChangeApplier(db, onMacrotasks(adapter));
    await expect(applier2.recover(bindingId)).resolves.toBeUndefined();

    expect(await db.expectedMutations.count()).toBe(0);
    expect((await findMirrorByCanonical(db, bindingId, 'n-1'))?.position).toBe(0);
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(101);
  });
});

// RemoteChangeApplier tests: expectation-before-API ordering, strict
// serial apply, ensure-state idempotency, applied_revision advancement.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, findMirrorByCanonical, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
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
    // After success the expectation is consumed and the mirror is mapped.
    expect(await db.expectedMutations.count()).toBe(0);
    const mirror = await findMirrorByCanonical(db, bindingId, 'n-1');
    expect(mirror).toMatchObject({ canonicalId: 'n-1', title: 'GitHub', parentBrowserId: 'f1' });
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
    expect(await db.expectedMutations.count()).toBe(0);
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(101);
  });

  it('rejects non-contiguous revisions', async () => {
    adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
    await seedBinding();
    await expect(applier.applyChange(bindingId, createChange(102, 'n-1'))).rejects.toThrow(/non-contiguous/);
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
});

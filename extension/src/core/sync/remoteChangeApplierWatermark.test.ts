// applied_revision is a statement about browser state, not about messages
// received. These tests pin the difference: a change that could not be
// applied must leave the watermark where it was and surface a repair path.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { RemoteChangeApplier, UnmappedProjectionError } from './remoteChangeApplier';
import type { ChangeWire } from '../protocol/types';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let applier: RemoteChangeApplier;

const bindingId = 'binding-wm';

async function seedBinding(mount: BindingRecord['mount'] = { mode: 'partial', folderBrowserId: 'f1', rootKey: 'main' }) {
  const binding: BindingRecord = {
    id: bindingId,
    spaceId: 'space-1',
    spaceName: 'Personal',
    mode: mount.mode,
    state: 'active',
    epoch: 1,
    appliedRevision: 100,
    receivedRevision: 105,
    clientSeq: 0,
    mount,
    lastSyncAt: null,
    recovery: null,
    createdAt: Date.now(),
  };
  await db.bindings.put(binding);
  return binding;
}

const applied = async () => (await db.bindings.get(bindingId))?.appliedRevision;

function createUnder(nodeId: string, parentId: string): ChangeWire {
  return {
    revision: 101,
    type: 'create',
    node_id: nodeId,
    payload: {
      type: 'bookmark',
      title: 'Lost Parent',
      url: 'https://lost.test',
      parent: { type: 'node', id: parentId },
      position: 0,
    },
  };
}

beforeEach(() => {
  db = new PontisDB(`wm-test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  applier = new RemoteChangeApplier(db, adapter);
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
});

describe('applied watermark on lost mappings', () => {
  // Acceptance from the review: drop a parent mapping that should exist,
  // deliver a CREATE, and the client must refuse to advance rather than
  // quietly acknowledging a change it never performed.
  it('does not advance applied_revision for a create with a lost parent mapping', async () => {
    await seedBinding();
    await db.localNodes.put({
      bindingId, browserId: 'p1', canonicalId: 'n-parent', type: 'folder',
      title: 'Parent', url: null, parentBrowserId: 'f1', position: 0,
    });
    // The mapping is lost (storage cleared, crash mid-commit).
    await db.localNodes.bulkDelete([[bindingId, 'p1']]);

    await expect(applier.applyChange(bindingId, createUnder('n-new', 'n-parent')))
      .rejects.toBeInstanceOf(UnmappedProjectionError);

    expect(adapter.calls).toEqual([]);
    expect(await applied()).toBe(100);
    // Nothing half-written: the node is not mapped under some other parent.
    expect(await db.localNodes.count()).toBe(0);
  });

  it('does not advance for an update of a node with no mapping', async () => {
    await seedBinding();
    await expect(
      applier.applyChange(bindingId, {
        revision: 101, type: 'update_title', node_id: 'n-ghost', payload: { title: 'Renamed' },
      }),
    ).rejects.toBeInstanceOf(UnmappedProjectionError);

    expect(adapter.calls).toEqual([]);
    expect(await applied()).toBe(100);
  });

  it('does not advance for a move into a lost parent mapping', async () => {
    await seedBinding();
    adapter.seed({ id: 'n1', parentId: 'f1', title: 'Node', url: 'https://n1.test' });
    await db.localNodes.put({
      bindingId, browserId: 'n1', canonicalId: 'n-1', type: 'bookmark',
      title: 'Node', url: 'https://n1.test', parentBrowserId: 'f1', position: 0,
    });

    await expect(
      applier.applyChange(bindingId, {
        revision: 101, type: 'move', node_id: 'n-1',
        payload: { parent: { type: 'node', id: 'n-gone' }, position: 0 },
      }),
    ).rejects.toBeInstanceOf(UnmappedProjectionError);

    expect(adapter.calls).toEqual([]);
    expect(await applied()).toBe(100);
  });

  // The other half of the distinction: a root this mount deliberately does
  // not cover is not a lost mapping, and must not wedge the binding.
  it('acknowledges a create under a root outside the mount projection', async () => {
    await seedBinding({ mode: 'full', rootKey: 'main', roots: { main: 'f1' } });

    await applier.applyChange(bindingId, {
      revision: 101, type: 'create', node_id: 'n-other',
      payload: {
        type: 'bookmark', title: 'Other Root', url: 'https://other.test',
        parent: { type: 'root', key: 'other_bookmarks' }, position: 0,
      },
    });

    expect(adapter.calls).toEqual([]);
    expect(await applied()).toBe(101);
  });

  it('keeps an expectation whose mapping is gone instead of acknowledging it', async () => {
    await seedBinding();
    await db.expectedMutations.add({
      bindingId, revision: 101, kind: 'update_title', canonicalId: 'n-gone',
      browserId: 'gone', title: 'Renamed', createdAt: Date.now(),
    });

    await applier.recover(bindingId);

    expect(await applied()).toBe(100);
    expect(await db.expectedMutations.count()).toBe(1);
  });
});

// Order projection tests. The mirror records the server's canonical
// positions, so the browser has to end up in that order — otherwise the
// binding reports a synced tree the user's bookmark bar does not show.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { RemoteChangeApplier } from './remoteChangeApplier';
import type { ChangeWire } from '../protocol/types';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let applier: RemoteChangeApplier;

const bindingId = 'binding-order';

async function seedBinding(): Promise<BindingRecord> {
  const binding: BindingRecord = {
    id: bindingId,
    spaceId: 'space-1',
    spaceName: 'Personal',
    mode: 'partial',
    state: 'active',
    epoch: 1,
    appliedRevision: 100,
    receivedRevision: 105,
    clientSeq: 0,
    mount: { mode: 'partial', folderBrowserId: 'f1', rootKey: 'main' },
    lastSyncAt: null,
    recovery: null,
    createdAt: Date.now(),
  };
  await db.bindings.put(binding);
  return binding;
}

interface Sibling {
  browserId: string;
  canonicalId: string;
  title: string;
  /** Canonical position recorded in the mirror. */
  position: number;
  /** Browser slot; defaults to the mirror position (undrifted tree). */
  browserIndex?: number;
}

async function seedSiblings(siblings: Sibling[]): Promise<void> {
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
  for (const s of siblings) {
    adapter.seed({
      id: s.browserId,
      parentId: 'f1',
      title: s.title,
      url: `https://${s.title}.test`,
      index: s.browserIndex ?? s.position,
    });
    await db.localNodes.put({
      bindingId,
      browserId: s.browserId,
      canonicalId: s.canonicalId,
      type: 'bookmark',
      title: s.title,
      url: `https://${s.title}.test`,
      parentBrowserId: 'f1',
      position: s.position,
    });
  }
}

const order = async (): Promise<string[]> => (await adapter.getChildren('f1')).map((n) => n.title);
const mirrorPositions = async (): Promise<Record<string, number | null>> => {
  const rows = await db.localNodes.where('bindingId').equals(bindingId).toArray();
  return Object.fromEntries(rows.map((r) => [r.title, r.position]));
};

function moveChange(revision: number, nodeId: string, position: number): ChangeWire {
  return {
    revision,
    type: 'move',
    node_id: nodeId,
    payload: { parent: { type: 'root', key: 'main' }, position },
  };
}

beforeEach(() => {
  db = new PontisDB(`order-test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  applier = new RemoteChangeApplier(db, adapter);
});

describe('remote order projection', () => {
  // The reported failure: with A(0) B(1) C(2), moving C to position 0 picked
  // "before B" and produced A,C,B. The browser removes first, so the index is
  // the slot of the sibling that must land directly after it.
  it('moves a trailing sibling to position 0', async () => {
    await seedBinding();
    await seedSiblings([
      { browserId: 'ba', canonicalId: 'n-a', title: 'A', position: 0 },
      { browserId: 'bb', canonicalId: 'n-b', title: 'B', position: 1 },
      { browserId: 'bc', canonicalId: 'n-c', title: 'C', position: 2 },
    ]);

    await applier.applyChange(bindingId, moveChange(101, 'n-c', 0));

    expect(await order()).toEqual(['C', 'A', 'B']);
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(101);
  });

  it('moves a leading sibling to the end', async () => {
    await seedBinding();
    await seedSiblings([
      { browserId: 'ba', canonicalId: 'n-a', title: 'A', position: 0 },
      { browserId: 'bb', canonicalId: 'n-b', title: 'B', position: 1 },
      { browserId: 'bc', canonicalId: 'n-c', title: 'C', position: 2 },
    ]);

    await applier.applyChange(bindingId, moveChange(101, 'n-a', 2));

    expect(await order()).toEqual(['B', 'C', 'A']);
  });

  it('reorders within the same parent', async () => {
    await seedBinding();
    await seedSiblings([
      { browserId: 'ba', canonicalId: 'n-a', title: 'A', position: 0 },
      { browserId: 'bb', canonicalId: 'n-b', title: 'B', position: 1 },
      { browserId: 'bc', canonicalId: 'n-c', title: 'C', position: 2 },
    ]);

    await applier.applyChange(bindingId, moveChange(101, 'n-a', 1));

    expect(await order()).toEqual(['B', 'A', 'C']);
    // Sibling mirrors follow the new order: one MOVE renumbers the whole set.
    expect(await mirrorPositions()).toEqual({ A: 1, B: 0, C: 2 });
  });

  it('creates at the requested position instead of appending', async () => {
    await seedBinding();
    await seedSiblings([
      { browserId: 'ba', canonicalId: 'n-a', title: 'A', position: 0 },
      { browserId: 'bb', canonicalId: 'n-b', title: 'B', position: 1 },
    ]);

    await applier.applyChange(bindingId, {
      revision: 101,
      type: 'create',
      node_id: 'n-new',
      payload: {
        type: 'bookmark',
        title: 'New',
        url: 'https://new.test',
        parent: { type: 'root', key: 'main' },
        position: 1,
      },
    });

    expect(await order()).toEqual(['A', 'New', 'B']);
    expect(await mirrorPositions()).toEqual({ A: 0, New: 1, B: 2 });
  });

  it('creates at position 0 ahead of existing siblings', async () => {
    await seedBinding();
    await seedSiblings([
      { browserId: 'ba', canonicalId: 'n-a', title: 'A', position: 0 },
      { browserId: 'bb', canonicalId: 'n-b', title: 'B', position: 1 },
    ]);

    await applier.applyChange(bindingId, {
      revision: 101,
      type: 'create',
      node_id: 'n-new',
      payload: {
        type: 'bookmark',
        title: 'New',
        url: 'https://new.test',
        parent: { type: 'root', key: 'main' },
        position: 0,
      },
    });

    expect(await order()).toEqual(['New', 'A', 'B']);
    expect(await mirrorPositions()).toEqual({ New: 0, A: 1, B: 2 });
  });

  it('ignores unmapped local-only children when computing the slot', async () => {
    await seedBinding();
    // Browser order is A, LocalOnly, B while the projection covers only A and B.
    await seedSiblings([
      { browserId: 'ba', canonicalId: 'n-a', title: 'A', position: 0 },
      { browserId: 'bb', canonicalId: 'n-b', title: 'B', position: 1, browserIndex: 2 },
    ]);
    adapter.seed({ id: 'local', parentId: 'f1', title: 'LocalOnly', index: 1 });

    await applier.applyChange(bindingId, moveChange(101, 'n-b', 0));

    expect(await order()).toEqual(['B', 'A', 'LocalOnly']);
    // LocalOnly occupies a browser slot but has no canonical position.
    const positions = await mirrorPositions();
    expect(positions).toEqual({ A: 1, B: 0 });
    expect('LocalOnly' in positions).toBe(false);
  });
});

describe('remote order recovery', () => {
  it('does not treat a same-parent move that never ran as satisfied', async () => {
    await seedBinding();
    await seedSiblings([
      { browserId: 'ba', canonicalId: 'n-a', title: 'A', position: 0 },
      { browserId: 'bb', canonicalId: 'n-b', title: 'B', position: 1 },
      { browserId: 'bc', canonicalId: 'n-c', title: 'C', position: 2 },
    ]);
    // Crash after the expectation was written, before the browser API call:
    // the tree is still in the old order but the parent is unchanged.
    await db.expectedMutations.add({
      bindingId,
      revision: 101,
      kind: 'move',
      canonicalId: 'n-c',
      browserId: 'bc',
      parentBrowserId: 'f1',
      position: 0,
      createdAt: Date.now(),
    });

    await applier.recover(bindingId);

    expect(await order()).toEqual(['A', 'B', 'C']);
    // Advancing here would strand C at the end forever, with the binding
    // claiming revision 101 applied.
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(100);
    expect(await db.expectedMutations.count()).toBe(1);
  });

  it('resolves a move whose browser order already matches', async () => {
    await seedBinding();
    // Browser already reads C, A, B while the mirrors still hold the
    // pre-move positions: the API ran, the commit transaction never did.
    await seedSiblings([
      { browserId: 'bc', canonicalId: 'n-c', title: 'C', position: 2, browserIndex: 0 },
      { browserId: 'ba', canonicalId: 'n-a', title: 'A', position: 0, browserIndex: 1 },
      { browserId: 'bb', canonicalId: 'n-b', title: 'B', position: 1, browserIndex: 2 },
    ]);
    await db.expectedMutations.add({
      bindingId,
      revision: 101,
      kind: 'move',
      canonicalId: 'n-c',
      browserId: 'bc',
      parentBrowserId: 'f1',
      position: 0,
      createdAt: Date.now(),
    });

    await applier.recover(bindingId);

    expect(await db.expectedMutations.count()).toBe(0);
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(101);
    expect(await mirrorPositions()).toEqual({ C: 0, A: 1, B: 2 });
  });
});

// Reconciliation step applier (doc 08 §13). The server planned the tree;
// these tests pin what the client owes the browser instead: drive each step
// into the real tree, keep the mirror in step with it, and be safe to replay
// after the worker died halfway through.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, type LocalNodeRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { StepResolutionError, applyReconcileSteps, type StepScope } from './reconcileSteps';
import type { ApplyStepWire } from '../protocol/types';

let db: PontisDB;
let adapter: FakeBrowserAdapter;

const bindingId = 'binding-1';
const scope: StepScope = {
  bindingId,
  localRefs: { l_1: 'f1', l_2: 'b1', l_3: 'b2', l_4: 'f3' },
  roots: { main: 'f1' },
};
const ROOT = { type: 'root', key: 'main' } as const;

async function mirror(row: Partial<LocalNodeRecord> & { browserId: string; canonicalId: string }): Promise<void> {
  await db.localNodes.put({
    bindingId,
    browserId: row.browserId,
    canonicalId: row.canonicalId,
    type: row.type ?? 'bookmark',
    title: row.title ?? '',
    url: row.url ?? null,
    parentBrowserId: row.parentBrowserId ?? 'f1',
    position: row.position ?? null,
  });
}

beforeEach(() => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
  adapter.seed({ id: 'b1', parentId: 'f1', title: 'Home', url: 'https://home.example.com' });
  adapter.seed({ id: 'b2', parentId: 'f1', title: 'Docs', url: 'https://docs.example.com' });
  adapter.seed({ id: 'f3', parentId: 'f1', title: 'Reading' });
});

describe('create steps', () => {
  it('places a new bookmark where the plan says and maps its identity', async () => {
    await mirror({ browserId: 'b1', canonicalId: 'n1', title: 'Home', url: 'https://home.example.com' });
    await mirror({ browserId: 'b2', canonicalId: 'n2', title: 'Docs', url: 'https://docs.example.com' });

    await applyReconcileSteps(db, adapter, scope, [
      {
        kind: 'create',
        canonical_id: 'n3',
        type: 'bookmark',
        title: 'News',
        url: 'https://news.example.com',
        parent: ROOT,
        before_id: 'n2',
      },
    ]);

    const created = await adapter.getChildren('f1');
    expect(created.map((c) => c.title)).toEqual(['Home', 'News', 'Docs', 'Reading']);
    const row = (await db.localNodes.toArray()).find((r) => r.canonicalId === 'n3');
    expect(row?.browserId).toBe(created[1]!.id);
    // Positions are re-read from the browser, so the mirror keeps the order
    // the steps actually produced rather than the plan's abstract positions.
    const mapped = await db.localNodes.toArray();
    expect(mapped.filter((m) => m.canonicalId).map((m) => [m.canonicalId, m.position])).toEqual([
      ['n1', 0],
      ['n2', 2],
      ['n3', 1],
    ]);
    // The create's expectation is left for the browser echo to consume.
    expect(await db.expectedMutations.count()).toBe(1);
  });

  it('creates inside the canonical folder the plan named as parent', async () => {
    await mirror({ browserId: 'f3', canonicalId: 'nf', type: 'folder', title: 'Reading' });

    await applyReconcileSteps(db, adapter, scope, [
      {
        kind: 'create',
        canonical_id: 'n9',
        type: 'bookmark',
        title: 'Later',
        url: 'https://later.example.com',
        parent: { type: 'node', id: 'nf' },
      },
    ]);

    expect((await adapter.getChildren('f3')).map((c) => c.title)).toEqual(['Later']);
  });

  it('stops instead of hanging a node on a parent it cannot locate', async () => {
    await expect(
      applyReconcileSteps(db, adapter, scope, [
        { kind: 'create', canonical_id: 'n3', type: 'folder', title: 'X', parent: { type: 'node', id: 'missing' } },
      ]),
    ).rejects.toBeInstanceOf(StepResolutionError);
    expect(adapter.calls).toEqual([]);
  });
});

describe('steps are safe to replay', () => {
  it('applying the same plan twice leaves one tree and no second browser call', async () => {
    const steps: ApplyStepWire[] = [
      { kind: 'assign_identity', local_ref: 'l_2', canonical_id: 'n1' },
      {
        kind: 'create',
        canonical_id: 'n2',
        type: 'folder',
        title: 'Archive',
        parent: ROOT,
      },
    ];

    await applyReconcileSteps(db, adapter, scope, steps);
    const afterFirst = adapter.calls.slice();
    const children = (await adapter.getChildren('f1')).map((c) => c.id);

    await applyReconcileSteps(db, adapter, scope, steps);

    expect(adapter.calls).toEqual(afterFirst);
    expect((await adapter.getChildren('f1')).map((c) => c.id)).toEqual(children);
    const rows = await db.localNodes.toArray();
    expect(rows.filter((r) => r.canonicalId === 'n2')).toHaveLength(1);
  });

  it('drops the mirror of a node the browser already lost, without deleting again', async () => {
    await mirror({ browserId: 'f3', canonicalId: 'nf', type: 'folder', title: 'Reading' });
    await mirror({ browserId: 'b3', canonicalId: 'nb', title: 'Inside', parentBrowserId: 'f3' });
    await adapter.removeSubtree('f3');

    await applyReconcileSteps(db, adapter, scope, [{ kind: 'delete', local_ref: 'l_4' }]);

    expect(await db.localNodes.get([bindingId, 'f3'])).toBeUndefined();
    expect(await db.localNodes.get([bindingId, 'b3'])).toBeUndefined();
    expect(adapter.calls.filter((c) => c.startsWith('removeSubtree'))).toHaveLength(1);
  });
});

describe('move, update and delete steps', () => {
  it('moves a node into another folder at the planned place', async () => {
    await mirror({ browserId: 'b1', canonicalId: 'n1', title: 'Home' });
    await mirror({ browserId: 'f3', canonicalId: 'nf', type: 'folder', title: 'Reading' });

    await applyReconcileSteps(db, adapter, scope, [
      { kind: 'move', local_ref: 'l_2', parent: { type: 'node', id: 'nf' }, before_id: '' },
    ]);

    expect((await adapter.getChildren('f3')).map((c) => c.id)).toEqual(['b1']);
    expect((await adapter.getChildren('f1')).map((c) => c.id)).toEqual(['b2', 'f3']);
    expect((await db.localNodes.get([bindingId, 'b1']))?.parentBrowserId).toBe('f3');
  });

  it('renames only what the step carries and keeps the mirror in sync', async () => {
    await mirror({ browserId: 'b1', canonicalId: 'n1', title: 'Home', url: 'https://home.example.com' });

    await applyReconcileSteps(db, adapter, scope, [{ kind: 'update', local_ref: 'l_2', title: 'Homepage' }]);

    expect((await adapter.getNode('b1'))?.title).toBe('Homepage');
    expect((await db.localNodes.get([bindingId, 'b1']))?.title).toBe('Homepage');
    expect((await db.localNodes.get([bindingId, 'b1']))?.url).toBe('https://home.example.com');
  });

  it('deletes a folder subtree from the browser and the mirror together', async () => {
    await mirror({ browserId: 'b1', canonicalId: 'n1', title: 'Home' });
    await mirror({ browserId: 'b2', canonicalId: 'n2', title: 'Docs' });
    await mirror({ browserId: 'f3', canonicalId: 'nf', type: 'folder', title: 'Reading' });
    await mirror({ browserId: 'b3', canonicalId: 'nb', title: 'Inside', parentBrowserId: 'f3' });

    await applyReconcileSteps(db, adapter, scope, [{ kind: 'delete', local_ref: 'l_4' }]);

    expect(await adapter.getNode('f3')).toBeNull();
    expect(await adapter.getNode('b3')).toBeNull();
    expect(adapter.calls).toEqual(['removeSubtree:f3']);
    expect((await db.localNodes.toArray()).map((r) => r.browserId).sort()).toEqual(['b1', 'b2']);
  });

  it('refuses to act on a step whose target has no mapping', async () => {
    await expect(applyReconcileSteps(db, adapter, scope, [{ kind: 'update', canonical_id: 'ghost', title: 'X' }]))
      .rejects.toBeInstanceOf(StepResolutionError);
    expect(adapter.calls).toEqual([]);
  });
});

describe('identity steps', () => {
  it('keeps one canonical id on one browser node', async () => {
    await mirror({ browserId: 'b1', canonicalId: 'n1', title: 'Home' });

    // The plan claims n1 for b2 as well; picking a winner would silently
    // delete a user's bookmark from the replica's point of view.
    await expect(
      applyReconcileSteps(db, adapter, scope, [{ kind: 'assign_identity', local_ref: 'l_3', canonical_id: 'n1' }]),
    ).rejects.toBeInstanceOf(StepResolutionError);
    expect(await db.localNodes.get([bindingId, 'b2'])).toBeUndefined();
  });

  it('maps the mount roots it is given and nothing else', async () => {
    await applyReconcileSteps(db, adapter, scope, [{ kind: 'assign_identity', local_ref: 'l_1', canonical_id: 'root' }]);

    expect((await db.localNodes.toArray()).map((r) => [r.browserId, r.canonicalId])).toEqual([['f1', 'root']]);
  });
});

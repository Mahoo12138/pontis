// The echo race the mocks used to miss: a mutation the sync itself made fires
// a real browser event a moment later. The applier must leave its expectation
// for that echo to consume — consuming it itself makes the event look like user
// intent, and the node gets uploaded back as a second copy of the same canonical
// id. These tests drive the applier and the EventProcessor over one adapter,
// which is how the service worker actually runs them.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, type BindingRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { EventProcessor } from './eventProcessor';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { applyReconcileSteps } from './reconcileSteps';
import type { ChangeWire } from '../protocol/types';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let applier: RemoteChangeApplier;
let processor: EventProcessor;

const bindingId = 'binding-1';

async function seedBinding(state: BindingRecord['state'] = 'active'): Promise<void> {
  await db.bindings.put({
    id: bindingId,
    spaceId: 'space-1',
    spaceName: 'Personal',
    mode: 'partial',
    state,
    epoch: 1,
    appliedRevision: 100,
    receivedRevision: 101,
    clientSeq: 0,
    mount: { mode: 'partial', folderBrowserId: 'f1', rootKey: 'main' },
    lastSyncAt: null,
    recovery: null,
    createdAt: Date.now(),
  });
}

async function mapNode(browserId: string, canonicalId: string, title: string, url: string | null): Promise<void> {
  const node = await adapter.getNode(browserId);
  await db.localNodes.put({
    bindingId,
    browserId,
    canonicalId,
    type: node!.type,
    title,
    url,
    parentBrowserId: node!.parentId,
    position: 0,
  });
}

const createChange = (revision: number, nodeId: string, title = 'GitHub'): ChangeWire => ({
  revision,
  type: 'create',
  node_id: nodeId,
  payload: {
    type: 'bookmark',
    title,
    url: 'https://github.com',
    parent: { type: 'root', key: 'main' },
    position: 0,
  },
});

beforeEach(() => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  applier = new RemoteChangeApplier(db, adapter);
  processor = new EventProcessor(db, adapter);
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
});

describe('expectations are consumed by the browser echo', () => {
  it('a remote create leaves no local op once its onCreated arrives', async () => {
    await seedBinding();

    await applier.applyChange(bindingId, createChange(101, 'n-1'));
    const created = (await adapter.getChildren('f1')).find((c) => c.title === 'GitHub')!;
    expect(await processor.handleEvent(bindingId, { kind: 'created', node: created })).toBe('expected');

    expect(await db.pendingOps.count()).toBe(0);
    expect(await db.expectedMutations.count()).toBe(0);
    expect((await db.localNodes.get([bindingId, created.id]))?.canonicalId).toBe('n-1');
  });

  it('a remote rename leaves no local op once its onChanged arrives', async () => {
    await seedBinding();
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'Old', url: 'https://github.com' });
    await mapNode('b1', 'n-1', 'Old', 'https://github.com');

    await applier.applyChange(bindingId, {
      revision: 101,
      type: 'update_title',
      node_id: 'n-1',
      payload: { title: 'Renamed' },
    });
    const node = (await adapter.getNode('b1'))!;
    expect(await processor.handleEvent(bindingId, { kind: 'changed', node })).toBe('expected');

    expect(await db.pendingOps.count()).toBe(0);
    expect(await db.expectedMutations.count()).toBe(0);
  });

  it('a remote move leaves no local op once its onMoved arrives', async () => {
    await seedBinding();
    adapter.seed({ id: 'b1', parentId: 'f1', title: 'Mover', url: 'https://github.com' });
    adapter.seed({ id: 'f2', parentId: 'f1', title: 'Archive' });
    await mapNode('b1', 'n-1', 'Mover', 'https://github.com');
    await mapNode('f2', 'n-2', 'Archive', null);

    await applier.applyChange(bindingId, {
      revision: 101,
      type: 'move',
      node_id: 'n-1',
      payload: { parent: { type: 'node', id: 'n-2' }, position: 0 },
    });
    const node = (await adapter.getNode('b1'))!;
    expect(await processor.handleEvent(bindingId, { kind: 'moved', node, oldParentId: 'f1' })).toBe('expected');

    expect(await db.pendingOps.count()).toBe(0);
    expect(await db.expectedMutations.count()).toBe(0);
  });

  it('a reconciliation step create is echoed the same way', async () => {
    await seedBinding('initializing');
    // With the mount root mapped, a missed expectation does not merely get
    // ignored: it becomes a queued CREATE for the node the sync just made.
    await mapNode('f1', 'n-root', 'Sync', null);

    await applyReconcileSteps(
      db,
      adapter,
      { bindingId, localRefs: {}, roots: { main: 'f1' } },
      [
        {
          kind: 'create',
          canonical_id: 'n-step',
          type: 'bookmark',
          title: 'Stepped',
          url: 'https://stepped.example.com',
          parent: { type: 'root', key: 'main' },
        },
      ],
    );
    const created = (await adapter.getChildren('f1')).find((c) => c.title === 'Stepped')!;
    expect(await processor.handleEvent(bindingId, { kind: 'created', node: created })).toBe('expected');

    // The duplicate that corrupted the alpha space: one canonical id, two nodes.
    expect(await db.pendingOps.count()).toBe(0);
    expect((await adapter.getChildren('f1')).filter((c) => c.title === 'Stepped')).toHaveLength(1);
  });

  it('still records a real user bookmark as a local op', async () => {
    await seedBinding();
    const userNode = adapter.seed({ id: 'b9', parentId: 'f1', title: 'User made this', url: 'https://user.example.com' });

    expect(await processor.handleEvent(bindingId, { kind: 'created', node: userNode })).toBe('local-op');

    const ops = await db.pendingOps.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'create', title: 'User made this', browserId: 'b9' });
  });

  it('sweeps a resolved expectation whose echo was lost', async () => {
    await seedBinding();
    await applier.applyChange(bindingId, createChange(101, 'n-1'));
    // The worker died before the event arrived: nothing consumes the record.
    expect(await db.expectedMutations.count()).toBe(1);

    await applier.recover(bindingId);

    expect(await db.expectedMutations.count()).toBe(0);
    expect(await db.pendingOps.count()).toBe(0);
  });
});

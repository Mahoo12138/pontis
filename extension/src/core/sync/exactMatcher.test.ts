// Exact matcher tests (doc 06 §6): parent-aware, exact + unique only.
// Ambiguity is never guessed; no cross-parent inference.

import { describe, expect, it } from 'vitest';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { matchExact, snapshotBrowserTree, countBrowserSubtree } from './exactMatcher';
import { replayChanges, type CanonicalTree } from './canonicalTree';
import type { ChangeWire, ParentRefWire } from '../protocol/types';

function treeOf(changes: Array<Omit<ChangeWire, 'revision'>>): CanonicalTree {
  return replayChanges(changes.map((c, i) => ({ ...c, revision: i + 1 })));
}

const mk = (id: string, over: Partial<ChangeWire['payload']> = {}): Omit<ChangeWire, 'revision'> => ({
  type: 'create',
  node_id: id,
  payload: {
    type: 'bookmark',
    title: `T ${id}`,
    url: `https://${id}.example.com`,
    parent: { type: 'root', key: 'main' },
    position: Number(id.replace(/\D/g, '') || 0),
    ...over,
  } as ChangeWire['payload'],
});

const ROOT: ParentRefWire = { type: 'root', key: 'main' };

async function snapOf(adapter: FakeBrowserAdapter, rootId: string) {
  return snapshotBrowserTree(adapter, rootId);
}

describe('exactMatcher', () => {
  it('matches unique folder titles and bookmark URLs, recursing top-down', async () => {
    const adapter = new FakeBrowserAdapter();
    adapter.seed({ id: 'mount', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'bf', parentId: 'mount', title: 'Docs' });
    adapter.seed({ id: 'bb1', parentId: 'bf', title: ' ignored', url: 'https://n-a.example.com' });
    adapter.seed({ id: 'bb2', parentId: 'mount', title: 'x', url: 'https://n-b.example.com' });

    const tree = treeOf([
      mk('f1', { type: 'folder', url: '', title: 'Docs' }),
      mk('n-a', { parent: { type: 'node', id: 'f1' }, position: 0 }),
      mk('n-b', { position: 1 }),
    ]);
    const result = matchExact(await snapOf(adapter, 'mount'), tree, ROOT);

    expect(result.matched).toContainEqual({ browserId: 'bf', canonicalId: 'f1' });
    expect(result.matched).toContainEqual({ browserId: 'bb1', canonicalId: 'n-a' });
    expect(result.matched).toContainEqual({ browserId: 'bb2', canonicalId: 'n-b' });
    expect(result.browserOnly).toHaveLength(0);
    expect(result.serverOnly).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
  });

  it('marks duplicate folder titles ambiguous instead of guessing', async () => {
    const adapter = new FakeBrowserAdapter();
    adapter.seed({ id: 'mount', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'd1', parentId: 'mount', title: 'Docs' });
    adapter.seed({ id: 'd2', parentId: 'mount', title: 'Docs' });

    const tree = treeOf([mk('f1', { type: 'folder', url: '', title: 'Docs' })]);
    const result = matchExact(await snapOf(adapter, 'mount'), tree, ROOT);

    expect(result.matched).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]).toMatchObject({ canonicalId: 'f1', reason: 'duplicate_folder_title' });
    expect(result.browserOnly.map((b) => b.node.id).sort()).toEqual(['d1', 'd2']);
  });

  it('marks duplicate bookmark URLs ambiguous', async () => {
    const adapter = new FakeBrowserAdapter();
    adapter.seed({ id: 'mount', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'u1', parentId: 'mount', title: 'one', url: 'https://dup.example.com' });
    adapter.seed({ id: 'u2', parentId: 'mount', title: 'two', url: 'https://dup.example.com' });

    const tree = treeOf([mk('n1', { url: 'https://dup.example.com' })]);
    const result = matchExact(await snapOf(adapter, 'mount'), tree, ROOT);

    expect(result.matched).toHaveLength(0);
    expect(result.ambiguous[0]).toMatchObject({ reason: 'duplicate_bookmark_url' });
  });

  it('never matches across parents (parent-aware, no move inference)', async () => {
    const adapter = new FakeBrowserAdapter();
    adapter.seed({ id: 'mount', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'other', parentId: 'mount', title: 'Other' });
    adapter.seed({ id: 'deep', parentId: 'other', title: 'Docs' });

    const tree = treeOf([mk('f1', { type: 'folder', url: '', title: 'Docs' })]);
    const result = matchExact(await snapOf(adapter, 'mount'), tree, ROOT);

    // 'deep' has the same title but sits under an unmatched parent.
    expect(result.matched).toHaveLength(0);
    expect(result.serverOnly.map((s) => s.id)).toEqual(['f1']);
    expect(countBrowserSubtree(result.browserOnly[0]!)).toBe(1); // 'deep' inside 'other'
  });

  it('reports unmatched canonical nodes as serverOnly', async () => {
    const adapter = new FakeBrowserAdapter();
    adapter.seed({ id: 'mount', parentId: '0', title: 'Sync' });
    adapter.seed({ id: 'k1', parentId: 'mount', title: 'x', url: 'https://n1.example.com' });

    const tree = treeOf([mk('n1'), mk('n2')]);
    const result = matchExact(await snapOf(adapter, 'mount'), tree, ROOT);

    expect(result.matched).toContainEqual({ browserId: 'k1', canonicalId: 'n1' });
    expect(result.serverOnly.map((s) => s.id)).toEqual(['n2']);
  });
});

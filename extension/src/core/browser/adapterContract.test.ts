// Browser Adapter contract (doc 05 §2): every implementation must satisfy
// the same rules, and those rules are the real browser's rules. Running one
// suite over both the Chromium wrapper and the in-memory fake is what stops
// a permissive double from hiding an API the production path cannot use.

import { describe, expect, it } from 'vitest';

import { createChromiumAdapter } from './chromium';
import { FakeBrowserAdapter } from './fakeAdapter';
import { removeByType, type BrowserAdapter } from './types';
import { createFakeChromeApi } from '../../testing/fakeChromeBookmarks';

interface AdapterImpl {
  name: string;
  /**
   * The tree a real profile starts with: a hidden root ('0') holding the two
   * permanent containers — the bar, which a mount points at, and "other
   * bookmarks", the second root a space can be placed in.
   */
  build(): {
    adapter: BrowserAdapter;
    rootId: string;
    otherRootId: string;
    hiddenRootId: string;
    /** A folder the browser added and policy froze. Returns its id. */
    seedManagedFolder(parentId: string, title: string): string;
  };
}

const impls: AdapterImpl[] = [
  {
    name: 'chromium',
    build: () => {
      const chrome = createFakeChromeApi();
      chrome.seedNode({ id: '0', title: '' });
      chrome.seedNode({ id: '1', parentId: '0', title: 'Bookmarks Bar', folderType: 'bookmarks-bar' });
      chrome.seedNode({ id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other' });
      let seeded = 500;
      return {
        adapter: createChromiumAdapter(chrome),
        rootId: '1',
        otherRootId: '2',
        hiddenRootId: '0',
        seedManagedFolder: (parentId, title) => {
          const id = String(seeded++);
          chrome.seedNode({ id, parentId, title, folderType: 'managed', unmodifiable: true });
          return id;
        },
      };
    },
  },
  {
    name: 'fake',
    build: () => {
      const adapter = new FakeBrowserAdapter();
      adapter.seed({ id: '0', parentId: null, title: '' });
      adapter.seed({ id: '1', parentId: '0', title: 'Bookmarks Bar', folderType: 'bookmarks-bar' });
      adapter.seed({ id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other' });
      let seeded = 500;
      return {
        adapter,
        rootId: '1',
        otherRootId: '2',
        hiddenRootId: '0',
        seedManagedFolder: (parentId, title) => {
          const id = `m${seeded++}`;
          adapter.seed({ id, parentId, title, folderType: 'managed', unmodifiable: true });
          return id;
        },
      };
    },
  },
];

for (const impl of impls) {
  describe(`BrowserAdapter contract (${impl.name})`, () => {
    it('resolves getNode for a known id and reports not-found as null', async () => {
      const { adapter, rootId } = impl.build();
      const created = await adapter.create(rootId, { title: 'GitHub', url: 'https://github.com' });
      expect(await adapter.getNode(created.id)).toMatchObject({ title: 'GitHub' });
      // An existence probe must not reject: recovery and delete both lean on it.
      expect(await adapter.getNode('no-such-node')).toBeNull();
    });

    it('creates folders and bookmarks by presence of a url', async () => {
      const { adapter, rootId } = impl.build();
      const folder = await adapter.create(rootId, { title: 'Work' });
      const bookmark = await adapter.create(rootId, { title: 'Site', url: 'https://site.test' });
      expect(folder.type).toBe('folder');
      expect(bookmark.type).toBe('bookmark');
      expect(await adapter.getChildren(rootId)).toHaveLength(2);
    });

    it('refuses to delete a non-empty folder with the bookmark verb', async () => {
      const { adapter, rootId } = impl.build();
      const folder = await adapter.create(rootId, { title: 'Nested' });
      await adapter.create(folder.id, { title: 'Leaf', url: 'https://leaf.test' });

      await expect(adapter.removeBookmark(folder.id)).rejects.toThrow();
      // The child must still be there: a partial deletion is worse than an error.
      expect(await adapter.getChildren(folder.id)).toHaveLength(1);
    });

    it('deletes a whole subtree with the subtree verb', async () => {
      const { adapter, rootId } = impl.build();
      const folder = await adapter.create(rootId, { title: 'Nested' });
      const child = await adapter.create(folder.id, { title: 'Leaf', url: 'https://leaf.test' });
      const grandchild = await adapter.create(child.id, { title: 'Deep', url: 'https://deep.test' });

      await adapter.removeSubtree(folder.id);

      expect(await adapter.getNode(folder.id)).toBeNull();
      expect(await adapter.getNode(child.id)).toBeNull();
      expect(await adapter.getNode(grandchild.id)).toBeNull();
      expect(await adapter.getChildren(rootId)).toHaveLength(0);
    });

    it('deletes a single bookmark without touching siblings', async () => {
      const { adapter, rootId } = impl.build();
      const a = await adapter.create(rootId, { title: 'A', url: 'https://a.test' });
      const b = await adapter.create(rootId, { title: 'B', url: 'https://b.test' });

      await adapter.removeBookmark(a.id);

      expect(await adapter.getNode(a.id)).toBeNull();
      expect(await adapter.getNode(b.id)).not.toBeNull();
    });

    it('rejects deleting an unknown id instead of ignoring it', async () => {
      const { adapter } = impl.build();
      await expect(adapter.removeBookmark('missing-node')).rejects.toThrow();
      await expect(adapter.removeSubtree('missing-node')).rejects.toThrow();
    });

    it('orders children by index after creates and moves', async () => {
      const { adapter, rootId } = impl.build();
      const a = await adapter.create(rootId, { title: 'A', url: 'https://a.test' });
      const b = await adapter.create(rootId, { title: 'B', url: 'https://b.test' });
      const c = await adapter.create(rootId, { title: 'C', url: 'https://c.test' });

      await adapter.move(c.id, rootId, 0);
      expect((await adapter.getChildren(rootId)).map((n) => n.title)).toEqual(['C', 'A', 'B']);

      await adapter.move(b.id, rootId, 1);
      expect((await adapter.getChildren(rootId)).map((n) => n.title)).toEqual(['C', 'B', 'A']);

      // A move to an out-of-range index appends rather than throws.
      await adapter.move(a.id, rootId, 99);
      expect((await adapter.getChildren(rootId)).map((n) => n.title)).toEqual(['C', 'B', 'A']);
      expect((await adapter.getChildren(rootId)).map((n) => n.id)).toContain(b.id);
    });

    it('creates at an explicit index and appends when omitted', async () => {
      const { adapter, rootId } = impl.build();
      const a = await adapter.create(rootId, { title: 'A', url: 'https://a.test' });
      const b = await adapter.create(rootId, { title: 'B', url: 'https://b.test' });

      const mid = await adapter.create(rootId, { title: 'Mid', url: 'https://mid.test', index: 1 });
      expect((await adapter.getChildren(rootId)).map((n) => n.title)).toEqual(['A', 'Mid', 'B']);

      await adapter.create(rootId, { title: 'Last', url: 'https://last.test' });
      expect((await adapter.getChildren(rootId)).map((n) => n.title)).toEqual(['A', 'Mid', 'B', 'Last']);

      // An out-of-range index clamps instead of rejecting.
      await adapter.create(rootId, { title: 'Far', url: 'https://far.test', index: 99 });
      expect((await adapter.getChildren(rootId)).map((n) => n.title)).toEqual(['A', 'Mid', 'B', 'Last', 'Far']);
      expect(await adapter.getNode(mid.id)).toMatchObject({ title: 'Mid' });
      expect(a.id).not.toBe(b.id);
    });

    it('renumbers the remaining siblings after a removal', async () => {
      const { adapter, rootId } = impl.build();
      const a = await adapter.create(rootId, { title: 'A', url: 'https://a.test' });
      await adapter.create(rootId, { title: 'B', url: 'https://b.test' });
      await adapter.create(rootId, { title: 'C', url: 'https://c.test' });

      await adapter.removeBookmark(a.id);

      const remaining = await adapter.getChildren(rootId);
      expect(remaining.map((n) => n.title)).toEqual(['B', 'C']);
      // Indices stay contiguous; gaps would make a later positional insert land wrong.
      expect(remaining.map((n) => n.index)).toEqual([0, 1]);
    });

    it('keeps browser ids opaque across the contract', async () => {
      const { adapter, rootId } = impl.build();
      // Browser ids come back from the browser and are only ever compared to
      // other browser ids; nothing here may assume they look like canonical UUIDs.
      const first = await adapter.create(rootId, { title: 'First', url: 'https://first.test' });
      const second = await adapter.create(rootId, { title: 'Second', url: 'https://second.test' });
      expect(first.id).not.toBe(second.id);
      expect(await adapter.getNode(second.id)).toMatchObject({ title: 'Second' });
    });

    it('keeps two bookmarks of one URL as two nodes', async () => {
      const { adapter, rootId } = impl.build();
      // A user with the same site in the bar and in a folder is the normal
      // case, not an edge one: the adapter may not collapse them, because the
      // only thing that distinguishes them is the browser id.
      const a = await adapter.create(rootId, { title: 'Same', url: 'https://same.test' });
      const b = await adapter.create(rootId, { title: 'Same', url: 'https://same.test' });
      expect(a.id).not.toBe(b.id);
      expect(await adapter.getChildren(rootId)).toHaveLength(2);

      await adapter.update(b.id, { title: 'Renamed' });
      expect((await adapter.getNode(a.id))?.title).toBe('Same');

      await adapter.removeBookmark(b.id);
      expect(await adapter.getNode(a.id)).not.toBeNull();
      expect(await adapter.getChildren(rootId)).toHaveLength(1);
    });

    it('keeps same-named folders addressable as separate subtrees', async () => {
      const { adapter, rootId } = impl.build();
      const one = await adapter.create(rootId, { title: 'Work' });
      const two = await adapter.create(rootId, { title: 'Work' });
      expect(one.id).not.toBe(two.id);

      const inside = await adapter.create(one.id, { title: 'Inside', url: 'https://inside.test' });
      expect((await adapter.getChildren(one.id)).map((n) => n.id)).toEqual([inside.id]);
      expect(await adapter.getChildren(two.id)).toHaveLength(0);

      await adapter.removeSubtree(two.id);
      expect(await adapter.getNode(one.id)).not.toBeNull();
      expect((await adapter.getChildren(one.id))[0]?.title).toBe('Inside');
    });

    it('carries an untitled folder as a node rather than dropping it', async () => {
      const { adapter, rootId } = impl.build();
      // A node with nothing to show for a title is how anything the API has no
      // kind for would reach us (a separator being the case in point). The
      // adapter has two classifications and no third: it must not swallow it.
      const anon = await adapter.create(rootId, { title: '' });
      expect(anon.type).toBe('folder');
      expect((await adapter.getChildren(rootId)).map((n) => n.id)).toContain(anon.id);
      expect(await adapter.getNode(anon.id)).toMatchObject({ title: '', type: 'folder' });
    });

    it('treats each browser container as its own parent', async () => {
      const { adapter, rootId, otherRootId } = impl.build();
      const inBar = await adapter.create(rootId, { title: 'Bar item', url: 'https://bar.test' });
      expect(await adapter.getChildren(otherRootId)).toHaveLength(0);

      await adapter.move(inBar.id, otherRootId, null);

      expect(await adapter.getChildren(rootId)).toHaveLength(0);
      expect((await adapter.getChildren(otherRootId)).map((n) => n.id)).toEqual([inBar.id]);
      expect(await adapter.getNode(inBar.id)).toMatchObject({ parentId: otherRootId });
    });

    it('refuses to rename, move or delete a folder the browser added', async () => {
      const { adapter, rootId, otherRootId } = impl.build();
      const kept = await adapter.create(rootId, { title: 'Mine', url: 'https://mine.test' });

      await expect(adapter.update(rootId, { title: 'My bar now' })).rejects.toThrow();
      await expect(adapter.move(rootId, otherRootId, 0)).rejects.toThrow();
      await expect(adapter.removeSubtree(rootId)).rejects.toThrow();
      await expect(adapter.removeBookmark(rootId)).rejects.toThrow();

      // Refusing is the whole point: the container and the user's item in it
      // are exactly where they were.
      expect(await adapter.getNode(rootId)).toMatchObject({ title: 'Bookmarks Bar' });
      expect((await adapter.getChildren(rootId)).map((n) => n.id)).toEqual([kept.id]);
    });

    it('refuses to add or remove entries in the hidden root folder', async () => {
      const { adapter, hiddenRootId, rootId } = impl.build();
      await expect(adapter.create(hiddenRootId, { title: 'Third bar' })).rejects.toThrow();
      await expect(adapter.removeSubtree(hiddenRootId)).rejects.toThrow();
      // Writing into a permanent container is still allowed — that is how any
      // sync at all happens.
      await expect(adapter.create(rootId, { title: 'Fine', url: 'https://fine.test' })).resolves.toBeTruthy();
    });

    it('hides a policy-managed folder from the walk and refuses to touch it', async () => {
      const { adapter, rootId, seedManagedFolder } = impl.build();
      const managedId = seedManagedFolder(rootId, 'Company bookmarks');
      const userItem = await adapter.create(rootId, { title: 'Ours', url: 'https://ours.test' });

      // The tree the sync works on holds what sync can change. Chrome lists
      // the folder, but every write into it is refused, so a walker that
      // returned it would map it and then fail on the first remote change.
      expect((await adapter.getChildren(rootId)).map((n) => n.id)).toEqual([userItem.id]);
      expect(await adapter.getNode(managedId)).toMatchObject({ unmodifiable: true });

      await expect(adapter.create(managedId, { title: 'Nope', url: 'https://nope.test' })).rejects.toThrow();
      await expect(adapter.update(managedId, { title: 'Renamed by us' })).rejects.toThrow();
      await expect(adapter.removeSubtree(managedId)).rejects.toThrow();
      expect(await adapter.getNode(managedId)).not.toBeNull();
    });
  });
}

describe('removeByType', () => {
  it('picks the subtree verb for folders', async () => {
    const calls: string[] = [];
    const adapter = {
      removeBookmark: async (id: string) => calls.push(`bookmark:${id}`),
      removeSubtree: async (id: string) => calls.push(`subtree:${id}`),
    } as unknown as BrowserAdapter;

    await removeByType(adapter, { id: 'f', type: 'folder' });
    await removeByType(adapter, { id: 'b', type: 'bookmark' });
    expect(calls).toEqual(['subtree:f', 'bookmark:b']);
  });
});

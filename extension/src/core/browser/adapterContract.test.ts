// Browser Adapter contract (doc 05 §2): every implementation must satisfy
// the same rules, and those rules are the real browser's rules. Running one
// suite over both the Chromium wrapper and the in-memory fake is what stops
// a permissive double from hiding an API the production path cannot use.

import { describe, expect, it } from 'vitest';

import { createChromiumAdapter } from './chromium';
import { FakeBrowserAdapter } from './fakeAdapter';
import { removeByType, type BrowserAdapter } from './types';
import { createFakeChromeApi, type FakeChrome } from '../../testing/fakeChromeBookmarks';

interface AdapterImpl {
  name: string;
  /** Return an adapter with a single empty root folder plus a handle on it. */
  build(): { adapter: BrowserAdapter; rootId: string; chrome?: FakeChrome };
}

const impls: AdapterImpl[] = [
  {
    name: 'chromium',
    build: () => {
      const chrome = createFakeChromeApi();
      chrome.seedNode({ id: '10', title: 'Bookmarks Bar' });
      return { adapter: createChromiumAdapter(chrome), rootId: '10', chrome };
    },
  },
  {
    name: 'fake',
    build: () => {
      const adapter = new FakeBrowserAdapter();
      adapter.seed({ id: 'root', parentId: null, title: 'Bookmarks Bar' });
      return { adapter, rootId: 'root' };
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

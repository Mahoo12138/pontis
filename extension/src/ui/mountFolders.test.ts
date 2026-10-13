// The mount picker reads this browser's real bookmark tree, so these run
// against the fake chrome.bookmarks — the one that rejects and hides things the
// way a real profile does — rather than an idealized list.

import { describe, expect, it } from 'vitest';
import { createChromiumAdapter } from '../core/browser/chromium';
import { createFakeChromeApi } from '../testing/fakeChromeBookmarks';
import { mountFolderTree } from './mountFolders';
import { countFolders, pathTitlesOf, type FolderTreeNode } from './folderTree';

function adapterWith(seed: Array<{ id: string; parentId?: string; title: string; url?: string; unmodifiable?: boolean }>) {
  const chrome = createFakeChromeApi();
  chrome.seedNode({ id: '0', title: '' });
  chrome.seedNode({ id: '1', parentId: '0', title: '书签栏' });
  chrome.seedNode({ id: '2', parentId: '0', title: '其他书签' });
  for (const node of seed) chrome.seedNode(node);
  return createChromiumAdapter(chrome);
}

/** `bar/baz` per level, so a nesting assertion reads as one string. */
const shape = (nodes: FolderTreeNode[]): string[] =>
  nodes.map((n) => (n.children.length ? `${n.title}/${shape(n.children).join(',')}` : n.title));

describe('mountFolderTree', () => {
  it("puts the browser's own containers on top and nests what hangs off them", async () => {
    const tree = await mountFolderTree(
      adapterWith([
        { id: 'a', parentId: '1', title: '开发' },
        { id: 'b', parentId: 'a', title: 'Go' },
      ]),
    );
    expect(shape(tree)).toEqual(['书签栏/开发/Go', '其他书签']);
  });

  it('counts the bookmarks sitting directly in each folder', async () => {
    const tree = await mountFolderTree(
      adapterWith([
        { id: 'l1', parentId: '1', title: 'one', url: 'https://a.test' },
        { id: 'l2', parentId: '1', title: 'two', url: 'https://b.test' },
        { id: 'a', parentId: '1', title: '开发' },
        { id: 'l3', parentId: 'a', title: 'three', url: 'https://c.test' },
      ]),
    );
    const bar = tree.find((n) => n.id === '1');
    expect(bar?.bookmarks).toBe(2);
    expect(bar?.children.find((n) => n.id === 'a')?.bookmarks).toBe(1);
  });

  it('never offers a folder the browser refuses to write to', async () => {
    const tree = await mountFolderTree(
      adapterWith([
        { id: 'locked', parentId: '1', title: '公司策略', unmodifiable: true },
        { id: 'inside', parentId: 'locked', title: '里面' },
      ]),
    );
    // Mounting onto something Chrome would reject every write against leaves a
    // binding that cannot sync a single node, so the whole subtree stays out.
    expect(countFolders(tree)).toBe(2);
    expect(pathTitlesOf(tree, 'locked')).toBeNull();
  });
});

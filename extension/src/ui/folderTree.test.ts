// A source has to be a folder, and the folder set arrives as one flat canonical
// snapshot. These cover the two ways a naive walk loses a folder the reader
// could legitimately pick: a parent that is not in this snapshot, and a parent
// chain that loops.

import { describe, expect, it } from 'vitest';
import type { SnapshotNodeWire } from '../core/protocol/types';
import {
  allFolders,
  ancestorIdsOf,
  buildFolderTree,
  buildFolderTreeFromEntries,
  countFolders,
  pathTitlesOf,
  type FolderTreeNode,
} from './folderTree';

const dir = (id: string, title: string, parent: string | null, position = 0): SnapshotNodeWire => ({
  id,
  type: 'folder',
  title,
  parent: parent ? { type: 'node', id: parent } : { type: 'root', key: 'main' },
  position,
});

const link = (id: string, parent: string): SnapshotNodeWire => ({
  id,
  type: 'bookmark',
  title: id,
  url: 'https://example.com',
  parent: { type: 'node', id: parent },
  position: 0,
});

/** `bar/baz` per level, so a nesting assertion reads as one string. */
const shape = (nodes: FolderTreeNode[]): string[] =>
  nodes.map((n) => (n.children.length ? `${n.id}/${shape(n.children).join(',')}` : n.id));

describe('buildFolderTree', () => {
  it('nests folders under their parent and leaves the root slots on top', () => {
    const tree = buildFolderTree([
      dir('bar', '工作', null),
      dir('baz', '项目', 'bar'),
      dir('other', '阅读', null, 1),
    ]);
    expect(shape(tree)).toEqual(['bar/baz', 'other']);
    expect(tree[0]?.children[0]?.title).toBe('项目');
  });

  it('orders siblings by position and keeps the id as the tiebreak', () => {
    const tree = buildFolderTree([
      dir('c', 'c', null, 5),
      dir('a', 'a', null, 1),
      dir('b', 'b', null, 1),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('counts only the direct bookmarks of a row', () => {
    const tree = buildFolderTree([
      dir('bar', '工作', null),
      dir('baz', '项目', 'bar'),
      link('l1', 'bar'),
      link('l2', 'bar'),
      link('l3', 'baz'),
    ]);
    expect(tree[0]?.bookmarks).toBe(2);
    expect(tree[0]?.children[0]?.bookmarks).toBe(1);
  });

  it('keeps a bookmark whose parent folder is absent out of every count', () => {
    const tree = buildFolderTree([dir('bar', '工作', null), link('l1', 'gone')]);
    expect(tree[0]?.bookmarks).toBe(0);
  });

  it('lifts a folder whose parent is not part of this snapshot to the top', () => {
    // A folder that moved out of the synced subtree still has to be pickable:
    // dropping it would silently shrink what the reader can choose (§6.5).
    const tree = buildFolderTree([dir('orphan', '孤儿', 'missing')]);
    expect(shape(tree)).toEqual(['orphan']);
  });

  it('shows both ends of a parent cycle instead of dropping them', () => {
    const tree = buildFolderTree([dir('a', 'a', 'b'), dir('b', 'b', 'a')]);
    expect(countFolders(tree)).toBe(2);
  });

  it('labels an unnamed folder instead of rendering a blank row', () => {
    const tree = buildFolderTree([dir('x', '', null)]);
    expect(tree[0]?.title).toBe('(未命名)');
  });
});

describe('ancestorIdsOf', () => {
  const tree = buildFolderTree([
    dir('bar', '工作', null),
    dir('baz', '项目', 'bar'),
    dir('deep', '深', 'baz'),
  ]);

  it('returns the chain above a folder, top first', () => {
    expect(ancestorIdsOf(tree, 'deep')).toEqual(['bar', 'baz']);
  });

  it('returns nothing for a top-level folder, an unknown id or no choice yet', () => {
    expect(ancestorIdsOf(tree, 'bar')).toEqual([]);
    expect(ancestorIdsOf(tree, 'nope')).toEqual([]);
    expect(ancestorIdsOf(tree, '')).toEqual([]);
  });
});

describe('buildFolderTreeFromEntries', () => {
  it('keeps the order the caller walked the folders in', () => {
    // The browser hands back children in its own order, and a picker that
    // reshuffled them would move rows out from under the pointer.
    const tree = buildFolderTreeFromEntries([
      { id: 'a', title: 'a', parent: null },
      { id: 'b', title: 'b', parent: 'a' },
      { id: 'c', title: 'c', parent: null },
    ]);
    expect(shape(tree)).toEqual(['a/b', 'c']);
  });

  it('leaves a bookmark count of zero where the caller had none', () => {
    const tree = buildFolderTreeFromEntries([{ id: 'a', title: 'a', parent: null }]);
    expect(tree[0]?.bookmarks).toBe(0);
  });
});

describe('allFolders', () => {
  it('lists every depth, parents before their children', () => {
    const tree = buildFolderTree([
      dir('bar', '工作', null),
      dir('baz', '项目', 'bar'),
      dir('deep', '深', 'baz'),
    ]);
    expect(allFolders(tree).map((n) => n.id)).toEqual(['bar', 'baz', 'deep']);
  });
});

describe('pathTitlesOf', () => {
  const tree = buildFolderTree([
    dir('bar', '工作', null),
    dir('baz', '项目', 'bar'),
    dir('deep', '深', 'baz'),
  ]);

  it('names the whole chain so a closed field can show where the source is', () => {
    expect(pathTitlesOf(tree, 'deep')).toEqual(['工作', '项目', '深']);
    expect(pathTitlesOf(tree, 'bar')).toEqual(['工作']);
  });

  it('says nothing rather than a partial path when the folder left the tree', () => {
    expect(pathTitlesOf(tree, 'gone')).toBeNull();
    expect(pathTitlesOf(tree, '')).toBeNull();
  });
});

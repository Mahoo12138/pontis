// The structure charts must not double-count. A recursive "largest folder"
// charges every ancestor for the same bookmarks, and a direct "per folder"
// count charges a wide subtree to its parent — so the two views deliberately
// use different notions of size, and each has to stay honest about which.

import { describe, expect, it } from 'vitest';
import { buildTreeIndex } from '../explorer/tree';
import type { TreeIndex } from '../explorer/tree';
import type { Node } from '@pontis/api';
import { mkBookmark, mkFolder } from './fixtures';
import {
  depthHistogram,
  duplicateFolderNames,
  emptyFolders,
  folderStats,
  largestFolders,
  pathOf,
  perFolderBuckets,
  rootOrphans,
  singletonFolders,
  structureSummary,
} from './structure';

/**
 * dev/            folder, 4 bookmarks in subtree + 1 direct
 *   go/           folder with 3 bookmarks
 * empty/          folder with nothing
 * loose           bookmark at the root
 */
function sample(): { nodes: Node[]; index: TreeIndex } {
  const nodes = [
    mkFolder('dev', null),
    mkFolder('go', 'dev'),
    mkBookmark('b1', 'https://go.dev/a', 'go'),
    mkBookmark('b2', 'https://go.dev/b', 'go'),
    mkBookmark('b3', 'https://pkg.go.dev/x', 'dev'),
    mkBookmark('b4', 'https://go.dev/c', 'go'),
    mkFolder('empty', null),
    mkBookmark('loose', 'https://example.com', null),
  ];
  return { nodes, index: buildTreeIndex(nodes) };
}

describe('pathOf', () => {
  it('lists titles from the top-level ancestor down, inclusive', () => {
    const { index } = sample();
    expect(pathOf(index, 'b1')).toEqual(['dev', 'go', 'b1']);
  });

  it('returns just the title for a root-level node', () => {
    const { index } = sample();
    expect(pathOf(index, 'empty')).toEqual(['empty']);
  });
});

describe('folderStats', () => {
  it('counts bookmarks recursively', () => {
    const { index } = sample();
    const dev = folderStats(index).find((f) => f.node.id === 'dev');
    expect(dev?.bookmarks).toBe(4); // b1 b2 b4 under go/, plus b3
    expect(dev?.folders).toBe(1);
  });

  it('separates direct from recursive bookmarks', () => {
    const { index } = sample();
    const dev = folderStats(index).find((f) => f.node.id === 'dev');
    expect(dev?.directBookmarks).toBe(1); // only b3
  });
});

describe('largestFolders', () => {
  it('ranks by recursive count and truncates', () => {
    const { index } = sample();
    expect(largestFolders(index, 1).map((f) => f.node.id)).toEqual(['dev']);
  });

  it('leaves empty folders out, since they are a different finding', () => {
    const { index } = sample();
    expect(largestFolders(index, 50).map((f) => f.node.id)).not.toContain('empty');
  });
});

describe('emptyFolders', () => {
  it('finds folders with nothing anywhere below', () => {
    const { index } = sample();
    expect(emptyFolders(index).map((f) => f.node.id)).toEqual(['empty']);
  });
});

describe('singletonFolders', () => {
  it('flags a folder whose only child is another folder', () => {
    const { index } = sample();
    const nodes = [...index.byId.values(), mkFolder('wrapper', null), mkFolder('inner', 'wrapper')];
    const wide = buildTreeIndex(nodes);
    expect(singletonFolders(wide).map((f) => f.node.id)).toEqual(['wrapper']);
    expect(singletonFolders(index).map((f) => f.node.id)).not.toContain('dev');
  });

  it('does not flag a folder holding one bookmark and one subfolder', () => {
    const { index } = sample();
    expect(singletonFolders(index).map((f) => f.node.id)).not.toContain('go');
  });
});

describe('rootOrphans', () => {
  it('counts nodes hanging directly off a root slot', () => {
    const { index } = sample();
    expect(rootOrphans(index)).toEqual({ bookmarks: 1, folders: 2 });
  });
});

describe('depthHistogram', () => {
  it('starts at depth 1 and separates types', () => {
    const { index } = sample();
    const histogram = depthHistogram(index);
    expect(histogram[0]).toEqual({ depth: 1, folders: 2, bookmarks: 1 });
    expect(histogram[1]).toEqual({ depth: 2, folders: 1, bookmarks: 1 });
    expect(histogram[2]).toEqual({ depth: 3, folders: 0, bookmarks: 3 });
  });
});

describe('perFolderBuckets', () => {
  it('bands by direct bookmark count, always reporting every band', () => {
    const { index } = sample();
    const buckets = perFolderBuckets(index);
    expect(buckets.map((b) => b.label)).toEqual(['0', '1', '2–5', '6–20', '21–50', '51+']);
    // empty=0 direct, dev=1 direct, go=3 direct
    expect(buckets.find((b) => b.label === '0')?.count).toBe(1);
    expect(buckets.find((b) => b.label === '1')?.count).toBe(1);
    expect(buckets.find((b) => b.label === '2–5')?.count).toBe(1);
  });

  it('puts anything past the last edge in the open tail', () => {
    const many = Array.from({ length: 60 }, (_, i) => mkBookmark(`x${i}`, `https://a.test/${i}`, 'big'));
    const index = buildTreeIndex([mkFolder('big', null), ...many]);
    expect(perFolderBuckets(index).find((b) => b.label === '51+')?.count).toBe(1);
  });
});

describe('duplicateFolderNames', () => {
  it('reports only siblings sharing a title', () => {
    const index = buildTreeIndex([
      mkFolder('a', null),
      mkFolder('misc', 'a'),
      mkFolder('misc', 'a'),
      mkFolder('b', null),
      mkFolder('misc', 'b'),
    ]);
    const collisions = duplicateFolderNames(index);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.name).toBe('misc');
    expect(collisions[0]?.items).toHaveLength(2);
  });
});

describe('structureSummary', () => {
  it('reports totals, deepest level and unfiled bookmarks', () => {
    const { nodes, index } = sample();
    expect(structureSummary(nodes, index)).toEqual({
      bookmarks: 5,
      folders: 3,
      maxDepth: 3,
      unfiled: 1,
    });
  });

  it('survives an empty space without a phantom depth', () => {
    expect(structureSummary([], buildTreeIndex([])).maxDepth).toBe(0);
  });
});

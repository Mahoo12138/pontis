// The explorer projects a flat node list into an ordered tree. The order the
// user sees must come from `position`, not from the arrival order of the API
// rows, and no node may vanish because its parent is not in the list.

import { describe, expect, it } from 'vitest';
import { buildTreeIndex, flattenVisible } from './tree';
import type { Node } from '@pontis/api';

function node(over: Partial<Node> & { id: string }): Node {
  return {
    space_id: 'space_1',
    type: 'bookmark',
    title: over.id,
    url: `https://${over.id}.example.com`,
    parent_id: null,
    root_key: null,
    position: 0,
    created_revision: 1,
    title_revision: 1,
    url_revision: 1,
    structure_revision: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const folder = (id: string, parent_id: string | null, position: number) =>
  node({ id, type: 'folder', parent_id, position });

const titles = (rows: { node: Node }[]) => rows.map((r) => r.node.title);

describe('buildTreeIndex', () => {
  it('orders siblings by position, not by arrival order', () => {
    const index = buildTreeIndex([
      node({ id: 'c', parent_id: 'f', position: 2 }),
      node({ id: 'a', parent_id: 'f', position: 0 }),
      node({ id: 'b', parent_id: 'f', position: 1 }),
      folder('f', null, 0),
    ]);

    expect(index.childrenOf('f').map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders roots by position', () => {
    const index = buildTreeIndex([
      folder('second', null, 1),
      folder('first', null, 0),
      folder('third', null, 2),
    ]);

    expect(index.roots.map((n) => n.id)).toEqual(['first', 'second', 'third']);
  });

  it('surfaces a node whose parent is missing instead of dropping it', () => {
    const index = buildTreeIndex([node({ id: 'orphan', parent_id: 'gone', position: 0 })]);

    expect(index.roots.map((n) => n.id)).toEqual(['orphan']);
    expect(index.parentOf.get('orphan')).toBeNull();
  });
});

describe('flattenVisible', () => {
  // main/ (reading: Example, Spec) + a top-level bookmark.
  const tree = buildTreeIndex([
    folder('main', null, 0),
    folder('reading', 'main', 0),
    node({ id: 'example', parent_id: 'reading', position: 0, title: 'Example' }),
    node({ id: 'spec', parent_id: 'reading', position: 1, title: 'Spec' }),
    node({ id: 'loose', parent_id: null, position: 1, title: 'Loose' }),
  ]);

  it('hides a folder subtree until the folder is expanded', () => {
    expect(titles(flattenVisible(tree, new Set(), 'all'))).toEqual(['main', 'Loose']);
    expect(titles(flattenVisible(tree, new Set(['main']), 'all'))).toEqual([
      'main',
      'reading',
      'Loose',
    ]);
    expect(titles(flattenVisible(tree, new Set(['main', 'reading']), 'all'))).toEqual([
      'main',
      'reading',
      'Example',
      'Spec',
      'Loose',
    ]);
  });

  it('reports the depth of each visible row', () => {
    const rows = flattenVisible(tree, new Set(['main', 'reading']), 'all');
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 0]);
  });

  it('counts children even while they are collapsed', () => {
    const rows = flattenVisible(tree, new Set(), 'all');
    const main = rows.find((r) => r.node.id === 'main');
    expect(main?.childCount).toBe(1);
  });

  it('lists every bookmark flat under the bookmarks filter', () => {
    const rows = flattenVisible(tree, new Set(), 'bookmarks');
    expect(titles(rows)).toEqual(['Example', 'Spec', 'Loose']);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it('keeps folders but drops bookmark rows under the folders filter', () => {
    const rows = flattenVisible(tree, new Set(['main']), 'folders');
    expect(titles(rows)).toEqual(['main', 'reading']);
  });
});

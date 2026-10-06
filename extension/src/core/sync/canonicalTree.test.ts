// Canonical tree replay tests: journal semantics must reconstruct the
// server tree faithfully (create/move/update/delete, root vs node
// parents, position ordering, subtree deletes).

import { describe, expect, it } from 'vitest';
import { canonicalChildren, countSubtree, replayChanges } from './canonicalTree';
import type { ChangeWire } from '../protocol/types';

const create = (revision: number, id: string, over: Partial<ChangeWire['payload'] & { title: string; url: string }> = {}): ChangeWire => ({
  revision,
  type: 'create',
  node_id: id,
  payload: {
    type: 'bookmark',
    title: over.title ?? `T ${id}`,
    url: over.url ?? `https://${id}.example.com`,
    parent: { type: 'root', key: 'main' },
    position: revision,
    ...over,
  } as ChangeWire['payload'],
});

describe('canonicalTree replay', () => {
  it('replays creates and orders children by position', () => {
    const tree = replayChanges([
      create(1, 'n1'),
      create(2, 'n2'),
      create(3, 'n3'),
    ]);
    expect(tree.nodes.size).toBe(3);
    const kids = canonicalChildren(tree, { type: 'root', key: 'main' });
    expect(kids.map((k) => k.id)).toEqual(['n1', 'n2', 'n3']);
    expect(countSubtree(tree, { type: 'root', key: 'main' })).toBe(3);
  });

  it('applies update_title / update_url / move', () => {
    const folder = create(1, 'f1', { type: 'folder', url: '', title: 'Docs' });
    const tree = replayChanges([
      folder,
      create(2, 'n1'),
      { revision: 3, type: 'move', node_id: 'n1', payload: { parent: { type: 'node', id: 'f1' }, position: 0 } },
      { revision: 4, type: 'update_title', node_id: 'n1', payload: { title: 'Renamed' } },
      { revision: 5, type: 'update_url', node_id: 'n1', payload: { url: 'https://new.example.com' } },
    ]);
    const n1 = tree.nodes.get('n1')!;
    expect(n1.title).toBe('Renamed');
    expect(n1.url).toBe('https://new.example.com');
    expect(n1.parent).toEqual({ type: 'node', id: 'f1' });
    const underFolder = canonicalChildren(tree, { type: 'node', id: 'f1' });
    expect(underFolder.map((k) => k.id)).toEqual(['n1']);
  });

  it('removes the whole canonical subtree on delete', () => {
    const tree = replayChanges([
      create(1, 'f1', { type: 'folder', url: '', title: 'Docs' }),
      create(2, 'f2', { type: 'folder', url: '', title: 'Nested', parent: { type: 'node', id: 'f1' } } as never),
      create(3, 'n1', { parent: { type: 'node', id: 'f2' } } as never),
      create(4, 'n2'),
      { revision: 5, type: 'delete', node_id: 'f1', payload: { count: 3 } },
    ]);
    expect(tree.nodes.has('f1')).toBe(false);
    expect(tree.nodes.has('f2')).toBe(false);
    expect(tree.nodes.has('n1')).toBe(false);
    expect(tree.nodes.has('n2')).toBe(true);
  });

  it('ignores deletes of unknown nodes', () => {
    const tree = replayChanges([create(1, 'n1'), { revision: 2, type: 'delete', node_id: 'ghost', payload: { count: 1 } }]);
    expect(tree.nodes.size).toBe(1);
  });
});

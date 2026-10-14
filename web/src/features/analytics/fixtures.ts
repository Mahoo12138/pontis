/**
 * Node fixtures shared by the analytics suites.
 *
 * `Node` has twelve required fields, and six suites each writing the same
 * factory would be six chances to drift from the contract.
 */
import type { Node } from '@pontis/api';

export function mkNode(over: Partial<Node> & { id: string }): Node {
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

export function mkFolder(id: string, parent_id: string | null, position = 0): Node {
  return mkNode({ id, type: 'folder', url: null, parent_id, position });
}

export function mkBookmark(id: string, url: string, parent_id: string | null = null): Node {
  return mkNode({ id, url, parent_id });
}

/**
 * A bookmark carrying `date_added`.
 *
 * Cast rather than declared: the field is not on the `Node` contract until the
 * server emits it, and declaring it early would make every node in every space
 * fail `checkNode` (see `dateAddedOf` in timeline.ts).
 */
export function mkDated(
  id: string,
  dateAdded: string | null,
  url = `https://${id}.test`,
  parent_id: string | null = null,
): Node {
  return { ...mkNode({ id, url, parent_id }), date_added: dateAdded } as Node;
}

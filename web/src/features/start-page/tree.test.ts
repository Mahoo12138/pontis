// The start page reads one flat list and shows one level of it. These tests
// hold the two things the page must never get wrong: it cannot climb above the
// source it was given, and it does not reorder what the workbench ordered.

import { describe, expect, it } from 'vitest';
import type { StartPageSnapshot, StartPageSnapshotNode } from '@pontis/api';
import { buildSourceTree, resolveCurrentFolder, searchSource } from './tree';

function node(
  id: string,
  parentId: string,
  title: string,
  position: number,
  url?: string,
): StartPageSnapshotNode {
  return {
    id,
    type: url ? 'bookmark' : 'folder',
    parent_id: parentId,
    title,
    url,
    position,
    updated_at: '2026-10-12T08:00:00Z',
  };
}

function snapshotOf(nodes: StartPageSnapshotNode[]): StartPageSnapshot {
  return {
    schema_version: 1,
    instance_id: 'instance-1',
    user_id: 'user-1',
    source: {
      grant_id: 'grant-1',
      device_id: 'dev-1',
      space_id: 'space-1',
      space_name: '个人',
      folder_id: 'source',
      folder_title: '日常入口',
      grant_version: 1,
    },
    snapshot: {
      epoch: 1,
      revision: 10,
      captured_at: '2026-10-12T08:00:00Z',
      complete: true,
      source_title: '日常入口',
    },
    nodes,
  };
}

describe('buildSourceTree', () => {
  it('keeps siblings in the order the workbench left them', () => {
    const tree = buildSourceTree(
      snapshotOf([
        node('b', 'source', 'Beta', 1, 'https://b.example'),
        node('a', 'source', 'Alpha', 0, 'https://a.example'),
        node('c', 'source', 'Gamma', 2, 'https://c.example'),
      ]),
    );
    // Folders are not pulled to the front and titles are not sorted: a start
    // page with its own order is a second tree to maintain (§6.2).
    expect(tree.childrenOf('source').map((n) => n.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('does not put folders first', () => {
    const tree = buildSourceTree(
      snapshotOf([
        node('mark', 'source', 'GitHub', 0, 'https://github.com/'),
        node('dir', 'source', '工具', 1),
      ]),
    );
    expect(tree.childrenOf('source').map((n) => n.id)).toEqual(['mark', 'dir']);
  });

  it('settles a duplicated position by node id instead of arrival order', () => {
    const a = node('zz', 'source', 'Same', 4, 'https://a.example');
    const b = node('aa', 'source', 'Same', 4, 'https://b.example');
    const first = buildSourceTree(snapshotOf([a, b])).childrenOf('source').map((n) => n.id);
    const second = buildSourceTree(snapshotOf([b, a])).childrenOf('source').map((n) => n.id);
    expect(first).toEqual(second);
  });

  it('shows only the current level', () => {
    const tree = buildSourceTree(
      snapshotOf([
        node('dir', 'source', '开发', 0),
        node('deep', 'dir', 'Go', 0, 'https://go.dev'),
      ]),
    );
    expect(tree.childrenOf('source').map((n) => n.id)).toEqual(['dir']);
    expect(tree.childrenOf('dir').map((n) => n.id)).toEqual(['deep']);
  });

  it('will not list a folder that is not inside the source', () => {
    const tree = buildSourceTree(snapshotOf([node('dir', 'source', '开发', 0)]));
    // An id from another part of the account's tree — or another account.
    expect(tree.contains('elsewhere')).toBe(false);
    expect(tree.childrenOf('elsewhere')).toEqual([]);
  });

  it('paths a node from the source down, not from the space root', () => {
    const tree = buildSourceTree(
      snapshotOf([
        node('work', 'source', '工作', 0),
        node('team', 'work', '团队', 0),
        node('wiki', 'team', 'Wiki', 0, 'https://wiki.example'),
      ]),
    );
    // The chain stops above the node: the breadcrumb adds the current folder
    // itself, and a search row shows its own title already.
    expect(tree.pathOf('wiki').map((n) => n.title)).toEqual(['日常入口', '工作', '团队']);
    expect(tree.pathOf('team').map((n) => n.id)).toEqual(['source', 'work']);
  });
});

describe('resolveCurrentFolder', () => {
  it('keeps a position that is still inside the source', () => {
    const tree = buildSourceTree(snapshotOf([node('dir', 'source', '开发', 0)]));
    expect(resolveCurrentFolder(tree, 'dir')).toEqual({ id: 'dir', lost: false });
  });

  it('returns to the source when the folder left it, and says so', () => {
    const before = buildSourceTree(
      snapshotOf([node('dir', 'source', '开发', 0), node('kid', 'dir', 'Go', 0, 'https://go.dev')]),
    );
    expect(resolveCurrentFolder(before, 'dir').id).toBe('dir');

    // The refresh moved 开发 out from under 日常入口.
    const after = buildSourceTree(
      snapshotOf([node('dir', 'other', '开发', 0), node('kid', 'dir', 'Go', 0, 'https://go.dev')]),
    );
    expect(resolveCurrentFolder(after, 'dir')).toEqual({ id: 'source', lost: true });
  });
});

describe('searchSource', () => {
  const fixture = () =>
    snapshotOf([
      node('exact', 'source', 'git', 0, 'https://exact.example'),
      node('g', 'source', 'GitHub', 1, 'https://github.com/'),
      node('dir', 'source', '开发', 2),
      node('mixed', 'dir', 'My git tools', 0, 'https://mixed.example'),
      node('wiki', 'dir', ' Handbook ', 1, 'https://git.internal/wiki'),
      node('unrelated', 'dir', 'Notes', 2, 'https://notes.example'),
    ]);
  const tree = () => buildSourceTree(fixture());

  it('ranks exact title, then prefix, then contains, then url', () => {
    const hits = searchSource(tree(), 'git');
    expect(hits.map((h) => [h.node.id, h.tier] as const)).toEqual([
      ['exact', 'title-exact'],
      ['g', 'title-prefix'],
      ['mixed', 'title-contains'],
      ['wiki', 'url-contains'],
    ]);
  });

  it('searches the whole source, not the folder on screen', () => {
    // 'mixed' and 'wiki' sit one level below the source.
    expect(searchSource(tree(), 'git').some((h) => h.node.id === 'mixed')).toBe(true);
  });

  it('reports where a hit lives relative to the source', () => {
    expect(searchSource(tree(), 'mixed').at(0)?.trail).toEqual(['开发']);
    expect(searchSource(tree(), 'g').at(0)?.trail).toEqual([]);
  });

  it('folds case for matching without rewriting the value', () => {
    const hit = searchSource(tree(), 'GITHUB').at(0);
    expect(hit?.node.url).toBe('https://github.com/');
    expect(hit?.node.title).toBe('GitHub');
  });

  it('answers nothing for an empty query', () => {
    // An empty box is not a search for "everything".
    expect(searchSource(tree(), '   ')).toEqual([]);
  });

  it('caps how much it hands the page', () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      node(`n${i}`, 'source', `note ${i}`, i, 'https://note.example'),
    );
    expect(searchSource(buildSourceTree(snapshotOf(many)), 'note')).toHaveLength(100);
  });
});

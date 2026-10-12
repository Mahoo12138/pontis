// The parser is the boundary between "the server answered" and "this build may
// render it". Everything it refuses here is a body that would otherwise be
// installed over a good cache and shown as the folder as it is (§13.3, §14.3).

import { describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOT_NODES,
  StartPageShapeError,
  parseStartPageFolders,
  parseStartPageSnapshot,
  parseStartPageSource,
} from './wire';

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    instance_id: 'instance-1',
    user_id: 'user-1',
    source: {
      grant_id: 'grant-1',
      device_id: 'dev-1',
      space_id: 'space-1',
      space_name: '个人',
      folder_id: 'folder-1',
      folder_title: '日常入口',
      grant_version: 1,
    },
    snapshot: { epoch: 1, revision: 10, captured_at: 'x', complete: true, source_title: '日常入口' },
    nodes: [
      { id: 'bm-1', type: 'bookmark', parent_id: 'folder-1', title: 'GitHub', url: 'https://github.com/', position: 0, updated_at: 'x' },
    ],
    ...over,
  };
}

describe('parseStartPageSnapshot', () => {
  it('accepts what the server really sends', () => {
    const parsed = parseStartPageSnapshot(body());
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.snapshot.revision).toBe(10);
  });

  it('accepts an empty folder as an empty list', () => {
    // SP-02: nothing in the folder is a fact about the folder, not a failure.
    expect(parseStartPageSnapshot(body({ nodes: [] })).nodes).toEqual([]);
  });

  it('refuses a missing or null node list', () => {
    for (const nodes of [null, undefined, {}, 'x']) {
      expect(() => parseStartPageSnapshot(body({ nodes }))).toThrow(StartPageShapeError);
    }
  });

  it('refuses a schema it does not know', () => {
    expect(() => parseStartPageSnapshot(body({ schema_version: 2 }))).toThrow(/schema_version/);
  });

  it('refuses a snapshot the server itself calls incomplete', () => {
    const partial = body();
    (partial.snapshot as Record<string, unknown>).complete = false;
    // Rendering a partial tree as "this folder" is the one thing this
    // projection may not do, even when the sender admits it.
    expect(() => parseStartPageSnapshot(partial)).toThrow(/not complete/);
  });

  it('refuses watermarks that arrived as text', () => {
    const drifted = body();
    (drifted.snapshot as Record<string, unknown>).revision = '10';
    expect(() => parseStartPageSnapshot(drifted)).toThrow(/revision must be a number/);
  });

  it('refuses a node whose parent is not in the source', () => {
    const torn = body({
      nodes: [{ id: 'x', type: 'bookmark', parent_id: 'elsewhere', title: 'Orphan', url: 'https://x.example', position: 0, updated_at: 'x' }],
    });
    expect(() => parseStartPageSnapshot(torn)).toThrow(/parent outside the source/);
  });

  it('refuses a node type this page cannot draw', () => {
    const odd = body({
      nodes: [{ id: 'x', type: 'separator', parent_id: 'folder-1', title: '—', position: 0, updated_at: 'x' }],
    });
    expect(() => parseStartPageSnapshot(odd)).toThrow(/folder or bookmark/);
  });

  it('refuses a subtree over the node budget', () => {
    const nodes = Array.from({ length: MAX_SNAPSHOT_NODES + 1 }, (_, i) => ({
      id: `n${i}`,
      type: 'bookmark',
      parent_id: 'folder-1',
      title: 't',
      url: 'https://e.example',
      position: i,
      updated_at: 'x',
    }));
    // Refused rather than trimmed: the first 10,000 of a folder are not that
    // folder (§18).
    expect(() => parseStartPageSnapshot(body({ nodes }))).toThrow(/over the/);
  });
});

describe('parseStartPageSource', () => {
  it('names the source a snapshot describes', () => {
    const source = parseStartPageSource(body().source);
    expect(source).toEqual({
      space_id: 'space-1',
      space_name: '个人',
      folder_id: 'folder-1',
      folder_title: '日常入口',
    });
  });

  it('refuses a source missing either half of its identity', () => {
    // A folder id with no space id could not be re-read: the next request
    // would have to guess which space the device means.
    expect(() => parseStartPageSource({ space_name: 'a', folder_title: 'b' })).toThrow(/space_id must be a string/);
    expect(() => parseStartPageSource({ space_id: 's', space_name: 'a', folder_title: 'b' })).toThrow(
      /folder_id must be a string/,
    );
  });
});

describe('parseStartPageFolders', () => {
  const nodes = [
    { id: 'f1', type: 'folder', title: '开发', parent_id: null, root_key: 'main' },
    { id: 'b1', type: 'bookmark', title: 'GitHub', parent_id: 'f1', url: 'https://github.com/' },
    { id: 'f2', type: 'folder', title: '工具', parent_id: 'f1' },
  ];

  it('offers only the folders, and says which are at the top', () => {
    const folders = parseStartPageFolders({ nodes });
    expect(folders.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(folders[0]?.parent_id).toBeNull();
    expect(folders[1]?.parent_id).toBe('f1');
  });

  it('refuses a body with no node list rather than calling it empty', () => {
    // "This account has no folders" and "the read did not answer" lead to
    // different actions in the picker (§8.2).
    expect(() => parseStartPageFolders({})).toThrow(StartPageShapeError);
    expect(() => parseStartPageFolders({ nodes: null })).toThrow(StartPageShapeError);
  });
});

// The start page's read-only wire shapes, mirroring
// server/internal/httpapi/startpage.go. Field names are snake_case on the wire.
//
// This is a projection, not a replica: it carries no watermark the extension
// may advance, and nothing here is accepted as an input to sync (§11.1).

export interface StartPageSourceWire {
  grant_id: string;
  device_id: string;
  space_id: string;
  space_name: string;
  folder_id: string;
  folder_title: string;
  grant_version: number;
}

export interface StartPageSnapshotNodeWire {
  id: string;
  type: 'folder' | 'bookmark';
  parent_id: string;
  title: string;
  url?: string;
  position: number;
  child_count?: number;
  updated_at: string;
}

export interface StartPageSnapshotWire {
  schema_version: number;
  instance_id: string;
  user_id: string;
  source: StartPageSourceWire;
  snapshot: {
    epoch: number;
    revision: number;
    captured_at: string;
    complete: boolean;
    source_title: string;
  };
  nodes: StartPageSnapshotNodeWire[];
}

export class StartPageShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartPageShapeError';
  }
}

/** The budgets the server refuses beyond (§18). Checked on the client too: a
 * snapshot that arrived intact but is not what this page may render must not
 * be installed, because rendering it would present a partial tree as a folder
 * read whole. */
export const MAX_SNAPSHOT_NODES = 10_000;
export const MAX_SNAPSHOT_BYTES = 8 << 20;

/** The one schema this extension build knows how to read. */
export const START_PAGE_SCHEMA_VERSION = 1;

function field(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StartPageShapeError(`start-page body must be an object, got ${preview(value)}`);
  }
  return value as Record<string, unknown>;
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function wantString(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new StartPageShapeError(`${at} must be a string, got ${preview(value)}`);
  return value;
}

function wantNumber(value: unknown, at: string): number {
  // A watermark that arrives as "18320" would compare against a number
  // somewhere else and lose; the server sends integers and this holds it to
  // that.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StartPageShapeError(`${at} must be a number, got ${preview(value)}`);
  }
  return value;
}

function wantBoolean(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') throw new StartPageShapeError(`${at} must be a boolean, got ${preview(value)}`);
  return value;
}

export function parseStartPageSource(json: unknown): StartPageSourceWire {
  const body = field(json);
  return {
    grant_id: wantString(body.grant_id, 'source.grant_id'),
    device_id: wantString(body.device_id, 'source.device_id'),
    space_id: wantString(body.space_id, 'source.space_id'),
    space_name: wantString(body.space_name, 'source.space_name'),
    folder_id: wantString(body.folder_id, 'source.folder_id'),
    folder_title: wantString(body.folder_title, 'source.folder_title'),
    grant_version: wantNumber(body.grant_version, 'source.grant_version'),
  };
}

/**
 * Assert a snapshot body is one this page may install.
 *
 * Everything the cache-first provider needs in order to refuse is checked
 * here: identity fields, the watermarks it will key expiry on, the node list's
 * shape, and the two budgets. A body that fails is never written, so the last
 * good snapshot stays in place rather than being replaced by a broken one
 * (§13.3, SP-15).
 */
export function parseStartPageSnapshot(json: unknown): StartPageSnapshotWire {
  const body = field(json);
  const version = wantNumber(body.schema_version, 'schema_version');
  if (version !== START_PAGE_SCHEMA_VERSION) {
    throw new StartPageShapeError(`unsupported start-page schema_version ${version}`);
  }
  const source = parseStartPageSource(body.source);
  const meta = field(body.snapshot);
  const complete = wantBoolean(meta.complete, 'snapshot.complete');
  // `complete: false` is the server saying it could not read the whole folder.
  // V1 has no partial-snapshot protocol, so such a body is refused outright.
  if (!complete) throw new StartPageShapeError('snapshot is not complete; this build cannot render a partial source');

  if (!Array.isArray(body.nodes)) {
    throw new StartPageShapeError(`nodes must be an array, got ${preview(body.nodes)}`);
  }
  const rawNodes = body.nodes as unknown[];
  if (rawNodes.length > MAX_SNAPSHOT_NODES) {
    throw new StartPageShapeError(`snapshot holds ${rawNodes.length} nodes, over the ${MAX_SNAPSHOT_NODES} budget`);
  }

  let bytes = 0;
  const nodes: StartPageSnapshotNodeWire[] = rawNodes.map((entry, i) => {
    const n = field(entry);
    const type = wantString(n.type, `nodes[${i}].type`);
    if (type !== 'folder' && type !== 'bookmark') {
      throw new StartPageShapeError(`nodes[${i}].type must be folder or bookmark, got ${preview(type)}`);
    }
    const title = wantString(n.title, `nodes[${i}].title`);
    const url = n.url === undefined ? undefined : wantString(n.url, `nodes[${i}].url`);
    bytes += title.length + (url?.length ?? 0) + 96;
    return {
      id: wantString(n.id, `nodes[${i}].id`),
      type,
      parent_id: wantString(n.parent_id, `nodes[${i}].parent_id`),
      title,
      url,
      position: wantNumber(n.position, `nodes[${i}].position`),
      child_count: n.child_count === undefined ? undefined : wantNumber(n.child_count, `nodes[${i}].child_count`),
      updated_at: wantString(n.updated_at, `nodes[${i}].updated_at`),
    };
  });
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new StartPageShapeError(`snapshot payload is ${bytes} bytes, over the ${MAX_SNAPSHOT_BYTES} budget`);
  }

  // A node whose parent is neither the source nor another node in the body
  // would be unreachable from the page's own root — a tree that does not hang
  // together, which is what "the folder as it is" is supposed to mean.
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (n.parent_id !== source.folder_id && !ids.has(n.parent_id)) {
      throw new StartPageShapeError(`node ${n.id} has a parent outside the source subtree`);
    }
  }

  return {
    schema_version: version,
    instance_id: wantString(body.instance_id, 'instance_id'),
    user_id: wantString(body.user_id, 'user_id'),
    source,
    snapshot: {
      epoch: wantNumber(meta.epoch, 'snapshot.epoch'),
      revision: wantNumber(meta.revision, 'snapshot.revision'),
      captured_at: wantString(meta.captured_at, 'snapshot.captured_at'),
      complete,
      source_title: wantString(meta.source_title, 'snapshot.source_title'),
    },
    nodes,
  };
}

/** A folder as the source picker sees it: one row of the account's own tree,
 * read through the session rather than through the device grant. */
export interface StartPageFolderWire {
  id: string;
  title: string;
  /** null when the folder hangs off a root slot, i.e. it is at the top. */
  parent_id: string | null;
}

/**
 * Pick the folder rows out of a `GET /spaces/{id}/nodes` body.
 *
 * The endpoint answers with the whole space, so this is the only place the
 * picker learns what a folder is; a body whose rows cannot be read is refused
 * rather than shown as an empty list, because "this account has no folders"
 * and "the read did not come back" lead to different actions (§8.2).
 */
export function parseStartPageFolders(json: unknown): StartPageFolderWire[] {
  const body = field(json);
  if (!Array.isArray(body.nodes)) {
    throw new StartPageShapeError(`node list must carry a nodes array, got ${preview(body.nodes)}`);
  }
  const out: StartPageFolderWire[] = [];
  for (const entry of body.nodes as unknown[]) {
    const n = field(entry);
    const type = wantString(n.type, 'node.type');
    if (type !== 'folder') continue;
    out.push({
      id: wantString(n.id, 'node.id'),
      title: wantString(n.title, 'node.title'),
      parent_id: n.parent_id === undefined || n.parent_id === null ? null : wantString(n.parent_id, 'node.parent_id'),
    });
  }
  return out;
}

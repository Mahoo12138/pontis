// The provider's promises are all about time: what is on screen when the
// network is slow, what a response from an obsolete request may not do, and
// what has to disappear the moment the server says it may no longer be shown
// (start-page doc §14). Those are exactly the cases a UI test cannot catch.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PontisDB, type StartPageConfigRecord } from '../store/db';
import { ApiError, NOT_MODIFIED, type StartPageSnapshotRead } from '../transport/client';
import {
  clearStartPage,
  configIdFor,
  loadStartPage,
  refreshStartPage,
  saveSource,
  snapshotIdFor,
  type StartPageDeps,
} from './provider';
import type { StartPageSnapshotWire } from './wire';

const INSTANCE = 'instance-1';
const DEVICE = 'dev-1';
const USER = 'user-1';
const SPACE = 'space-1';
const FOLDER = 'folder-1';

let db: PontisDB;
let deps: StartPageDeps;

beforeEach(async () => {
  db = new PontisDB(`start-page-test-${Math.random().toString(36).slice(2)}`);
  await db.open();
  deps = {
    db,
    bootstrap: {
      get: async () => ({ serverUrl: 'http://x', instanceId: INSTANCE, deviceId: DEVICE, deviceToken: 'pdv_x' }),
    },
    client: { deviceStartPageSnapshot: vi.fn() },
  };
});

function wire(over: Partial<StartPageSnapshotWire> = {}): StartPageSnapshotWire {
  return {
    schema_version: 1,
    instance_id: INSTANCE,
    user_id: USER,
    source: { space_id: SPACE, space_name: '个人', folder_id: FOLDER, folder_title: '日常入口' },
    snapshot: { epoch: 1, revision: 10, captured_at: '2026-10-12T08:00:00Z', complete: true, source_title: '日常入口' },
    nodes: [
      { id: 'bm-1', type: 'bookmark', parent_id: FOLDER, title: 'GitHub', url: 'https://github.com/', position: 0, updated_at: '2026-10-12T08:00:00Z' },
    ],
    ...over,
  };
}

function reads(...bodies: (StartPageSnapshotRead | Error)[]) {
  const fn = vi.fn();
  for (const body of bodies) {
    if (body instanceof Error) fn.mockRejectedValueOnce(body);
    else fn.mockResolvedValueOnce(body);
  }
  // The default answer once the queued ones run out. vi.fn() already has a
  // no-op implementation, so this has to be set unconditionally rather than
  // probed for.
  fn.mockResolvedValue({ value: NOT_MODIFIED, etag: 'W/"new"' });
  deps.client.deviceStartPageSnapshot = fn;
  return fn;
}

const ok = (body: StartPageSnapshotWire, etag = 'W/"sp-1"'): StartPageSnapshotRead => ({ value: body, etag });

async function seedConfig(over: Partial<StartPageConfigRecord> = {}): Promise<StartPageConfigRecord> {
  const record: StartPageConfigRecord = {
    id: configIdFor(INSTANCE, DEVICE),
    instanceId: INSTANCE,
    deviceId: DEVICE,
    userId: USER,
    spaceId: SPACE,
    folderId: FOLDER,
    searchMode: 'web',
    openTarget: 'current-tab',
    density: 'standard',
    configGeneration: 1,
    updatedAt: Date.now(),
    ...over,
  };
  await db.startPageConfigs.put(record);
  return record;
}

/** Cache the given body under the config's current key and age it, so the next
 * load is forced to ask rather than trust a fresh copy. */
async function seedCachedSource(body: StartPageSnapshotWire, verifiedAt = 0) {
  await saveSource(deps, { spaceId: body.source.space_id, folderId: body.source.folder_id }, body);
  await db.startPageSnapshots.update(
    snapshotIdFor(INSTANCE, USER, DEVICE, body.source.space_id, body.source.folder_id),
    { verifiedAt },
  );
}

describe('loadStartPage', () => {
  it('says so when nothing is paired', async () => {
    deps.bootstrap = { get: async () => ({}) };
    expect((await loadStartPage(deps)).phase).toBe('not-paired');
  });

  it('says so when the browser has not chosen a source', async () => {
    // No request is made: an unconfigured page has nothing to ask about, and
    // guessing a folder would show private content nobody selected (§15).
    const fn = reads();
    const view = await loadStartPage(deps);
    expect(view.phase).toBe('unconfigured');
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats a half-filled source as unconfigured', async () => {
    // A record that names a space but no folder would otherwise ask the
    // server a question it cannot answer.
    await seedConfig({ folderId: '' });
    const fn = reads();
    expect((await loadStartPage(deps)).phase).toBe('unconfigured');
    expect(fn).not.toHaveBeenCalled();
  });

  it('renders a fresh local copy without going out at all', async () => {
    await seedConfig();
    await seedCachedSource(wire(), Date.now());
    const fn = reads();

    const view = await loadStartPage(deps);
    expect(view.phase).toBe('ready');
    expect(view.fromCache).toBe(true);
    expect(view.snapshot?.nodes.map((n) => n.title)).toEqual(['GitHub']);
    // The point of the cache: the first screen does not wait on a request that
    // might not land (§14.1).
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps showing the cached tree when the network is down', async () => {
    await seedConfig();
    await seedCachedSource(wire());
    reads(new Error('NetworkError'));

    const view = await loadStartPage(deps);
    expect(view.phase).toBe('ready');
    expect(view.fromCache).toBe(true);
    expect(view.snapshot?.nodes).toHaveLength(1);
  });

  it('does not invent an empty folder when there is no cache and no network', async () => {
    await seedConfig();
    reads(new Error('NetworkError'));
    const view = await loadStartPage(deps);
    // "Offline" and "this folder is empty" have to stay different answers
    // (SP-13).
    expect(view.phase).toBe('offline');
    expect(view.snapshot).toBeNull();
  });
});

describe('refreshStartPage', () => {
  it('asks for the configured space and folder, with the cached tag', async () => {
    await seedConfig();
    await seedCachedSource(wire());
    const fn = reads({ value: NOT_MODIFIED, etag: 'W/"new"' });

    await refreshStartPage(deps);
    expect(fn).toHaveBeenCalledWith(SPACE, FOLDER, expect.any(String));
  });

  it('revalidates a not-modified copy instead of leaving it stale', async () => {
    await seedConfig();
    await seedCachedSource(wire());
    const key = snapshotIdFor(INSTANCE, USER, DEVICE, SPACE, FOLDER);
    reads();

    const view = await refreshStartPage(deps);
    expect(view.phase).toBe('ready');
    const stored = await db.startPageSnapshots.get(key);
    expect(stored?.verifiedAt).toBeGreaterThan(0);
    expect(stored?.etag).toBe('W/"new"');
  });

  it('installs a new body and drops the copy of the folder it replaced', async () => {
    const config = await seedConfig();
    await seedCachedSource(wire());

    const moved = wire({
      source: { ...wire().source, folder_id: 'folder-2', folder_title: '工具' },
      nodes: [{ id: 'bm-2', type: 'bookmark', parent_id: 'folder-2', title: 'Gitea', url: 'http://127.0.0.1:3000/', position: 0, updated_at: 'x' }],
    });
    await db.startPageConfigs.update(config.id, { folderId: 'folder-2', configGeneration: 2 });
    reads(ok(moved));

    const view = await refreshStartPage(deps);
    expect(view.phase).toBe('ready');
    expect(view.fromCache).toBe(false);
    const rows = await db.startPageSnapshots.toArray();
    // One active version, not a pile of superseded trees (§12).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.folderId).toBe('folder-2');
  });

  it('refuses a body describing a different folder than the one asked for', async () => {
    await seedConfig();
    const wrong = wire({ source: { ...wire().source, folder_id: 'somewhere-else' } });
    reads(ok(wrong));

    await refreshStartPage(deps);
    expect(await db.startPageSnapshots.count()).toBe(0);
    const warnings = (await db.diagnostics.toArray()).filter((w) => w.scope === 'start-page');
    expect(warnings.some((w) => w.level === 'warn')).toBe(true);
  });

  it('keeps the previous copy when a body cannot be installed', async () => {
    await seedConfig();
    await seedCachedSource(wire());
    // The transport's parser is what refuses a torn tree (see wire.test.ts);
    // by the time the provider sees a rejection the good copy has to survive.
    reads(new Error('StartPageShapeError: node has a parent outside the source'));

    const view = await refreshStartPage(deps);
    expect(view.phase).toBe('ready');
    expect(view.fromCache).toBe(true);
    const rows = await db.startPageSnapshots.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nodes.map((n) => n.title)).toEqual(['GitHub']);
  });
});

describe('a response that arrives too late', () => {
  it('does not overwrite a source chosen while it was in flight', async () => {
    // SP-10: the reader moved from A to B while A's request was still running.
    const config = await seedConfig({ spaceId: 'space-A', folderId: 'folder-A' });
    const bodyA = wire({
      source: { ...wire().source, space_id: 'space-A', folder_id: 'folder-A' },
      nodes: [{ id: 'a', type: 'bookmark', parent_id: 'folder-A', title: 'From A', url: 'https://a.example', position: 0, updated_at: 'x' }],
    });

    let resolveA: (r: StartPageSnapshotRead) => void = () => {};
    const fn = vi.fn(() => new Promise<StartPageSnapshotRead>((resolve) => { resolveA = resolve; }));
    deps.client.deviceStartPageSnapshot = fn;

    const inFlight = refreshStartPage(deps);
    // Wait for the request to leave: resolving a promise that was never
    // created would hang the test instead of proving anything.
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    await db.startPageConfigs.update(config.id, {
      spaceId: 'space-B',
      folderId: 'folder-B',
      configGeneration: config.configGeneration + 1,
    });
    resolveA(ok(bodyA));
    await inFlight;

    const rows = await db.startPageSnapshots.toArray();
    expect(rows.map((r) => r.folderId)).not.toContain('folder-A');
    const stored = await db.startPageConfigs.get(config.id);
    expect(stored?.folderId).toBe('folder-B');
  });

  it('does not write back after the device is unpaired', async () => {
    // SP-11: signing out clears the private tree; a late response must not
    // resurrect it.
    await seedConfig();
    const body = wire();
    let resolveIt: (r: StartPageSnapshotRead) => void = () => {};
    deps.client.deviceStartPageSnapshot = vi.fn(
      () => new Promise<StartPageSnapshotRead>((resolve) => { resolveIt = resolve; }),
    );

    const inFlight = refreshStartPage(deps);
    await clearStartPage(db, DEVICE);
    resolveIt(ok(body));
    await inFlight;

    expect(await db.startPageSnapshots.count()).toBe(0);
    expect(await db.startPageConfigs.count()).toBe(0);
  });
});

describe('what a refusal takes with it', () => {
  it('clears the tree when the source is gone, and never falls back', async () => {
    await seedConfig();
    await seedCachedSource(wire());
    reads(apiError(404, 'START_PAGE_SOURCE_UNAVAILABLE'));

    const view = await loadStartPage(deps);
    expect(view.phase).toBe('source-unavailable');
    expect(view.snapshot).toBeNull();
    expect(await db.startPageSnapshots.count()).toBe(0);
  });

  it('clears the tree when the space stops being synced', async () => {
    await seedConfig();
    await seedCachedSource(wire());
    reads(apiError(404, 'START_PAGE_PERMISSION_REQUIRED'));

    const view = await loadStartPage(deps);
    expect(view.phase).toBe('space-not-synced');
    // Nothing readable is left behind, even though the chosen source stays put
    // so the reader can re-sync the space and see it again.
    expect(await db.startPageSnapshots.count()).toBe(0);
    expect(await db.startPageConfigs.count()).toBe(1);
  });

  it('keeps a good copy when the source is merely too large', async () => {
    await seedConfig();
    await seedCachedSource(wire());
    reads(apiError(413, 'START_PAGE_SOURCE_TOO_LARGE'));

    const view = await refreshStartPage(deps);
    expect(view.phase).toBe('ready');
    expect(view.fromCache).toBe(true);
    expect(await db.startPageSnapshots.count()).toBe(1);
  });
});

/** The transport's typed failure: the provider acts on `code`, never on the
 * message, so the stub has to be the real class rather than a look-alike. */
function apiError(status: number, code: string): ApiError {
  return new ApiError(status, code, 'stubbed refusal');
}

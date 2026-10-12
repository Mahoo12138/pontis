// The provider's promises are all about time: what is on screen when the
// network is slow, what a response from an obsolete request may not do, and
// what has to disappear the moment the server says it may no longer be shown
// (start-page doc §14). Those are exactly the cases a UI test cannot catch.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PontisDB, type StartPageConfigRecord } from '../store/db';
import { ApiError, NOT_MODIFIED, type StartPageSnapshotRead } from '../transport/client';
import type { StartPageSnapshotWire } from './wire';
import {
  clearStartPage,
  configIdFor,
  loadStartPage,
  refreshStartPage,
  saveSource,
  snapshotIdFor,
  type StartPageDeps,
} from './provider';

const INSTANCE = 'instance-1';
const DEVICE = 'dev-1';
const USER = 'user-1';

let db: PontisDB;
let deps: StartPageDeps & { snapshot: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  db = new PontisDB(`start-page-test-${Math.random().toString(36).slice(2)}`);
  await db.open();
  deps = {
    db,
    bootstrap: { get: async () => ({ serverUrl: 'http://x', instanceId: INSTANCE, deviceId: DEVICE, deviceToken: 'pdv_x' }) },
    client: {
      deviceStartPage: vi.fn(),
      deviceStartPageSnapshot: vi.fn(),
    },
    snapshot: vi.fn(),
  };
});

function snapshotWire(over: Partial<StartPageSnapshotWire> = {}): StartPageSnapshotWire {
  return {
    schema_version: 1,
    instance_id: INSTANCE,
    user_id: USER,
    source: {
      grant_id: 'grant-1',
      device_id: DEVICE,
      space_id: 'space-1',
      space_name: '个人',
      folder_id: 'folder-1',
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
    nodes: [
      {
        id: 'bm-1',
        type: 'bookmark',
        parent_id: 'folder-1',
        title: 'GitHub',
        url: 'https://github.com/',
        position: 0,
        updated_at: '2026-10-12T08:00:00Z',
      },
    ],
    ...over,
  };
}

function reads(...bodies: (StartPageSnapshotRead | Error)[]) {
  const fn = vi.fn<StartPageDeps['client']['deviceStartPageSnapshot']>();
  for (const body of bodies) {
    if (body instanceof Error) fn.mockRejectedValueOnce(body);
    else fn.mockResolvedValueOnce(body);
  }
  if (!fn.getMockImplementation()) fn.mockResolvedValue({ value: NOT_MODIFIED, etag: '' });
  deps.client.deviceStartPageSnapshot = fn;
  return fn;
}

const ok = (wire: StartPageSnapshotWire, etag = 'W/"sp-1"'): StartPageSnapshotRead => ({ value: wire, etag });

async function seedConfig(over: Partial<StartPageConfigRecord> = {}): Promise<StartPageConfigRecord> {
  const record: StartPageConfigRecord = {
    id: configIdFor(INSTANCE, DEVICE),
    instanceId: INSTANCE,
    deviceId: DEVICE,
    userId: USER,
    spaceId: 'space-1',
    folderId: 'folder-1',
    grantId: 'grant-1',
    grantVersion: 1,
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

  it('renders a fresh local copy without going out at all', async () => {
    await seedConfig();
    const first = snapshotWire();
    await saveSource(deps, first.source, first);
    await db.startPageSnapshots.update(
      snapshotIdFor(INSTANCE, USER, DEVICE, 'grant-1', 1, 'space-1', 'folder-1'),
      { verifiedAt: Date.now() },
    );
    const fn = reads();

    const view = await loadStartPage(deps);
    expect(view.phase).toBe('ready');
    expect(view.fromCache).toBe(true);
    expect(view.snapshot?.nodes.map((n) => n.title)).toEqual(['GitHub']);
    // The point of the cache: the first screen does not wait on a request
    // that might not land (§14.1).
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps showing the cached tree when the network is down', async () => {
    await seedConfig();
    const first = snapshotWire();
    await saveSource(deps, first.source as never, first);
    await db.startPageSnapshots.update(
      snapshotIdFor(INSTANCE, USER, DEVICE, 'grant-1', 1, 'space-1', 'folder-1'),
      { verifiedAt: 0 },
    );
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
  it('revalidates a not-modified copy instead of leaving it stale', async () => {
    await seedConfig();
    const wire = snapshotWire();
    await saveSource(deps, wire.source as never, wire);
    const key = snapshotIdFor(INSTANCE, USER, DEVICE, 'grant-1', 1, 'space-1', 'folder-1');
    await db.startPageSnapshots.update(key, { verifiedAt: 0, etag: 'W/"old"' });

    const fn = reads({ value: NOT_MODIFIED, etag: 'W/"new"' });
    const view = await refreshStartPage(deps);

    expect(fn).toHaveBeenCalledWith('W/"old"');
    expect(view.phase).toBe('ready');
    const stored = await db.startPageSnapshots.get(key);
    expect(stored?.verifiedAt).toBeGreaterThan(0);
    expect(stored?.etag).toBe('W/"new"');
  });

  it('installs a new body and drops the copy of the folder it replaced', async () => {
    const config = await seedConfig();
    const first = snapshotWire();
    await saveSource(deps, first.source, first);

    // A re-pointed grant is a new version as well as a new folder; the body
    // has to say so or the provider is right to refuse it.
    const moved = snapshotWire({
      source: { ...first.source, folder_id: 'folder-2', folder_title: '工具', grant_version: 2 },
      nodes: [{ id: 'bm-2', type: 'bookmark', parent_id: 'folder-2', title: 'Gitea', url: 'http://127.0.0.1:3000/', position: 0, updated_at: 'x' }],
    });
    // The config has to say folder-2 for that body to be this read's answer.
    await db.startPageConfigs.update(config.id, { folderId: 'folder-2', grantVersion: 2, configGeneration: 2 });
    reads(ok(moved));

    const view = await refreshStartPage(deps);
    expect(view.phase).toBe('ready');
    expect(view.fromCache).toBe(false);
    const rows = await db.startPageSnapshots.toArray();
    // One active version, not a pile of superseded trees (§12).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.folderId).toBe('folder-2');
  });

  it('refuses a body describing a different source than the one asked for', async () => {
    const config = await seedConfig();
    const wrong = snapshotWire({ source: { ...snapshotWire().source, grant_version: 7 } });
    reads(ok(wrong));

    await refreshStartPage(deps);
    const rows = await db.startPageSnapshots.toArray();
    expect(rows).toHaveLength(0);
    expect(config.folderId).toBe('folder-1');
    const warnings = (await db.diagnostics.toArray()).filter((w) => w.scope === 'start-page');
    expect(warnings.some((w) => w.level === 'warn')).toBe(true);
  });

  it('keeps the previous copy when a body cannot be installed', async () => {
    // The transport's parser is what refuses a torn tree (see wire.test.ts);
    // by the time the provider sees a rejection the good copy has to survive.
    await seedConfig();
    const good = snapshotWire();
    await saveSource(deps, good.source, good);
    await db.startPageSnapshots.update(
      snapshotIdFor(INSTANCE, USER, DEVICE, 'grant-1', 1, 'space-1', 'folder-1'),
      { verifiedAt: 0 },
    );
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
    const config = await seedConfig({ folderId: 'folder-A', grantId: 'grant-A', grantVersion: 1 });
    const bodyA = snapshotWire({
      source: { ...snapshotWire().source, folder_id: 'folder-A', grant_id: 'grant-A' },
      nodes: [{ id: 'a', type: 'bookmark', parent_id: 'folder-A', title: 'From A', url: 'https://a.example', position: 0, updated_at: 'x' }],
    });

    let resolveA: (r: StartPageSnapshotRead) => void = () => {};
    const fn = vi.fn(
      () => new Promise<StartPageSnapshotRead>((resolve) => { resolveA = resolve; }),
    );
    deps.client.deviceStartPageSnapshot = fn;

    const inFlight = refreshStartPage(deps);
    // Wait for the request to leave: resolving a promise that was never
    // created would hang the test instead of proving anything.
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    // The user picks another folder mid-request.
    await db.startPageConfigs.update(config.id, {
      folderId: 'folder-B',
      grantId: 'grant-B',
      grantVersion: 2,
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
    const body = snapshotWire();
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
    const body = snapshotWire();
    await saveSource(deps, body.source, body);
    await db.startPageSnapshots.update(
      snapshotIdFor(INSTANCE, USER, DEVICE, 'grant-1', 1, 'space-1', 'folder-1'),
      { verifiedAt: 0 },
    );
    reads(apiError(404, 'START_PAGE_SOURCE_UNAVAILABLE'));

    const view = await loadStartPage(deps);
    expect(view.phase).toBe('source-unavailable');
    expect(view.snapshot).toBeNull();
    expect(await db.startPageSnapshots.count()).toBe(0);
  });

  it('clears the tree when the approval is withdrawn', async () => {
    await seedConfig();
    const body = snapshotWire();
    await saveSource(deps, body.source, body);
    await db.startPageSnapshots.update(
      snapshotIdFor(INSTANCE, USER, DEVICE, 'grant-1', 1, 'space-1', 'folder-1'),
      { verifiedAt: 0 },
    );
    reads(apiError(403, 'START_PAGE_PERMISSION_REQUIRED'));

    const view = await loadStartPage(deps);
    expect(view.phase).toBe('permission-required');
    // Nothing readable is left behind, even though the settings entry stays.
    expect(await db.startPageSnapshots.count()).toBe(0);
  });

  it('keeps a good copy when the source is merely too large', async () => {
    await seedConfig();
    const body = snapshotWire();
    await saveSource(deps, body.source, body);
    const key = snapshotIdFor(INSTANCE, USER, DEVICE, 'grant-1', 1, 'space-1', 'folder-1');
    await db.startPageSnapshots.update(key, { verifiedAt: 0 });
    reads(apiError(413, 'START_PAGE_SOURCE_TOO_LARGE'));

    const view = await refreshStartPage(deps);
    expect(view.phase).toBe('ready');
    expect(view.fromCache).toBe(true);
    expect(await db.startPageSnapshots.count()).toBe(1);
  });

  it('forgets the source when the server no longer has one for this device', async () => {
    await seedConfig();
    const body = snapshotWire();
    await saveSource(deps, body.source, body);
    await db.startPageSnapshots.update(
      snapshotIdFor(INSTANCE, USER, DEVICE, 'grant-1', 1, 'space-1', 'folder-1'),
      { verifiedAt: 0 },
    );
    reads(apiError(404, 'START_PAGE_NOT_CONFIGURED'));

    const view = await loadStartPage(deps);
    expect(view.phase).toBe('source-unavailable');
    expect(await db.startPageSnapshots.count()).toBe(0);
    // The choice goes too: there is nothing left for it to point at.
    expect(await db.startPageConfigs.count()).toBe(0);
  });
});

/** The transport's typed failure: the provider acts on `code`, never on the
 * message, so the stub has to be the real class rather than a look-alike. */
function apiError(status: number, code: string): ApiError {
  return new ApiError(status, code, 'stubbed refusal');
}

// The extension's start-page provider: read the local copy first, refresh
// behind it, and never let a response that arrived late overwrite what the
// user has since chosen (start-page doc §14).
//
// This module touches startPageConfigs and startPageSnapshots only. It reads
// no binding, writes no pending operation, and advances no watermark — the
// projection is allowed to look at the tree, not to take a position in it
// (§11.1).

import { ApiError, NOT_MODIFIED } from '../transport/client';
import type { StartPageSnapshotWire, StartPageSourceWire } from './wire';
import {
  logDiagnostic,
  type PontisDB,
  type StartPageConfigRecord,
  type StartPageSnapshotRecord,
} from '../store/db';
import type { BootstrapData } from '../store/bootstrap';
import type { StartPageTransport } from '../transport/client';

/** How stale the on-screen copy may be before a load asks again (§14.2). */
export const REVALIDATE_AFTER_MS = 60_000;

export type StartPagePhase =
  | 'not-paired'
  | 'unconfigured'
  | 'ready'
  /** The approved folder is gone or no longer a folder. Never falls back to
   * the space (§5.2). */
  | 'source-unavailable'
  /** The grant was withdrawn, or the account/device may not be used. */
  | 'permission-required'
  | 'source-too-large'
  /** A body arrived that this build refuses to install. */
  | 'snapshot-invalid'
  /** Nothing local, and the server could not be reached. */
  | 'offline';

export interface StartPageView {
  phase: StartPagePhase;
  config: StartPageConfigRecord | null;
  snapshot: StartPageSnapshotRecord | null;
  /** True when what is on screen came from the local copy rather than from
   * this load's request. */
  fromCache: boolean;
  /** Server error code behind a failure phase, for the page's own wording. */
  errorCode?: string;
}

export interface StartPageDeps {
  db: PontisDB;
  /** Only the read half of the pairing record is needed here, and naming it
   * that way keeps a test able to hand over a plain object. */
  bootstrap: { get(): Promise<BootstrapData> };
  client: Pick<StartPageTransport, 'deviceStartPage' | 'deviceStartPageSnapshot'>;
}

export function configIdFor(instanceId: string, deviceId: string): string {
  return `${instanceId}:${deviceId}`;
}

/** Every party that may see this copy, in one key (§14.1).
 *
 * space_id alone would serve one folder's contents under another folder's
 * name; the account and the device are in here because a browser profile
 * shared by two people is not a single reader. */
export function snapshotIdFor(
  instanceId: string,
  userId: string,
  deviceId: string,
  grantId: string,
  grantVersion: number,
  spaceId: string,
  folderId: string,
): string {
  return [instanceId, userId, deviceId, grantId, grantVersion, spaceId, folderId].join(':');
}

/** The values a read is bound to. Re-checked before anything is written, so a
 * response to an obsolete request cannot become the current view (§14.3). */
interface ReadBinding {
  configId: string;
  configGeneration: number;
  deviceId: string;
  grantId: string;
  grantVersion: number;
}

function bindingOf(config: StartPageConfigRecord): ReadBinding {
  return {
    configId: config.id,
    configGeneration: config.configGeneration,
    deviceId: config.deviceId,
    grantId: config.grantId,
    grantVersion: config.grantVersion,
  };
}

/**
 * The page's opening move: show what is already known, then find out.
 *
 * Rendering must not wait on the network (§14.1). With a usable local copy the
 * caller gets it immediately and a refresh runs alongside; with none — a first
 * run, or a source that was cleared — this awaits one read, because there is
 * nothing to draw in the meantime.
 */
export async function loadStartPage(deps: StartPageDeps): Promise<StartPageView> {
  const identity = await identityOf(deps);
  if (!identity) return { phase: 'not-paired', config: null, snapshot: null, fromCache: false };

  const config = await deps.db.startPageConfigs.get(identity.configId);
  if (!config) return { phase: 'unconfigured', config: null, snapshot: null, fromCache: false };

  const snapshot = await readSnapshot(deps.db, config);
  if (snapshot && Date.now() - snapshot.verifiedAt < REVALIDATE_AFTER_MS) {
    return { phase: 'ready', config, snapshot, fromCache: true };
  }

  const result = await refresh(deps, identity, config);
  if (result.view.phase === 'ready') return result.view;
  // A refresh that failed over a good copy keeps the copy on screen: the
  // reader's bookmarks did not go anywhere because this request did not land
  // (§14.4). A refusal that took the copy with it must not be answered by
  // handing back the object read before the refresh — that would keep showing
  // a tree the server has just said may not be shown.
  if (snapshot && !stopsDisplay(result.view.phase)) {
    return {
      phase: 'ready',
      config,
      snapshot,
      fromCache: true,
      errorCode: result.view.errorCode,
    };
  }
  return result.view;
}

/** Phases that mean private content may no longer be drawn, as opposed to
 * "could not find out right now". */
function stopsDisplay(phase: StartPagePhase): boolean {
  return (
    phase === 'source-unavailable' ||
    phase === 'permission-required' ||
    phase === 'unconfigured'
  );
}

/** Re-check the server. Safe to call on a timer, on focus, or on a manual
 * press of 刷新; concurrent callers each get their own answer, and the last
 * write still has to pass the generation check. */
export async function refreshStartPage(deps: StartPageDeps): Promise<StartPageView> {
  const identity = await identityOf(deps);
  if (!identity) return { phase: 'not-paired', config: null, snapshot: null, fromCache: false };
  const config = await deps.db.startPageConfigs.get(identity.configId);
  if (!config) return { phase: 'unconfigured', config: null, snapshot: null, fromCache: false };
  const result = await refresh(deps, identity, config);
  if (result.installed) return result.view;
  // Re-read after the refresh rather than reusing anything from before it: a
  // refusal may have deleted the copy in the meantime.
  const snapshot = await readSnapshot(deps.db, config);
  if (snapshot && !stopsDisplay(result.view.phase)) {
    return { phase: 'ready', config, snapshot, fromCache: true, errorCode: result.view.errorCode };
  }
  return result.view;
}

interface Identity {
  configId: string;
  instanceId: string;
  deviceId: string;
  deviceToken: string;
}

async function identityOf(deps: StartPageDeps): Promise<Identity | null> {
  const b = await deps.bootstrap.get();
  if (!b.serverUrl || !b.deviceToken || !b.deviceId || !b.instanceId) return null;
  return {
    configId: configIdFor(b.instanceId, b.deviceId),
    instanceId: b.instanceId,
    deviceId: b.deviceId,
    deviceToken: b.deviceToken,
  };
}

async function readSnapshot(
  db: PontisDB,
  config: StartPageConfigRecord,
): Promise<StartPageSnapshotRecord | null> {
  const row = await db.startPageSnapshots.get(
    snapshotIdFor(
      config.instanceId,
      config.userId,
      config.deviceId,
      config.grantId,
      config.grantVersion,
      config.spaceId,
      config.folderId,
    ),
  );
  return row ?? null;
}

interface RefreshResult {
  view: StartPageView;
  /** Something was written to storage: the caller may trust the view. */
  installed: boolean;
}

async function refresh(
  deps: StartPageDeps,
  identity: Identity,
  config: StartPageConfigRecord,
): Promise<RefreshResult> {
  const bound = bindingOf(config);

  let read;
  try {
    // The cached tag is what makes an unchanged folder cheap; it is only ever
    // the tag this copy was installed with, so a stale row cannot claim to be
    // current.
    const cached = await readSnapshot(deps.db, config);
    read = await deps.client.deviceStartPageSnapshot(cached?.etag);
  } catch (error) {
    return { installed: false, view: await failureView(deps, config, error) };
  }

  if (read.value === NOT_MODIFIED) {
    // Nothing changed — but the server only says that after it has checked the
    // account, the device and the grant, so this is also the revalidation.
    if (!(await stillCurrent(deps, bound))) {
      return { installed: false, view: await viewOf(deps, identity) };
    }
    const existing = await readSnapshot(deps.db, config);
    if (existing) {
      await deps.db.startPageSnapshots.update(existing.id, { verifiedAt: Date.now(), etag: read.etag });
    }
    const fresh = existing ? await readSnapshot(deps.db, config) : null;
    return {
      installed: Boolean(fresh),
      view: fresh
        ? { phase: 'ready', config, snapshot: fresh, fromCache: true }
        : { phase: 'unconfigured', config, snapshot: null, fromCache: false },
    };
  }

  const snapshot = read.value;
  // A body that describes a different source than the one this read was
  // started for is not this page's content, whatever else is true of it.
  if (
    snapshot.source.folder_id !== config.folderId ||
    snapshot.source.space_id !== config.spaceId ||
    snapshot.source.grant_version !== config.grantVersion ||
    snapshot.source.grant_id !== config.grantId
  ) {
    await logDiagnostic(deps.db, 'warn', 'start-page', 'snapshot identity did not match the request', {
      deviceId: config.deviceId,
      grantVersion: config.grantVersion,
      returnedGrantVersion: snapshot.source.grant_version,
    });
    return { installed: false, view: await viewOf(deps, identity) };
  }

  // Re-read the guard before writing: the user may have chosen another source,
  // signed out, or moved to another account while this request was in flight.
  if (!(await stillCurrent(deps, bound))) {
    return { installed: false, view: await viewOf(deps, identity) };
  }

  const record = toRecord(snapshot, identity, read.etag);
  try {
    await install(deps.db, record);
  } catch (error) {
    // A write that cannot be made must not take the good copy with it (§14.3).
    await logDiagnostic(deps.db, 'error', 'start-page', 'snapshot could not be stored', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      installed: false,
      view: { phase: 'snapshot-invalid', config, snapshot: await readSnapshot(deps.db, config), fromCache: true },
    };
  }

  const stored = await deps.db.startPageConfigs.get(config.id);
  if (stored && stored.userId !== snapshot.user_id) {
    await deps.db.startPageConfigs.update(stored.id, { userId: snapshot.user_id });
  }
  return { installed: true, view: { phase: 'ready', config, snapshot: record, fromCache: false } };
}

/**
 * Still the same configuration and approval as when the read left?
 *
 * The stored row is the authority: it is what a new source write replaces and
 * what a sign-out deletes, so comparing against it catches every way the page
 * can have moved on underneath an in-flight request (§14.3).
 */
async function stillCurrent(deps: StartPageDeps, bound: ReadBinding): Promise<boolean> {
  const current = await deps.db.startPageConfigs.get(bound.configId);
  if (!current) return false;
  if (current.configGeneration !== bound.configGeneration) return false;
  if (current.deviceId !== bound.deviceId) return false;
  if (current.grantId !== bound.grantId || current.grantVersion !== bound.grantVersion) return false;
  const identity = await deps.bootstrap.get();
  // Re-pairing swapped the credential underneath this read; whatever comes
  // back now belongs to a device the reader is no longer looking at.
  if (identity.deviceId && identity.deviceId !== bound.deviceId) return false;
  return true;
}

/**
 * Replace the active copy in one transaction.
 *
 * The previous row for this device is removed in the same transaction that
 * writes the new one, so a source that moved leaves no orphan behind that a
 * later read could mistake for the current folder's contents.
 */
async function install(db: PontisDB, record: StartPageSnapshotRecord): Promise<void> {
  await db.transaction('rw', [db.startPageSnapshots], async () => {
    const stale = await db.startPageSnapshots.where('deviceId').equals(record.deviceId).toArray();
    const drop = stale.filter((row) => row.id !== record.id).map((row) => row.id);
    await db.startPageSnapshots.bulkDelete(drop);
    await db.startPageSnapshots.put(record);
  });
}

function toRecord(
  snapshot: StartPageSnapshotWire,
  identity: Identity,
  etag: string,
): StartPageSnapshotRecord {
  const s = snapshot.source;
  return {
    id: snapshotIdFor(
      snapshot.instance_id,
      snapshot.user_id,
      s.device_id || identity.deviceId,
      s.grant_id,
      s.grant_version,
      s.space_id,
      s.folder_id,
    ),
    instanceId: snapshot.instance_id,
    userId: snapshot.user_id,
    deviceId: s.device_id || identity.deviceId,
    spaceId: s.space_id,
    folderId: s.folder_id,
    grantId: s.grant_id,
    grantVersion: s.grant_version,
    epoch: snapshot.snapshot.epoch,
    revision: snapshot.snapshot.revision,
    etag,
    capturedAt: snapshot.snapshot.captured_at,
    verifiedAt: Date.now(),
    spaceName: s.space_name,
    sourceTitle: s.folder_title,
    nodes: snapshot.nodes,
  };
}

/**
 * A refusal the server stated plainly.
 *
 * Two of these clear the local copy and two do not. A source that is gone or a
 * grant that is withdrawn means the content may no longer be shown, so it is
 * deleted; a folder that is simply too large, or a body that failed to
 * validate, says nothing about the copy already held, which stays usable
 * (§13.3, §14.4).
 */
async function failureView(
  deps: StartPageDeps,
  config: StartPageConfigRecord,
  error: unknown,
): Promise<StartPageView> {
  const code = error instanceof ApiError ? error.code : 'NETWORK_ERROR';
  const status = error instanceof ApiError ? error.status : 0;

  const clearsContent =
    code === 'START_PAGE_NOT_CONFIGURED' ||
    code === 'START_PAGE_SOURCE_UNAVAILABLE' ||
    code === 'START_PAGE_PERMISSION_REQUIRED' ||
    code === 'DEVICE_CREDENTIAL_INVALID' ||
    code === 'ACCOUNT_DISABLED';

  if (clearsContent) {
    await dropSnapshotsFor(deps.db, config.deviceId);
    // A revoked grant is not a reason to forget what the user chose — the
    // settings entry has to stay reachable so they can choose again. But the
    // private tree it was showing goes now.
    if (code === 'START_PAGE_NOT_CONFIGURED') {
      await deps.db.startPageConfigs.delete(config.id);
    }
    await logDiagnostic(deps.db, 'warn', 'start-page', 'source stopped being readable', {
      code,
      deviceId: config.deviceId,
    });
  }

  const phase: StartPagePhase =
    code === 'START_PAGE_SOURCE_UNAVAILABLE' || code === 'START_PAGE_NOT_CONFIGURED'
      ? 'source-unavailable'
      : code === 'START_PAGE_PERMISSION_REQUIRED' ||
          code === 'DEVICE_CREDENTIAL_INVALID' ||
          code === 'ACCOUNT_DISABLED'
        ? 'permission-required'
        : code === 'START_PAGE_SOURCE_TOO_LARGE'
          ? 'source-too-large'
          : status === 0
            ? 'offline'
            : 'snapshot-invalid';

  return { phase, config, snapshot: null, fromCache: false, errorCode: code };
}

async function dropSnapshotsFor(db: PontisDB, deviceId: string): Promise<void> {
  await db.startPageSnapshots.where('deviceId').equals(deviceId).delete();
}

async function viewOf(deps: StartPageDeps, identity: Identity): Promise<StartPageView> {
  const config = await deps.db.startPageConfigs.get(identity.configId);
  if (!config) return { phase: 'unconfigured', config: null, snapshot: null, fromCache: false };
  const snapshot = await readSnapshot(deps.db, config);
  return snapshot
    ? { phase: 'ready', config, snapshot, fromCache: true }
    : { phase: 'unconfigured', config, snapshot: null, fromCache: false };
}

/**
 * Record the source this browser shows, after the server confirmed it.
 *
 * The caller passes the source it just read successfully; writing the config
 * and the first snapshot together is what makes "configured" mean "there is
 * something to show" rather than "a choice was saved" (§8.2).
 */
export async function saveSource(
  deps: StartPageDeps,
  source: StartPageSourceWire,
  snapshot: StartPageSnapshotWire,
): Promise<StartPageConfigRecord> {
  const identity = await identityOf(deps);
  if (!identity) throw new Error('start-page: not paired');
  const existing = await deps.db.startPageConfigs.get(identity.configId);
  const record: StartPageConfigRecord = {
    id: identity.configId,
    instanceId: identity.instanceId,
    deviceId: identity.deviceId,
    userId: snapshot.user_id,
    spaceId: source.space_id,
    folderId: source.folder_id,
    grantId: source.grant_id,
    grantVersion: source.grant_version,
    searchMode: existing?.searchMode ?? 'web',
    openTarget: existing?.openTarget ?? 'current-tab',
    density: existing?.density ?? 'standard',
    configGeneration: (existing?.configGeneration ?? 0) + 1,
    updatedAt: Date.now(),
  };
  await deps.db.transaction('rw', [deps.db.startPageConfigs, deps.db.startPageSnapshots], async () => {
    await deps.db.startPageConfigs.put(record);
    await install(deps.db, toRecord(snapshot, identity, ''));
  });
  return record;
}

/** Change a display preference without disturbing what is on screen. */
export async function patchConfig(
  deps: StartPageDeps,
  patch: Partial<Pick<StartPageConfigRecord, 'searchMode' | 'openTarget' | 'density'>>,
): Promise<StartPageConfigRecord | null> {
  const identity = await identityOf(deps);
  if (!identity) return null;
  const current = await deps.db.startPageConfigs.get(identity.configId);
  if (!current) return null;
  const next = { ...current, ...patch, configGeneration: current.configGeneration + 1, updatedAt: Date.now() };
  await deps.db.startPageConfigs.put(next);
  return next;
}

/**
 * Forget this device's start page entirely.
 *
 * Called when the source is released and when the device is unpaired: both
 * leave no reader behind who is entitled to the cached tree. Sync state is not
 * touched — a start page and a binding are different decisions (§5.3).
 */
export async function clearStartPage(db: PontisDB, deviceId: string): Promise<void> {
  await db.transaction('rw', [db.startPageConfigs, db.startPageSnapshots], async () => {
    await db.startPageSnapshots.where('deviceId').equals(deviceId).delete();
    await db.startPageConfigs.where('deviceId').equals(deviceId).delete();
  });
}

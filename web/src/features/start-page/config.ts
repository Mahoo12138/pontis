// The browser's own start-page preference (start-page doc §8, §12).
//
// It lives in localStorage under the signed-in account because it describes
// this browser, not this user: two accounts on one machine may show different
// folders, and one account in the extension and in the web page are separate
// environments that share nothing (§4.2). Nothing here is a sync input — the
// generation counter exists so an in-flight response can be recognised as
// belonging to a configuration the user has already replaced.

export type StartPageSearchMode = 'web' | 'bookmarks';
export type StartPageOpenTarget = 'current-tab' | 'new-tab';
export type StartPageDensity = 'standard' | 'compact';

export interface StartPageSourceConfig {
  spaceId: string;
  folderId: string;
  /** Empty on a session read: the web page is bounded by ownership, not by a
   * device grant. The fields stay in the shape so the extension, which does
   * have a grant, can write the same record. */
  grantId?: string;
  grantVersion?: number;
}

export interface StartPageConfig {
  schemaVersion: 1;
  instanceId: string;
  userId: string;
  deviceId?: string;
  source: StartPageSourceConfig | null;
  searchMode: StartPageSearchMode;
  openTarget: StartPageOpenTarget;
  density: StartPageDensity;
  configGeneration: number;
  updatedAt: string;
}

const KEY_PREFIX = 'pontis:start-page:v1:';

export function defaultConfig(userId: string, instanceId: string): StartPageConfig {
  return {
    schemaVersion: 1,
    instanceId,
    userId,
    // No source is guessed. "Which folder should this show?" is the one
    // question the page must not answer for the user (§15, SP-01).
    source: null,
    searchMode: 'web',
    openTarget: 'current-tab',
    density: 'standard',
    configGeneration: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

/** Read this account's preference, or the unset default.
 *
 * Anything unparseable or from a schema we no longer understand is discarded
 * rather than patched: a half-read config could point the page at a folder id
 * from another account's tree. */
export function loadConfig(userId: string, instanceId: string): StartPageConfig {
  const fallback = defaultConfig(userId, instanceId);
  if (!userId) return fallback;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY_PREFIX + userId);
  } catch {
    // A browser that refuses storage still gets a usable page; it just starts
    // unconfigured every time.
    return fallback;
  }
  if (!raw) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const shape = asRecord(parsed);
  if (!shape || shape.schemaVersion !== 1 || shape.userId !== userId) return fallback;

  const source = asRecord(shape.source);
  return {
    ...fallback,
    instanceId: typeof shape.instanceId === 'string' ? shape.instanceId : instanceId,
    // The saved instance is what tells a leftover config from a previous
    // deployment on the same origin from one the user means.
    source:
      source && typeof source.spaceId === 'string' && typeof source.folderId === 'string'
        ? {
            spaceId: source.spaceId,
            folderId: source.folderId,
            grantId: typeof source.grantId === 'string' ? source.grantId : undefined,
            grantVersion: typeof source.grantVersion === 'number' ? source.grantVersion : undefined,
          }
        : null,
    searchMode: shape.searchMode === 'bookmarks' ? 'bookmarks' : 'web',
    openTarget: shape.openTarget === 'new-tab' ? 'new-tab' : 'current-tab',
    density: shape.density === 'compact' ? 'compact' : 'standard',
    configGeneration: typeof shape.configGeneration === 'number' ? shape.configGeneration : 0,
    updatedAt: typeof shape.updatedAt === 'string' ? shape.updatedAt : fallback.updatedAt,
  };
}

/** Persist a change and move the generation, so a response started before this
 * write can be recognised as stale when it lands (§14.3). */
export function saveConfig(
  userId: string,
  instanceId: string,
  patch: Partial<Omit<StartPageConfig, 'schemaVersion' | 'userId' | 'configGeneration'>>,
): StartPageConfig {
  const current = loadConfig(userId, instanceId);
  const next: StartPageConfig = {
    ...current,
    ...patch,
    schemaVersion: 1,
    userId,
    instanceId: patch.instanceId ?? current.instanceId,
    configGeneration: current.configGeneration + 1,
    updatedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(KEY_PREFIX + userId, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the in-memory config still drives this tab, and
    // the next load falls back to the default rather than to a wrong source.
  }
  return next;
}

/** Drop this account's preference.
 *
 * Signing out has to take the private folder choice with it. §14.4 is explicit
 * that this is a local act: a browser already closed cannot be reached later. */
export function clearConfig(userId: string): void {
  if (!userId) return;
  try {
    localStorage.removeItem(KEY_PREFIX + userId);
  } catch {
    // Nothing to clean up in a browser that will not store anything anyway.
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

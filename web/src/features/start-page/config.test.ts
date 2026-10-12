// The preference is the one piece of start-page state that outlives a tab, so
// these tests are about what it must refuse to remember: another account's
// source, a schema it no longer reads, and a value that only half describes a
// folder.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfig, defaultConfig, loadConfig, saveConfig } from './config';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
}

function fakeStorage(): StorageLike {
  // A plain object as the backing store, reached through a proxy, so
  // `Object.keys(storage)` lists the saved entries the way a browser's does.
  const data: Record<string, string> = {};
  const api = {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = String(v);
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
  };
  // The proxy's target is the saved entries, which is what makes
  // `Object.keys(storage)` list them the way a browser's does; the storage
  // methods come from the trap, so the type has to say so too.
  return new Proxy(data, {
    get: (target, prop) =>
      typeof prop === 'string' && prop in api
        ? (api as unknown as Record<string, unknown>)[prop]
        : (target as Record<string | symbol, unknown>)[prop],
  }) as unknown as StorageLike;
}

let store: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  store = fakeStorage();
  vi.stubGlobal('localStorage', store);
});

describe('loadConfig', () => {
  it('starts with no source at all', () => {
    // Nothing about the account implies which folder this browser should
    // show; guessing one would publish private bookmarks by default (§15).
    const config = loadConfig('user-1', 'instance-1');
    expect(config).toEqual(defaultConfig('user-1', 'instance-1'));
    expect(config.source).toBeNull();
  });

  it('keeps what it recognises and drops the rest', () => {
    saveConfig('user-1', 'instance-1', {
      source: { spaceId: 'space-1', folderId: 'folder-1' },
      density: 'compact',
    });
    const config = loadConfig('user-1', 'instance-1');
    expect(config.source).toEqual({
      spaceId: 'space-1',
      folderId: 'folder-1',
      grantId: undefined,
      grantVersion: undefined,
    });
    expect(config.density).toBe('compact');
  });

  it("will not read another account's preference", () => {
    saveConfig('user-1', 'instance-1', { source: { spaceId: 's', folderId: 'f' } });
    // Same origin, shared storage, different visitor.
    expect(loadConfig('user-2', 'instance-1').source).toBeNull();
  });

  it('discards a body it cannot make sense of', () => {
    for (const raw of ['not json', '[]', 'null', '"a string"', '{"schemaVersion":2}']) {
      store.setItem('pontis:start-page:v1:user-1', raw);
      expect(loadConfig('user-1', 'instance-1').source).toBeNull();
    }
  });

  it('refuses a source half of which is missing', () => {
    store.setItem(
      'pontis:start-page:v1:user-1',
      JSON.stringify({ schemaVersion: 1, userId: 'user-1', source: { spaceId: 's' } }),
    );
    expect(loadConfig('user-1', 'instance-1').source).toBeNull();
  });

  it('survives a browser that will not store anything', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    });
    expect(loadConfig('user-1', 'instance-1').source).toBeNull();
    // Saving must not throw either: the tab keeps working, it just forgets.
    expect(() => saveConfig('user-1', 'instance-1', { density: 'compact' })).not.toThrow();
  });
});

describe('saveConfig', () => {
  it('moves the generation on every write', () => {
    // An in-flight snapshot is compared against this: a response from before
    // the user changed something has to be recognised as stale (§14.3).
    let config = loadConfig('user-1', 'instance-1');
    expect(config.configGeneration).toBe(0);
    config = saveConfig('user-1', 'instance-1', { density: 'compact' });
    expect(config.configGeneration).toBe(1);
    config = saveConfig('user-1', 'instance-1', { searchMode: 'bookmarks' });
    expect(config.configGeneration).toBe(2);
    expect(config.density).toBe('compact');
  });

  it('can un-set the source explicitly', () => {
    saveConfig('user-1', 'instance-1', { source: { spaceId: 's', folderId: 'f' } });
    const cleared = saveConfig('user-1', 'instance-1', { source: null });
    expect(cleared.source).toBeNull();
    expect(loadConfig('user-1', 'instance-1').source).toBeNull();
  });
});

describe('clearConfig', () => {
  it('forgets this account and leaves the next one alone', () => {
    saveConfig('user-1', 'instance-1', { source: { spaceId: 's', folderId: 'f' } });
    saveConfig('user-2', 'instance-1', { source: { spaceId: 's2', folderId: 'f2' } });

    clearConfig('user-1');

    // A private folder left behind under a signed-out account is the failure
    // this exists to prevent (§14.4).
    expect(loadConfig('user-1', 'instance-1').source).toBeNull();
    expect(loadConfig('user-2', 'instance-1').source?.folderId).toBe('f2');
  });
});

// Narrow, structural typing for the chrome.* surface the extension uses.
// Keeps the core free of @types/chrome and makes the entrypoints testable.

import type { KVArea } from '../core/store/bootstrap';
import type { ChromeBookmarksApi } from '../core/browser/chromium';

/**
 * The real chrome.storage shape: `get(key)` resolves to an object keyed by the
 * requested keys, not to the stored value. Passing this straight to code that
 * expects a KVArea makes every read come back empty.
 */
export interface ChromeStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface ChromeAlarmsApi {
  create(name: string, alarmInfo: { periodInMinutes?: number }): void;
  onAlarm: { addListener(cb: (alarm: { name: string }) => void): void };
}

export interface ChromeRuntimeApi {
  onStartup: { addListener(cb: () => void): void };
  /** Fires after the extension is installed or updated. */
  onInstalled: {
    addListener(cb: (details: { reason: 'install' | 'update' | string }) => void): void;
  };
  onMessage: {
    addListener(cb: (msg: unknown, sender: unknown, sendResponse: (resp?: unknown) => void) => boolean | void): void;
  };
  sendMessage(message: unknown): Promise<unknown>;
  getURL(path: string): string;
}

/**
 * Chrome's default-search provider surface. `tab` is optional and defaults to
 * the CURRENT tab, which is what the start page wants: submitting from the
 * page that received the keystroke means the query cannot land in some other
 * tab that took focus while the request was in flight (start-page doc §7.2).
 */
export interface ChromeSearchApi {
  query(queryInfo: { text: string }, options?: { tab?: unknown }): Promise<void>;
}

export interface ChromeGlobal {
  bookmarks: ChromeBookmarksApi;
  /** Absent on a browser without chrome.search; the start page then says so
   * rather than substituting an engine nobody chose. */
  search?: ChromeSearchApi;
  /** Only `create` is used: the guide and the settings page open as tabs. */
  tabs: { create(props: { url: string }): Promise<unknown> };
  storage: { local: ChromeStorageArea };
  alarms: ChromeAlarmsApi;
  runtime: ChromeRuntimeApi;
  /**
   * Optional host permissions. Fetching the user's self-hosted server without
   * them is a cross-origin request, and the server deliberately sends no CORS
   * headers, so pairing is blocked until this origin is granted.
   */
  permissions: {
    request(details: { permissions?: string[]; origins?: string[] }, callback: (granted: boolean) => void): void;
    contains(details: { origins?: string[] }): Promise<boolean>;
  };
}

export function chromeApi(): ChromeGlobal {
  const c = (globalThis as { chrome?: Partial<ChromeGlobal> }).chrome;
  if (!c?.bookmarks || !c.storage || !c.alarms || !c.runtime || !c.permissions || !c.tabs) {
    throw new Error('Pontis: chrome APIs unavailable in this context');
  }
  return c as ChromeGlobal;
}

/** Adapt chrome.storage.local to the plain KV surface the core stores use. */
export function kvArea(local: ChromeStorageArea): KVArea {
  return {
    async get(key: string) {
      const items = await local.get(key);
      return items?.[key];
    },
    async set(items: Record<string, unknown>) {
      await local.set(items);
    },
    async remove(keys: string[]) {
      await local.remove(keys);
    },
  };
}

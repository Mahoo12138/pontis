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
  onMessage: {
    addListener(cb: (msg: unknown, sender: unknown, sendResponse: (resp?: unknown) => void) => boolean | void): void;
  };
  sendMessage(message: unknown): Promise<unknown>;
  getURL(path: string): string;
}

export interface ChromeGlobal {
  bookmarks: ChromeBookmarksApi;
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
  if (!c?.bookmarks || !c.storage || !c.alarms || !c.runtime || !c.permissions) {
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

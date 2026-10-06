// Narrow, structural typing for the chrome.* surface the extension uses.
// Keeps the core free of @types/chrome and makes the entrypoints testable.

import type { KVArea } from '../core/store/bootstrap';
import type { ChromeBookmarksApi } from '../core/browser/chromium';

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
  storage: { local: KVArea };
  alarms: ChromeAlarmsApi;
  runtime: ChromeRuntimeApi;
}

export function chromeApi(): ChromeGlobal {
  const c = (globalThis as { chrome?: Partial<ChromeGlobal> }).chrome;
  if (!c?.bookmarks || !c.storage || !c.alarms || !c.runtime) {
    throw new Error('Pontis: chrome APIs unavailable in this context');
  }
  return c as ChromeGlobal;
}

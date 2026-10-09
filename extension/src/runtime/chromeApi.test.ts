// chrome.storage.local resolves get() to an object keyed by the requested
// keys. The core stores read a plain KV surface, so the adapter is the only
// place that difference may exist — passing the raw area made every read of the
// pairing record come back empty in a real browser while all mocks passed.

import { describe, expect, it } from 'vitest';

import { BootstrapStore, BOOTSTRAP_KEY, type BootstrapData } from '../core/store/bootstrap';
import { kvArea, type ChromeStorageArea } from './chromeApi';

/** Mimics the real chrome.storage.local contract, not the KVArea one. */
function chromeLikeStorage(): ChromeStorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
  };
}

describe('kvArea', () => {
  it('reads back the value a BootstrapStore wrote', async () => {
    const local = chromeLikeStorage();
    const store = new BootstrapStore(kvArea(local));

    await store.set({ serverUrl: 'http://127.0.0.1:8080', deviceToken: 'pdv_test' });

    expect(await store.get()).toMatchObject({ serverUrl: 'http://127.0.0.1:8080', deviceToken: 'pdv_test' });
    expect(local.data[BOOTSTRAP_KEY]).toMatchObject({ deviceToken: 'pdv_test' } as Partial<BootstrapData>);
  });

  it('returns an empty record when nothing is stored', async () => {
    const store = new BootstrapStore(kvArea(chromeLikeStorage()));
    expect(await store.get()).toEqual({});
  });

  it('shows why the adapter is needed: the raw area hands back the key wrapper', async () => {
    const local = chromeLikeStorage();
    await local.set({ [BOOTSTRAP_KEY]: { deviceToken: 'pdv_test' } });
    const unwrapped = await local.get(BOOTSTRAP_KEY);
    expect(unwrapped).not.toMatchObject({ deviceToken: 'pdv_test' });
    expect((unwrapped as Record<string, unknown>)[BOOTSTRAP_KEY]).toMatchObject({ deviceToken: 'pdv_test' });
  });
});

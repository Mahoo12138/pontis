// Bootstrap secrets/preferences live in browser.storage.local only
// (doc 05 §3). Never browser.storage.sync; never the replica state.

export interface BootstrapData {
  serverUrl?: string;
  instanceId?: string;
  deviceId?: string;
  deviceToken?: string;
  deviceName?: string;
  pairedAt?: number;
}

/** Minimal async KV surface, satisfied by chrome.storage.local. */
export interface KVArea {
  get(key: string): Promise<unknown>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export const BOOTSTRAP_KEY = 'bootstrap';

export class BootstrapStore {
  constructor(private area: KVArea) {}

  async get(): Promise<BootstrapData> {
    const value = (await this.area.get(BOOTSTRAP_KEY)) as BootstrapData | undefined;
    return value ?? {};
  }

  async set(patch: Partial<BootstrapData>): Promise<void> {
    const current = await this.get();
    await this.area.set({ [BOOTSTRAP_KEY]: { ...current, ...patch } });
  }

  async clearPairing(): Promise<void> {
    await this.set({ deviceId: undefined, deviceToken: undefined, pairedAt: undefined });
  }
}

// Pairing flow (doc 09 / server handlers.go): login with a user session,
// register this extension as a Device (secret shown exactly once), then
// create a Binding to a Space. The bootstrap (server URL + device token)
// goes to browser.storage.local; the binding row goes to the replica DB.

import type { ApiClient } from '../transport/client';
import type { BootstrapStore } from '../store/bootstrap';
import type { BindingMount, BindingRecord, PontisDB } from '../store/db';

export interface PairingResult {
  deviceId: string;
  instanceId: string;
}

export class PairingService {
  constructor(
    private client: ApiClient,
    private bootstrap: BootstrapStore,
    private db: PontisDB,
  ) {}

  /** Login → register device → persist bootstrap. */
  async pair(params: {
    serverUrl: string;
    username: string;
    password: string;
    deviceName: string;
    browser: string;
    platform: string;
  }): Promise<PairingResult> {
    const meta = await this.client.meta();
    // Session token doubles as a Bearer credential for device registration.
    const login = await this.client.login(params.username, params.password);
    const { device, token } = await this.client.registerDevice(login.token, {
      name: params.deviceName,
      client_type: 'extension',
      browser: params.browser,
      platform: params.platform,
    });
    await this.bootstrap.set({
      serverUrl: params.serverUrl.replace(/\/+$/, ''),
      instanceId: meta.instance_id,
      deviceId: device.id,
      deviceToken: token,
      deviceName: params.deviceName,
      pairedAt: Date.now(),
    });
    return { deviceId: device.id, instanceId: meta.instance_id };
  }

  async listSpaces(): Promise<{ id: string; name: string }[]> {
    const { deviceToken } = await this.bootstrap.get();
    if (!deviceToken) throw new Error('not paired');
    const { spaces } = await this.client.deviceSpaces(deviceToken);
    return spaces.map((s) => ({ id: s.id, name: s.name }));
  }

  /** Create a server binding + the local binding row (partial mount). */
  async bindSpace(spaceId: string, spaceName: string, mountFolderBrowserId: string): Promise<BindingRecord> {
    const { deviceToken } = await this.bootstrap.get();
    if (!deviceToken) throw new Error('not paired');
    const wire = await this.client.createBinding(deviceToken, spaceId);
    const mount: BindingMount = { mode: 'partial', folderBrowserId: mountFolderBrowserId, rootKey: 'main' };
    const record: BindingRecord = {
      id: wire.id,
      spaceId: wire.space_id,
      spaceName,
      mode: 'partial',
      state: 'active',
      epoch: wire.epoch,
      appliedRevision: wire.applied_revision,
      receivedRevision: wire.received_revision,
      clientSeq: 0,
      mount,
      lastSyncAt: null,
      recovery: null,
      createdAt: Date.now(),
    };
    await this.db.bindings.put(record);
    return record;
  }

  /** Remove the local binding row (server-side revoke comes later). */
  async unbind(bindingId: string): Promise<void> {
    await this.db.bindings.delete(bindingId);
  }

  async isPaired(): Promise<boolean> {
    const b = await this.bootstrap.get();
    return Boolean(b.serverUrl && b.deviceToken);
  }
}

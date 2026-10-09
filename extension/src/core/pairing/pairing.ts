// Pairing flow (doc 09 / server handlers.go): login with a user session,
// register this extension as a Device (secret shown exactly once), then
// create a Binding to a Space. The bootstrap (server URL + device token)
// goes to browser.storage.local; the binding row goes to the replica DB.

import type { ApiClient } from '../transport/client';
import type { BootstrapStore } from '../store/bootstrap';
import { logDiagnostic, type BindingMount, type BindingRecord, type PontisDB } from '../store/db';

export interface PairingResult {
  deviceId: string;
  instanceId: string;
}

/**
 * The host-permission pattern covering a server URL. Chrome match patterns
 * drop the default port and need an explicit path, and the whole origin is
 * requested — not a deeper path the user typed.
 */
export function originPatternFor(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`pairing: unsupported server scheme ${url.protocol}`);
  }
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}/*`;
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
    // Pairing under a different device credential invalidates every local
    // binding: those replicas were built by another device, and the server will
    // refuse their syncs with NOT_BINDING_OWNER forever.
    const previous = await this.bootstrap.get();
    const meta = await this.client.meta(params.serverUrl);
    // Session token doubles as a Bearer credential for device registration.
    const login = await this.client.login(params.username, params.password, params.serverUrl);
    const { device, token } = await this.client.registerDevice(
      login.token,
      {
        name: params.deviceName,
        client_type: 'extension',
        browser: params.browser,
        platform: params.platform,
      },
      params.serverUrl,
    );
    await this.bootstrap.set({
      serverUrl: params.serverUrl.replace(/\/+$/, ''),
      instanceId: meta.instance_id,
      deviceId: device.id,
      deviceToken: token,
      deviceName: params.deviceName,
      pairedAt: Date.now(),
    });
    if (previous.deviceId && previous.deviceId !== device.id) await this.dropForeignReplicas(previous.deviceId);
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
      // The server opens a fresh binding as pending_initial and only an
      // initial reconciliation activates it; syncing it before that would
      // apply changes onto an unmapped tree.
      state: wire.state === 'active' ? 'active' : 'pending_initial',
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

  /**
   * Unbind: revoke the server's row, then drop this binding's replica state.
   * Both halves matter. Leaving the server binding active is what made the
   * space impossible to bind again (409 BINDING_EXISTS), and leaving the local
   * mirrors behind would let the next initial reconciliation find mappings for
   * a tree it is about to rebuild.
   */
  async unbind(bindingId: string): Promise<void> {
    const { deviceToken } = await this.bootstrap.get();
    if (deviceToken) await this.client.revokeBinding(deviceToken, bindingId);
    await this.db.transaction(
      'rw',
      [
        this.db.bindings,
        this.db.localNodes,
        this.db.pendingOps,
        this.db.expectedMutations,
        this.db.remoteChanges,
        this.db.reconSessions,
        this.db.emergencySnapshots,
      ],
      async () => {
        await this.db.bindings.delete(bindingId);
        await this.db.localNodes.where('bindingId').equals(bindingId).delete();
        await this.db.pendingOps.where('bindingId').equals(bindingId).delete();
        await this.db.expectedMutations.where('bindingId').equals(bindingId).delete();
        await this.db.remoteChanges.where('bindingId').equals(bindingId).delete();
        await this.db.reconSessions.where('bindingId').equals(bindingId).delete();
        await this.db.emergencySnapshots.where('bindingId').equals(bindingId).delete();
      },
    );
  }

  /**
   * Forget the bindings another device registered with the same profile. Only
   * local state is touched: those server bindings still belong to the old
   * device, and this one cannot revoke them.
   */
  private async dropForeignReplicas(previousDeviceId: string): Promise<void> {
    const stale = await this.db.bindings.toArray();
    await this.db.transaction(
      'rw',
      [
        this.db.bindings,
        this.db.localNodes,
        this.db.pendingOps,
        this.db.expectedMutations,
        this.db.remoteChanges,
        this.db.reconSessions,
        this.db.emergencySnapshots,
      ],
      async () => {
        for (const b of stale) {
          await this.db.bindings.delete(b.id);
          await this.db.localNodes.where('bindingId').equals(b.id).delete();
          await this.db.pendingOps.where('bindingId').equals(b.id).delete();
          await this.db.expectedMutations.where('bindingId').equals(b.id).delete();
          await this.db.remoteChanges.where('bindingId').equals(b.id).delete();
          await this.db.reconSessions.where('bindingId').equals(b.id).delete();
          await this.db.emergencySnapshots.where('bindingId').equals(b.id).delete();
        }
      },
    );
    await logDiagnostic(this.db, 'warn', 'pairing', 're-paired with a new device, local bindings dropped', {
      previousDeviceId,
      bindingCount: stale.length,
    });
  }

  async isPaired(): Promise<boolean> {
    const b = await this.bootstrap.get();
    return Boolean(b.serverUrl && b.deviceToken);
  }
}

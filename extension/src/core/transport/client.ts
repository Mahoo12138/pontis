// Thin HTTP transport over native fetch (doc 19: no heavy client).
// Errors are normalized to ApiError with the server's machine error.code;
// sync logic must act on the code, not the message (doc 04 §14).

import {
  isProtocolErrorCode,
  type BindingWire,
  type ClientSnapshotWire,
  type DeviceWire,
  type MetaWire,
  type ReconciliationEnvelopeWire,
  type ReconciliationType,
  type ServerSnapshotPageWire,
  type ServerSnapshotWire,
  type SnapshotWire,
  type SpaceWire,
  type StepsWire,
  type SyncRequestWire,
  type SyncResponseWire,
  type TransferRequestWire,
  type TransferResponseWire,
} from '../protocol/types';
import {
  parseReconciliationEnvelope,
  parseServerSnapshot,
  parseServerSnapshotPage,
  parseSnapshotResponse,
  parseSteps,
  parseSyncResponse,
} from '../protocol/validate';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ApiError';
  }

  get isProtocolError(): boolean {
    return isProtocolErrorCode(this.code);
  }
}

export interface ClientConfig {
  serverUrl: string;
  token?: string;
}

export interface LoginResult {
  token: string;
  expires_at: string;
  user: { id: string; username: string; display_name: string };
}

/** Transport contract consumed by the SyncCoordinator (mockable). */
export interface SyncTransport {
  sync(bindingId: string, req: SyncRequestWire): Promise<SyncResponseWire>;
}

/** Canonical snapshot read (doc 06 §8); optional transport extension. */
export interface SnapshotTransport {
  fetchSnapshot(bindingId: string): Promise<SnapshotWire>;
}

/** Cross-space transfer upload (doc 08 §15); optional transport extension. */
export interface TransferTransport {
  createTransfer(req: TransferRequestWire): Promise<TransferResponseWire>;
}

/**
 * The reconciliation lifecycle (doc 08 §9-§13): the only way a pending
 * binding becomes active, and the way a broken mapping is rebuilt. Every
 * answer is a session envelope, so a worker kill can resume from the phase
 * the last call reported.
 */
export interface ReconciliationTransport {
  createReconciliation(bindingId: string, type: ReconciliationType, reason: string): Promise<ReconciliationEnvelopeWire>;
  submitClientSnapshot(bindingId: string, snapshot: ClientSnapshotWire): Promise<ReconciliationEnvelopeWire>;
  createServerSnapshot(bindingId: string): Promise<ServerSnapshotWire>;
  listServerSnapshotNodes(snapshotId: string, cursor?: string, limit?: number): Promise<ServerSnapshotPageWire>;
  getReconciliation(sessionId: string): Promise<ReconciliationEnvelopeWire>;
  planReconciliation(sessionId: string): Promise<ReconciliationEnvelopeWire>;
  decideReconciliation(sessionId: string, decisions: Record<string, string>): Promise<ReconciliationEnvelopeWire>;
  commitReconciliation(sessionId: string): Promise<ReconciliationEnvelopeWire>;
  fetchSteps(sessionId: string): Promise<StepsWire>;
  completeReconciliation(sessionId: string): Promise<ReconciliationEnvelopeWire>;
}

export class ApiClient implements SyncTransport, SnapshotTransport, TransferTransport, ReconciliationTransport {
  constructor(private resolveConfig: () => Promise<ClientConfig>) {}

  private async request<T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      token?: string;
      /** Base URL for the calls a pairing makes before anything is stored. */
      serverUrl?: string;
      validate?: (json: unknown) => T;
    } = {},
  ): Promise<T> {
    const { serverUrl: stored, token } = await this.resolveConfig();
    const serverUrl = init.serverUrl ?? stored;
    if (!serverUrl) throw new ApiError(0, 'NOT_PAIRED', `no server URL to send ${path} to`);
    const auth = init.token ?? token;
    let res: Response;
    try {
      res = await fetch(serverUrl.replace(/\/+$/, '') + path, {
        method: init.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (cause) {
      throw new ApiError(0, 'NETWORK_ERROR', `request to ${path} failed: ${String(cause)}`);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } }).error;
      throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? res.statusText);
    }
    // A `as T` cast would let a malformed body (null where an array is
    // required) reach the consumer; validate at the boundary instead.
    if (init.validate) return init.validate(json);
    return json as T;
  }

  meta(serverUrl?: string): Promise<MetaWire> {
    return this.request<MetaWire>('/api/v1/meta', { serverUrl });
  }

  login(username: string, password: string, serverUrl?: string): Promise<LoginResult> {
    return this.request<LoginResult>('/api/v1/auth/login', { method: 'POST', body: { username, password }, serverUrl });
  }

  registerDevice(sessionToken: string, body: { name: string; client_type: string; browser: string; platform: string }, serverUrl?: string): Promise<{ device: DeviceWire; token: string }> {
    return this.request('/api/v1/devices', { method: 'POST', token: sessionToken, body, serverUrl });
  }

  deviceSpaces(deviceToken: string): Promise<{ spaces: SpaceWire[] }> {
    return this.request('/api/v1/device/spaces', { token: deviceToken });
  }

  createBinding(deviceToken: string, spaceId: string): Promise<BindingWire> {
    return this.request('/api/v1/device/bindings', { method: 'POST', token: deviceToken, body: { space_id: spaceId } });
  }

  /** Unbind: the server resets this device's binding, the space keeps its data. */
  revokeBinding(deviceToken: string, bindingId: string): Promise<BindingWire> {
    return this.request(`/api/v1/device/bindings/${bindingId}`, { method: 'DELETE', token: deviceToken });
  }

  sync(bindingId: string, req: SyncRequestWire): Promise<SyncResponseWire> {
    return this.request<SyncResponseWire>(`/api/v1/sync/bindings/${bindingId}`, {
      method: 'POST',
      body: req,
      validate: parseSyncResponse,
    });
  }

  fetchSnapshot(bindingId: string): Promise<SnapshotWire> {
    return this.request<SnapshotWire>(`/api/v1/sync/bindings/${bindingId}/snapshot`, {
      validate: parseSnapshotResponse,
    });
  }

  createTransfer(req: TransferRequestWire): Promise<TransferResponseWire> {
    // The resolved token is the device credential, matching the endpoint's
    // auth group (POST /api/v1/sync/transfers).
    return this.request<TransferResponseWire>('/api/v1/sync/transfers', { method: 'POST', body: req });
  }

  createReconciliation(bindingId: string, type: ReconciliationType, reason: string): Promise<ReconciliationEnvelopeWire> {
    return this.request<ReconciliationEnvelopeWire>(`/api/v1/sync/bindings/${bindingId}/reconciliations`, {
      method: 'POST',
      body: { type, reason },
      validate: parseReconciliationEnvelope,
    });
  }

  submitClientSnapshot(bindingId: string, snapshot: ClientSnapshotWire): Promise<ReconciliationEnvelopeWire> {
    return this.request<ReconciliationEnvelopeWire>(`/api/v1/sync/bindings/${bindingId}/client-snapshots`, {
      method: 'POST',
      body: snapshot,
      validate: parseReconciliationEnvelope,
    });
  }

  createServerSnapshot(bindingId: string): Promise<ServerSnapshotWire> {
    return this.request<ServerSnapshotWire>(`/api/v1/sync/bindings/${bindingId}/server-snapshots`, {
      method: 'POST',
      validate: parseServerSnapshot,
    });
  }

  listServerSnapshotNodes(snapshotId: string, cursor?: string, limit?: number): Promise<ServerSnapshotPageWire> {
    const query = new URLSearchParams();
    if (cursor) query.set('cursor', cursor);
    if (limit) query.set('limit', String(limit));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.request<ServerSnapshotPageWire>(`/api/v1/sync/server-snapshots/${snapshotId}/nodes${suffix}`, {
      validate: parseServerSnapshotPage,
    });
  }

  getReconciliation(sessionId: string): Promise<ReconciliationEnvelopeWire> {
    return this.request<ReconciliationEnvelopeWire>(`/api/v1/sync/reconciliations/${sessionId}`, {
      validate: parseReconciliationEnvelope,
    });
  }

  planReconciliation(sessionId: string): Promise<ReconciliationEnvelopeWire> {
    return this.request<ReconciliationEnvelopeWire>(`/api/v1/sync/reconciliations/${sessionId}/plan`, {
      method: 'POST',
      validate: parseReconciliationEnvelope,
    });
  }

  decideReconciliation(sessionId: string, decisions: Record<string, string>): Promise<ReconciliationEnvelopeWire> {
    // Decisions are keyed by issue id and valued by a candidate the plan
    // offered; an empty value keeps the server's safe default (doc 08 §11).
    return this.request<ReconciliationEnvelopeWire>(`/api/v1/sync/reconciliations/${sessionId}/decisions`, {
      method: 'PUT',
      body: { decisions },
      validate: parseReconciliationEnvelope,
    });
  }

  commitReconciliation(sessionId: string): Promise<ReconciliationEnvelopeWire> {
    return this.request<ReconciliationEnvelopeWire>(`/api/v1/sync/reconciliations/${sessionId}/commit`, {
      method: 'POST',
      validate: parseReconciliationEnvelope,
    });
  }

  fetchSteps(sessionId: string): Promise<StepsWire> {
    return this.request<StepsWire>(`/api/v1/sync/reconciliations/${sessionId}/steps`, {
      validate: parseSteps,
    });
  }

  completeReconciliation(sessionId: string): Promise<ReconciliationEnvelopeWire> {
    return this.request<ReconciliationEnvelopeWire>(`/api/v1/sync/reconciliations/${sessionId}/complete`, {
      method: 'POST',
      validate: parseReconciliationEnvelope,
    });
  }
}

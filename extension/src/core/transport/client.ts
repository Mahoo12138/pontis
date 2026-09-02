// Thin HTTP transport over native fetch (doc 19: no heavy client).
// Errors are normalized to ApiError with the server's machine error.code;
// sync logic must act on the code, not the message (doc 04 §14).

import {
  isProtocolErrorCode,
  type BindingWire,
  type DeviceWire,
  type MetaWire,
  type SnapshotWire,
  type SpaceWire,
  type SyncRequestWire,
  type SyncResponseWire,
  type TransferRequestWire,
  type TransferResponseWire,
} from '../protocol/types';

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

export class ApiClient implements SyncTransport, SnapshotTransport, TransferTransport {
  constructor(private resolveConfig: () => Promise<ClientConfig>) {}

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<T> {
    const { serverUrl, token } = await this.resolveConfig();
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
    return json as T;
  }

  meta(): Promise<MetaWire> {
    return this.request<MetaWire>('/api/v1/meta');
  }

  login(username: string, password: string): Promise<LoginResult> {
    return this.request<LoginResult>('/api/v1/auth/login', { method: 'POST', body: { username, password } });
  }

  registerDevice(sessionToken: string, body: { name: string; client_type: string; browser: string; platform: string }): Promise<{ device: DeviceWire; token: string }> {
    return this.request('/api/v1/devices', { method: 'POST', token: sessionToken, body });
  }

  deviceSpaces(deviceToken: string): Promise<{ spaces: SpaceWire[] }> {
    return this.request('/api/v1/device/spaces', { token: deviceToken });
  }

  createBinding(deviceToken: string, spaceId: string): Promise<BindingWire> {
    return this.request('/api/v1/device/bindings', { method: 'POST', token: deviceToken, body: { space_id: spaceId } });
  }

  sync(bindingId: string, req: SyncRequestWire): Promise<SyncResponseWire> {
    return this.request<SyncResponseWire>(`/api/v1/sync/bindings/${bindingId}`, {
      method: 'POST',
      body: req,
    });
  }

  fetchSnapshot(bindingId: string): Promise<SnapshotWire> {
    return this.request<SnapshotWire>(`/api/v1/sync/bindings/${bindingId}/snapshot`);
  }

  createTransfer(req: TransferRequestWire): Promise<TransferResponseWire> {
    // The resolved token is the device credential, matching the endpoint's
    // auth group (POST /api/v1/sync/transfers).
    return this.request<TransferResponseWire>('/api/v1/sync/transfers', { method: 'POST', body: req });
  }
}

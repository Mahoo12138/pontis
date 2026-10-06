import {
  ApplyStep,
  ClientSnapshot,
  decodeServerSnapshot,
  decodeSession,
  decodeSnapshotNodes,
  decodeSyncResponse,
  encodeClientSnapshot,
  encodeSyncRequest,
  expectError,
  PROTOCOL_VERSION,
  ReconciliationType,
  ServerSnapshot,
  SnapshotNode,
  StepsPayload,
  SyncRequest,
  SyncResponse,
} from '@pontis/protocol';

/** The sync transport the coordinator drives; HTTP in production. */
export interface SyncTransport {
  sync(bindingId: string, req: SyncRequest): Promise<SyncResponse>;
}

/**
 * Device-scoped HTTP client for /sync and the reconciliation endpoints
 * (docs 04, 08). Transport failures throw; protocol failures throw a
 * ProtocolError carrying the stable error code.
 */
export class ServerClient implements SyncTransport {
  constructor(
    private baseUrl: string,
    private deviceToken: string,
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async sync(bindingId: string, req: SyncRequest): Promise<SyncResponse> {
    const data = await this.request('POST', `/api/v1/sync/bindings/${bindingId}`, encodeSyncRequest(req));
    return decodeSyncResponse(data);
  }

  // --- reconciliation (doc 08 §9-11) ---

  async createReconciliation(bindingId: string, body: { type: ReconciliationType; reason: string }): Promise<unknown> {
    return this.request('POST', `/api/v1/sync/bindings/${bindingId}/reconciliations`, body);
  }

  async submitClientSnapshot(bindingId: string, snapshot: ClientSnapshot): Promise<unknown> {
    return this.request('POST', `/api/v1/sync/bindings/${bindingId}/client-snapshots`, encodeClientSnapshot(snapshot));
  }

  async createServerSnapshot(bindingId: string): Promise<ServerSnapshot> {
    return decodeServerSnapshot(await this.request('POST', `/api/v1/sync/bindings/${bindingId}/server-snapshots`, {}));
  }

  async plan(reconciliationId: string): Promise<unknown> {
    return this.request('POST', `/api/v1/sync/reconciliations/${reconciliationId}/plan`, {});
  }

  async decide(reconciliationId: string, body: { decisions: Record<string, string> }): Promise<unknown> {
    return this.request('PUT', `/api/v1/sync/reconciliations/${reconciliationId}/decisions`, body);
  }

  async commit(reconciliationId: string): Promise<unknown> {
    return this.request('POST', `/api/v1/sync/reconciliations/${reconciliationId}/commit`, {});
  }

  async steps(reconciliationId: string): Promise<StepsPayload> {
    const data = (await this.request('GET', `/api/v1/sync/reconciliations/${reconciliationId}/steps`)) as {
      plan_hash: string;
      steps: StepsPayload['steps'];
    };
    return { plan_hash: data.plan_hash, steps: data.steps };
  }

  async complete(reconciliationId: string): Promise<unknown> {
    return this.request('POST', `/api/v1/sync/reconciliations/${reconciliationId}/complete`, {});
  }

  async serverSnapshotNodes(snapshotId: string, cursor: number, limit: number): Promise<{ nodes: SnapshotNode[]; has_more: boolean }> {
    const data = (await this.request('GET', `/api/v1/sync/server-snapshots/${snapshotId}/nodes?cursor=${cursor}&limit=${limit}`)) as {
      nodes: unknown[];
      has_more: boolean;
      next_cursor?: number;
    };
    return { nodes: decodeSnapshotNodes(data), has_more: data.has_more };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.deviceToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    const protocolErr = expectError(data);
    if (protocolErr) {
      protocolErr.message = `${protocolErr.code} [${method} ${path}]`;
      throw protocolErr;
    }
    if (!res.ok) {
      throw new Error(`client: http ${res.status} on ${method} ${path}`);
    }
    if (process.env.PONTIS_CLIENT_LOG) {
      console.log(`[CLIENT] ${method} ${path} -> ${res.status} ${JSON.stringify(data).slice(0, 140)}`);
    }
    return data;
  }
}

/** The protocol version the client speaks. */
export { PROTOCOL_VERSION };

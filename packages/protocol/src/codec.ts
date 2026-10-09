import {
  Change,
  ClientSnapshot,
  ErrorEnvelope,
  ProtocolError,
  ServerSnapshot,
  SnapshotNode,
  StepKind,
  SyncRequest,
  SyncResponse,
} from './types';

// Encode/decode helpers for the wire JSON. The Go server DTOs are the
// source of truth; fixtures/protocol golden files bind both sides.

export function encodeSyncRequest(req: SyncRequest): unknown {
  return req;
}

export function decodeSyncResponse(data: unknown): SyncResponse {
  const raw = data as Record<string, unknown>;
  return {
    protocol_version: num(raw.protocol_version),
    epoch: num(raw.epoch),
    journal_floor_revision: num(raw.journal_floor_revision),
    from_revision: num(raw.from_revision),
    through_revision: num(raw.through_revision),
    server_revision: num(raw.server_revision),
    has_more: raw.has_more === true,
    operation_results: arr(raw.operation_results, 'operation_results').map((r) => {
      const o = r as Record<string, unknown>;
      return {
        op_id: str(o.op_id),
        client_seq: num(o.client_seq),
        status: str(o.status) as SyncResponse['operation_results'][number]['status'],
        reason: str(o.reason),
        result_revision: num(o.result_revision),
        settle_after_revision: num(o.settle_after_revision),
      };
    }),
    changes: arr(raw.changes, 'changes').map(decodeChange),
  };
}

export function decodeChange(data: unknown): Change {
  const raw = data as Record<string, unknown>;
  return {
    revision: num(raw.revision),
    type: str(raw.type) as Change['type'],
    node_id: str(raw.node_id),
    payload: raw.payload as Change['payload'],
  };
}

/** Throws a ProtocolError when the body carries the error envelope. */
export function expectError(data: unknown): ProtocolError | null {
  const raw = data as ErrorEnvelope | undefined;
  if (raw && raw.error && typeof raw.error.code === 'string') {
    return new ProtocolError(raw.error.code, raw.error.message ?? '', raw.error.request_id ?? '');
  }
  return null;
}

// --- reconciliation wire decoding ---

export function decodeServerSnapshot(data: unknown): ServerSnapshot {
  const raw = data as Record<string, unknown>;
  return {
    snapshot_id: str(raw.snapshot_id),
    epoch: num(raw.epoch),
    revision: num(raw.revision),
    node_count: num(raw.node_count),
    checksum: str(raw.checksum),
    expires_at: raw.expires_at === undefined ? undefined : str(raw.expires_at),
  };
}

export function decodeSnapshotNodes(data: unknown): SnapshotNode[] {
  const raw = data as { nodes?: unknown };
  return ((raw.nodes ?? []) as Record<string, unknown>[]).map((n) => ({
    node_ref: str(n.node_ref),
    parent_ref: str(n.parent_ref),
    type: str(n.type) as SnapshotNode['type'],
    title: str(n.title),
    url: n.url === undefined ? undefined : str(n.url),
    root_key: n.root_key === undefined ? undefined : str(n.root_key),
    position: num(n.position),
  }));
}

export interface SessionWithIssues {
  session: { id: string; state: string; phase: string; target_epoch: number; target_revision: number; commit_revision: number };
  issues: { id: string; default_choice: string; payload: { source_ref: string; candidates: string[] } }[];
}

export function decodeSession(data: unknown): SessionWithIssues {
  const raw = data as Record<string, unknown>;
  return {
    session: {
      id: str(raw.id),
      state: str(raw.state),
      phase: str(raw.phase),
      target_epoch: num(raw.target_epoch),
      target_revision: num(raw.target_revision),
      commit_revision: num(raw.commit_revision),
    },
    issues: ((raw.issues ?? []) as Record<string, unknown>[]).map((i) => ({
      id: str(i.id),
      default_choice: str(i.default_choice),
      payload: i.payload as { source_ref: string; candidates: string[] },
    })),
  };
}

export interface StepsPayload {
  plan_hash: string;
  steps: {
    kind: StepKind;
    local_ref?: string;
    canonical_id?: string;
    type?: 'folder' | 'bookmark';
    title?: string;
    url?: string;
    parent?: { type: 'node' | 'root'; id?: string; key?: string };
    before_id?: string;
  }[];
}

export function encodeClientSnapshot(snapshot: ClientSnapshot): unknown {
  return snapshot;
}

function num(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new Error(`protocol: expected number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function str(v: unknown): string {
  if (typeof v !== 'string') {
    throw new Error(`protocol: expected string, got ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * Protocol arrays are always arrays; `null` means the producer broke the
 * contract and every consumer would iterate an invalid value.
 */
function arr(v: unknown, field: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new Error(`protocol: expected array for "${field}", got ${JSON.stringify(v)}`);
  }
  return v;
}

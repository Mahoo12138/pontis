import {
  Change,
  ClientSnapshot,
  ErrorEnvelope,
  ProtocolError,
  ReconciliationBinding,
  ReconciliationIssue,
  ReconciliationPlan,
  ReconciliationSession,
  ServerSnapshot,
  SessionEnvelope,
  SnapshotNode,
  SnapshotNodePage,
  StepKind,
  StepsPayload,
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
    binding_id: str(raw.binding_id),
    space_id: str(raw.space_id),
    epoch: num(raw.epoch),
    revision: num(raw.revision),
    node_count: num(raw.node_count),
    checksum: str(raw.checksum),
    expires_at: str(raw.expires_at),
    created_at: str(raw.created_at),
  };
}

export function decodeSnapshotNodePage(data: unknown): SnapshotNodePage {
  const raw = data as Record<string, unknown>;
  return {
    nodes: arr(raw.nodes, 'nodes').map((n) => {
      const node = n as Record<string, unknown>;
      return {
        node_ref: str(node.node_ref),
        parent_ref: str(node.parent_ref),
        type: str(node.type) as SnapshotNode['type'],
        title: str(node.title),
        url: node.url === undefined ? undefined : str(node.url),
        root_key: node.root_key === undefined ? undefined : str(node.root_key),
        position: num(node.position),
      };
    }),
    total: num(raw.total),
    // Empty cursor means this was the snapshot's last page.
    next_cursor: str(raw.next_cursor),
  };
}

/** One lifecycle answer: the session, its issues, and what the call added. */
export function decodeSessionEnvelope(data: unknown): SessionEnvelope {
  const raw = data as Record<string, unknown>;
  const session = decodeReconciliationSession(raw.session);
  const envelope: SessionEnvelope = { session, issues: decodeIssues(raw.issues) };
  if (raw.plan !== undefined) envelope.plan = decodePlan(raw.plan);
  if (raw.binding !== undefined) envelope.binding = decodeBinding(raw.binding);
  return envelope;
}

export function decodeReconciliationSession(data: unknown): ReconciliationSession {
  const raw = data as Record<string, unknown>;
  return {
    id: str(raw.id),
    binding_id: str(raw.binding_id),
    space_id: str(raw.space_id),
    type: str(raw.type) as ReconciliationSession['type'],
    reason: optStr(raw.reason),
    state: str(raw.state) as ReconciliationSession['state'],
    phase: optStr(raw.phase) as ReconciliationSession['phase'],
    source_epoch: num(raw.source_epoch),
    source_revision: num(raw.source_revision),
    target_epoch: num(raw.target_epoch),
    target_revision: num(raw.target_revision),
    plan_hash: raw.plan_hash === undefined ? undefined : str(raw.plan_hash),
    server_committed: raw.server_committed === true,
    commit_revision: num(raw.commit_revision),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
    completed_at: raw.completed_at === undefined ? undefined : str(raw.completed_at),
  };
}

export function decodeIssues(data: unknown): ReconciliationIssue[] {
  return arr(data, 'issues').map((i) => {
    const raw = i as Record<string, unknown>;
    const payload = raw.payload as Record<string, unknown>;
    return {
      id: str(raw.id),
      type: str(raw.type),
      payload: {
        source_ref: str(payload.source_ref),
        candidates: arr(payload.candidates, 'issue.payload.candidates').map((c) => str(c)),
      },
      default_choice: str(raw.default_choice),
      selected_choice: raw.selected_choice === undefined ? null : str(raw.selected_choice),
    };
  });
}

export function decodePlan(data: unknown): ReconciliationPlan {
  const raw = data as Record<string, unknown>;
  const stats = raw.stats as Record<string, unknown>;
  return {
    plan_hash: str(raw.plan_hash),
    base_epoch: num(raw.base_epoch),
    base_revision: num(raw.base_revision),
    stats: {
      creates: num(stats.creates),
      updates: num(stats.updates),
      moves: num(stats.moves),
      deletes: num(stats.deletes),
    },
    warnings: arr(raw.warnings, 'plan.warnings').map((w) => str(w)),
  };
}

export function decodeBinding(data: unknown): ReconciliationBinding {
  const raw = data as Record<string, unknown>;
  return {
    id: str(raw.id),
    state: str(raw.state),
    epoch: num(raw.epoch),
    applied_revision: num(raw.applied_revision),
    received_revision: num(raw.received_revision),
  };
}

/** The client apply steps of the plan the session was committed with. */
export function decodeSteps(data: unknown): StepsPayload {
  const raw = data as Record<string, unknown>;
  return {
    plan_hash: str(raw.plan_hash),
    steps: arr(raw.steps, 'steps').map((s) => {
      const step = s as Record<string, unknown>;
      return {
        kind: str(step.kind) as StepKind,
        local_ref: step.local_ref === undefined ? undefined : str(step.local_ref),
        canonical_id: step.canonical_id === undefined ? undefined : str(step.canonical_id),
        type: step.type === undefined ? undefined : (str(step.type) as 'folder' | 'bookmark'),
        title: step.title === undefined ? undefined : str(step.title),
        url: step.url === undefined ? undefined : str(step.url),
        parent: step.parent as StepsPayload['steps'][number]['parent'],
        before_id: step.before_id === undefined ? undefined : str(step.before_id),
      };
    }),
  };
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

/** A field the Go DTO marshals with omitempty: absent is a valid answer. */
function optStr(v: unknown): string | undefined {
  return v === undefined ? undefined : str(v);
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

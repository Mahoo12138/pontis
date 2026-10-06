// Wire types of the Pontis sync protocol, mirroring the Go server DTOs
// (docs 04, 08). The golden fixtures under fixtures/protocol/ bind both
// encodings together: any change here must regenerate them and update
// the extension codec test.

/** HTTP API version prefix; protocol_version is independent (doc 08 §1). */
export const API_VERSION = 'v1';

/** Sync semantic protocol version. */
export const PROTOCOL_VERSION = 1;

/** ParentRef: exactly one of node id or root slot key. */
export interface ParentRef {
  type: 'node' | 'root';
  id?: string;
  key?: string;
}

export type OperationType = 'create' | 'update_title' | 'update_url' | 'move' | 'delete';

/** Client operation envelope (doc 04 §3). */
export interface Operation {
  op_id: string;
  client_seq: number;
  base_revision: number;
  type: OperationType;
  node_id: string;
  node_type?: 'folder' | 'bookmark';
  title?: string;
  url?: string;
  parent?: ParentRef;
  before_id?: string;
}

/** /sync request (doc 04 §5). */
export interface SyncRequest {
  protocol_version: number;
  epoch: number;
  applied_revision: number;
  received_revision: number;
  operations: Operation[];
  max_changes: number;
}

export type OperationStatus = 'APPLIED' | 'REBASED' | 'NOOP' | 'CONFLICT' | 'REJECTED' | 'RECOVERED';

/** Per-operation outcome (doc 04 §7). */
export interface OperationResult {
  op_id: string;
  client_seq: number;
  status: OperationStatus;
  reason: string;
  result_revision: number;
  settle_after_revision: number;
}

/** One canonical change of the journal stream (doc 04 §6). */
export interface Change {
  revision: number;
  type: OperationType;
  node_id: string;
  payload: ChangePayload;
}

export type ChangePayload =
  | { type: 'folder' | 'bookmark'; title: string; url?: string; parent: ParentRef; position: number }
  | { title: string }
  | { url: string }
  | { parent: ParentRef; position: number }
  | { count: number };

/** /sync response (doc 04 §6). */
export interface SyncResponse {
  protocol_version: number;
  epoch: number;
  journal_floor_revision: number;
  from_revision: number;
  through_revision: number;
  server_revision: number;
  has_more: boolean;
  operation_results: OperationResult[];
  changes: Change[];
}

/** Machine-readable protocol failure (doc 04 §14). Clients act on code. */
export const PROTOCOL_ERRORS = {
  EPOCH_MISMATCH: 'EPOCH_MISMATCH',
  HISTORY_EXPIRED: 'HISTORY_EXPIRED',
  OPERATION_HISTORY_EXPIRED: 'OPERATION_HISTORY_EXPIRED',
  BINDING_NOT_ACTIVE: 'BINDING_NOT_ACTIVE',
  SYNC_PROTOCOL_UNSUPPORTED: 'SYNC_PROTOCOL_UNSUPPORTED',
  OP_ID_REUSED: 'OP_ID_REUSED',
  CLIENT_SEQ_REGRESSED: 'CLIENT_SEQ_REGRESSED',
  INVALID_WATERMARK: 'INVALID_WATERMARK',
} as const;

export class ProtocolError extends Error {
  readonly code: string;
  readonly requestId: string;

  constructor(code: string, message: string, requestId: string) {
    super(`${code}: ${message}`);
    this.name = 'ProtocolError';
    this.code = code;
    this.requestId = requestId;
  }
}

// --- reconciliation client flow (docs 06 §4, 08 §9-13) ---

/** Client browser snapshot: session-local refs only (doc 08 §10). */
export interface ClientSnapshot {
  epoch: number;
  revision: number;
  roots: { local_ref: string; root_key: string; title: string }[];
  nodes: {
    local_ref: string;
    parent_local_ref: string;
    type: 'folder' | 'bookmark';
    title: string;
    url: string;
    canonical_id?: string;
  }[];
}

export interface ServerSnapshot {
  snapshot_id: string;
  epoch: number;
  revision: number;
  node_count: number;
  checksum: string;
  expires_at?: string;
}

export interface SnapshotNode {
  node_ref: string;
  parent_ref: string;
  type: 'root' | 'folder' | 'bookmark';
  title: string;
  url?: string;
  root_key?: string;
  position: number;
}

export type ReconciliationType = 'initial' | 'full_resync' | 'recovery';
export type ReconciliationState = 'running' | 'waiting_user' | 'completed' | 'failed';

export interface ReconciliationIssue {
  id: string;
  type: string;
  payload: { source_ref: string; type?: string; title?: string; url?: string; candidates: string[] };
  default_choice: string;
  selected_choice: string | null;
}

export interface ReconciliationSession {
  id: string;
  binding_id: string;
  space_id: string;
  type: ReconciliationType;
  reason: string;
  state: ReconciliationState;
  phase: string;
  source_epoch: number;
  source_revision: number;
  target_epoch: number;
  target_revision: number;
  plan_hash?: string;
  server_committed: boolean;
  commit_revision: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  issues?: ReconciliationIssue[];
}

export type StepKind = 'assign_identity' | 'create' | 'update' | 'move' | 'delete';

/** One client apply step (doc 08 §13): ensure-state semantics. */
export interface ApplyStep {
  kind: StepKind;
  local_ref?: string;
  canonical_id?: string;
  type?: 'folder' | 'bookmark';
  title?: string;
  url?: string;
  parent?: ParentRef;
  before_id?: string;
}

/** Unified error envelope (doc 08 §16). */
export interface ErrorEnvelope {
  error: { code: string; message: string; request_id: string; details?: Record<string, unknown> };
}

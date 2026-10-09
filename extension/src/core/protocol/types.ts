// Wire protocol v1 types, mirroring the Go server DTOs
// (server/internal/sync/operation.go + internal/httpapi/handlers.go).
// Field names are snake_case on the wire and must not drift; the
// fixture tests assert the exact shape.

export const SYNC_PROTOCOL_VERSION = 1;

/** Cap for one /sync change page; the client keeps paging on has_more. */
export const MAX_CHANGES_PER_ROUND = 500;

export type OpType = 'create' | 'update_title' | 'update_url' | 'move' | 'delete';

export type NodeType = 'folder' | 'bookmark';

export interface ParentRefWire {
  type: 'node' | 'root';
  /** Canonical node id when type === 'node'. */
  id?: string;
  /** Root slot key (e.g. "main") when type === 'root'. */
  key?: string;
}

/** Client operation envelope (doc 04 §3). */
export interface OperationWire {
  op_id: string;
  client_seq: number;
  base_revision: number;
  type: OpType;
  node_id: string;
  node_type?: NodeType;
  title?: string;
  url?: string;
  parent?: ParentRefWire;
  before_id?: string | null;
}

export type OpStatus = 'APPLIED' | 'REBASED' | 'NOOP' | 'CONFLICT' | 'REJECTED' | 'RECOVERED';

export interface OperationResultWire {
  op_id: string;
  client_seq: number;
  status: OpStatus;
  reason: string;
  result_revision: number;
  settle_after_revision: number;
}

// --- change stream payloads (journal wire format) ---

export interface CreatePayloadWire {
  type: NodeType;
  title: string;
  url: string;
  parent: ParentRefWire;
  position: number;
}

export interface UpdateTitlePayloadWire {
  title: string;
}

export interface UpdateURLPayloadWire {
  url: string;
}

export interface MovePayloadWire {
  parent: ParentRefWire;
  position: number;
}

export interface DeletePayloadWire {
  count: number;
}

export type ChangePayload = CreatePayloadWire | UpdateTitlePayloadWire | UpdateURLPayloadWire | MovePayloadWire | DeletePayloadWire;

export interface ChangeWire {
  revision: number;
  type: OpType;
  node_id: string;
  payload: ChangePayload;
}

// --- /sync round ---

export interface SyncRequestWire {
  protocol_version: number;
  epoch: number;
  applied_revision: number;
  received_revision: number;
  operations: OperationWire[];
  max_changes: number;
}

export interface SyncResponseWire {
  protocol_version: number;
  epoch: number;
  journal_floor_revision: number;
  from_revision: number;
  through_revision: number;
  server_revision: number;
  has_more: boolean;
  operation_results: OperationResultWire[];
  changes: ChangeWire[];
}

// --- cross-space transfer (doc 08 §15) ---

export interface NodeMappingWire {
  source_node_id: string;
  target_node_id: string;
}

/** Device-initiated atomic transfer between two spaces of the same owner. */
export interface TransferRequestWire {
  transfer_id: string;
  source_space_id: string;
  target_space_id: string;
  node_id: string;
  target_parent: ParentRefWire;
  before_id?: string | null;
}

/** The mapping lets the extension rebuild the target binding directly. */
export interface TransferResponseWire {
  transfer_id: string;
  source_revision: number;
  target_revision: number;
  mapping: NodeMappingWire[];
}

// --- snapshot (doc 06 §8) ---

export interface SnapshotNodeWire {
  id: string;
  type: string;
  title: string;
  url?: string;
  parent: ParentRefWire;
  position: number;
}

/** Read-only canonical snapshot bound to (epoch, snapshot_revision). */
export interface SnapshotWire {
  protocol_version: number;
  epoch: number;
  snapshot_revision: number;
  journal_floor_revision: number;
  nodes: SnapshotNodeWire[];
}

// --- binding/protocol level error codes (doc 04 §14) ---

export const SYNC_PROTOCOL_ERROR_CODES = [
  'EPOCH_MISMATCH',
  'HISTORY_EXPIRED',
  'OPERATION_HISTORY_EXPIRED',
  'BINDING_NOT_ACTIVE',
  'RECONCILIATION_IN_PROGRESS',
  'SYNC_PROTOCOL_UNSUPPORTED',
  'OP_ID_REUSED',
  'CLIENT_SEQ_REGRESSED',
  'INVALID_WATERMARK',
] as const;

export type SyncErrorCode = (typeof SYNC_PROTOCOL_ERROR_CODES)[number];

export function isProtocolErrorCode(code: string): boolean {
  return (SYNC_PROTOCOL_ERROR_CODES as readonly string[]).includes(code);
}

// --- reconciliation lifecycle (doc 08 §9-§13) ---

export type ReconciliationType = 'initial' | 'full_resync' | 'recovery';
export type ReconciliationState = 'running' | 'waiting_user' | 'completed' | 'failed';
export type ReconciliationPhase = 'collecting' | 'snapshot_ready' | 'server_ready' | 'planned' | 'committed';
export type StepKindWire = 'assign_identity' | 'create' | 'update' | 'move' | 'delete';

/** Client browser snapshot: session-local refs only, never browser ids. */
export interface ClientSnapshotWire {
  epoch: number;
  revision: number;
  roots: { local_ref: string; root_key: string; title: string }[];
  nodes: {
    local_ref: string;
    parent_local_ref: string;
    type: NodeType;
    title: string;
    url: string;
    /** Only a device that already has a mapping may claim one (doc 08 §10). */
    canonical_id?: string;
  }[];
}

export interface ServerSnapshotWire {
  snapshot_id: string;
  binding_id: string;
  space_id: string;
  epoch: number;
  revision: number;
  node_count: number;
  checksum: string;
  /** Empty once the snapshot carries no expiry. */
  expires_at: string;
  created_at: string;
}

export interface ServerSnapshotNodeWire {
  node_ref: string;
  parent_ref: string;
  type: 'root' | NodeType;
  title: string;
  url?: string;
  root_key?: string;
  position: number;
}

/** One page of a frozen tree; cursor is this snapshot's own offset. */
export interface ServerSnapshotPageWire {
  nodes: ServerSnapshotNodeWire[];
  total: number;
  next_cursor: string;
}

export interface ReconciliationIssueWire {
  id: string;
  type: string;
  payload: { source_ref: string; type?: string; title?: string; url?: string; candidates: string[] };
  /** The choice the server applies when the client answers nothing. */
  default_choice: string;
  selected_choice?: string;
}

export interface ReconciliationPlanWire {
  type: ReconciliationType;
  strategy: string;
  placement: string;
  base_epoch: number;
  base_revision: number;
  plan_hash: string;
  stats: { creates: number; updates: number; moves: number; deletes: number };
  warnings: string[];
}

export interface ReconciliationSessionWire {
  id: string;
  binding_id: string;
  space_id: string;
  type: ReconciliationType;
  reason: string;
  state: ReconciliationState;
  phase: ReconciliationPhase;
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
}

/**
 * Every lifecycle answer: the session, the issues that need an answer, the
 * plan preview once one exists, and the binding once complete wrote it back.
 */
export interface ReconciliationEnvelopeWire {
  session: ReconciliationSessionWire;
  issues: ReconciliationIssueWire[];
  plan?: ReconciliationPlanWire;
  binding?: BindingWire;
}

/** One client apply step (doc 08 §13): ensure-state, retry-safe. */
export interface ApplyStepWire {
  kind: StepKindWire;
  local_ref?: string;
  canonical_id?: string;
  type?: NodeType;
  title?: string;
  url?: string;
  parent?: ParentRefWire;
  before_id?: string;
}

export interface StepsWire {
  plan_hash: string;
  steps: ApplyStepWire[];
}

// --- auxiliary API shapes used by pairing ---

export interface MetaWire {
  instance_id: string;
  product_version: string;
  api_version: string;
  sync_protocol_versions: number[];
}

export interface SpaceWire {
  id: string;
  name: string;
  epoch: number;
  revision: number;
  journal_floor_revision: number;
  created_at: string;
}

export interface DeviceWire {
  id: string;
  name: string;
  client_type: string;
  browser: string;
  platform: string;
  created_at: string;
}

export interface BindingWire {
  id: string;
  device_id: string;
  space_id: string;
  state: string;
  epoch: number;
  applied_revision: number;
  received_revision: number;
  max_client_seq: number;
}

// --- payload narrowing helpers ---

export function asCreatePayload(payload: ChangePayload): CreatePayloadWire | null {
  return 'type' in payload && 'parent' in payload ? payload : null;
}

export function asUpdateTitlePayload(payload: ChangePayload): UpdateTitlePayloadWire | null {
  return 'title' in payload && !('parent' in payload) ? payload : null;
}

export function asUpdateURLPayload(payload: ChangePayload): UpdateURLPayloadWire | null {
  return 'url' in payload && !('parent' in payload) && !('type' in payload) ? payload : null;
}

export function asMovePayload(payload: ChangePayload): MovePayloadWire | null {
  return 'parent' in payload && 'position' in payload && !('type' in payload) ? payload : null;
}

export function asDeletePayload(payload: ChangePayload): DeletePayloadWire | null {
  return 'count' in payload ? payload : null;
}

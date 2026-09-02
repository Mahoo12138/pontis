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
  'SYNC_PROTOCOL_UNSUPPORTED',
  'OP_ID_REUSED',
  'CLIENT_SEQ_REGRESSED',
  'INVALID_WATERMARK',
] as const;

export type SyncErrorCode = (typeof SYNC_PROTOCOL_ERROR_CODES)[number];

export function isProtocolErrorCode(code: string): boolean {
  return (SYNC_PROTOCOL_ERROR_CODES as readonly string[]).includes(code);
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

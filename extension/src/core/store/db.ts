// Local Replica Store on Dexie/IndexedDB — the sync state Source of Truth.
// MV3 service worker memory is cache only (doc 05 §1): every durable sync
// fact lives here, and mirror + pending op updates share one transaction.

import Dexie, { type Table } from 'dexie';
import type {
  NodeType,
  OpStatus,
  OpType,
  ParentRefWire,
  ReconciliationIssueWire,
  ReconciliationPhase,
} from '../protocol/types';

export type BindingMode = 'full' | 'partial';

export type BindingState =
  | 'active'
  | 'paused'
  | 'mount_missing'
  | 'needs_recovery'
  /** Freshly created binding: only an initial reconciliation can activate it (doc 08 §11). */
  | 'pending_initial'
  /** Initial sync / mapping-lost reconciliation running (doc 06 §4). */
  | 'initializing'
  /** Full resync running (doc 06 §7). */
  | 'resyncing'
  /** Waiting for a reconciliation decision (doc 06 §5). */
  | 'waiting_user';

/** Client-local mapping between canonical roots and browser roots (doc 03). */
export interface BindingMount {
  mode: BindingMode;
  /** Partial mode: the browser folder mounted as the canonical root slot. */
  folderBrowserId?: string;
  /** Root slot key the mount maps to (space.DefaultRootKey = "main"). */
  rootKey: string;
  /** Full mode: canonical root key → browser root id. */
  roots?: Record<string, string>;
}

export interface BindingRecord {
  id: string;
  spaceId: string;
  spaceName: string;
  mode: BindingMode;
  state: BindingState;
  epoch: number;
  /** Highest revision actually converged to in the Browser (doc 05 §11). */
  appliedRevision: number;
  /** Highest revision durably persisted into the remote inbox. */
  receivedRevision: number;
  /** Next client_seq to allocate. */
  clientSeq: number;
  mount: BindingMount;
  lastSyncAt: number | null;
  recovery: { code: string; message: string } | null;
  createdAt: number;
}

/**
 * Merged mirror + mapping (doc 05 §4): Canonical ↔ browser identity and
 * the last-known browser state. Browser tree remains the real local
 * state; the mirror is repairable via integrity reconciliation later.
 */
export interface LocalNodeRecord {
  bindingId: string;
  browserId: string;
  /** null until the server has acked the create and the change stream回流. */
  canonicalId: string | null;
  type: NodeType;
  title: string;
  url: string | null;
  parentBrowserId: string | null;
  /** Canonical sibling position when known; null for local-only knowledge. */
  position: number | null;
}

export type PendingStatus = 'QUEUED' | 'RESOLVED';

/** Outbox entry (doc 05 §5). HTTP success ≠ deletable; settle rules apply. */
export interface PendingOpRecord {
  opId: string;
  bindingId: string;
  clientSeq: number;
  baseRevision: number;
  status: PendingStatus;
  /** 'transfer' is a local extension (doc 03 §7): it never goes through
   *  /sync operations — the coordinator uploads it to /sync/transfers. */
  type: OpType | 'transfer';
  /** Canonical node id; '' for a local create not yet acked. */
  nodeId: string;
  nodeType?: NodeType;
  title?: string;
  url?: string;
  parent?: ParentRefWire;
  beforeId?: string | null;
  /** Browser node the intent came from; used for in-place edits pre-ack. */
  browserId?: string;
  /** Browser parent after the move; transfer ack uses it to re-root the
   *  mirror inside the target binding's scope. */
  browserParentId?: string;
  // --- transfer-only fields (type === 'transfer') ---
  targetSpaceId?: string;
  targetParent?: ParentRefWire;
  /** Survive settle: an import queue entry still needs the result. */
  keepResolved?: boolean;
  result?: {
    status: OpStatus;
    reason: string;
    resultRevision: number;
    settleAfterRevision: number;
  } | null;
  createdAt: number;
}

export type ExpectationKind = OpType;

/**
 * Expected remote mutation (doc 05 §8/§9): persisted BEFORE the browser
 * API is called so the resulting browser event can be recognized and
 * must not produce a local operation.
 */
export interface ExpectedMutationRecord {
  id?: number;
  bindingId: string;
  revision: number;
  kind: ExpectationKind;
  canonicalId: string;
  /** Resolved browser target; null = provisional (create not yet seen). */
  browserId?: string | null;
  parentBrowserId?: string | null;
  position?: number | null;
  title?: string;
  url?: string;
  createdAt: number;
}

/** Remote change inbox: persisted before received_revision advances (doc 05 §6). */
export interface RemoteChangeRecord {
  /** `${bindingId}:${revision}` — put() makes persistence idempotent. */
  id: string;
  bindingId: string;
  revision: number;
  type: OpType;
  nodeId: string;
  payload: unknown;
}

// --- reconciliation sessions (doc 06 §3) ---

export type ReconType = 'INITIAL' | 'FULL_RESYNC' | 'MAPPING_LOST';

export type ReconState = 'RUNNING' | 'WAITING_USER' | 'COMPLETED' | 'FAILED';

export type ReconPhase =
  | 'prepare'
  | 'fetch'
  | 'snapshot'
  | 'analyze'
  | 'wait_user'
  | 'commit'
  | 'apply'
  | 'verify'
  | 'done';

/** One binding allows at most one active reconciliation (doc 06 §3). */
export type ReconDecision = 'merge' | 'use_server' | 'use_browser' | 'import';

export interface ReconProgress {
  matched: number;
  localOnly: number;
  serverOnly: number;
  ambiguous: number;
  uploaded: number;
  applied: number;
}

export interface ReconSessionRecord {
  id: string;
  bindingId: string;
  type: ReconType;
  state: ReconState;
  phase: ReconPhase;
  /** Decision for the both-non-empty case; persisted so MV3 can resume. */
  decision?: ReconDecision;
  journalFloor: number;
  serverRevision: number;
  progress: ReconProgress;
  /** Import mode: pending create ops → their source browser nodes. */
  importQueue?: Array<{ opId: string; sourceBrowserId: string }>;
  /** Canonical tree came from a server snapshot, not journal replay. */
  snapshotApplied?: boolean;
  /** Recovery intents already reviewed; resync may replay the re-created ops. */
  intentReviewed?: boolean;
  // --- server-driven lifecycle (doc 08 §11-§13) ---
  /** The server reconciliation session this client session mirrors. */
  serverSessionId?: string;
  /**
   * Marks a session opened by the server-driven lifecycle. The binding is
   * 'initializing' for both engines, so without this a lifecycle round that
   * failed before the server session id was stored leaves the binding with a
   * session neither engine will pick up again.
   */
  driver?: 'server';
  /** Last phase the server reported; the resume anchor after an MV3 kill. */
  serverPhase?: ReconciliationPhase;
  /** Plan hash the commit must echo back. */
  planHash?: string;
  /** Open questions the server still wants answered, for the UI to render. */
  issues?: ReconciliationIssueWire[];
  /** Client snapshot local_ref → browser node id, used by the step applier. */
  localRefs?: Record<string, string>;
  /** Revision the server committed its plan at (the new baseline). */
  commitRevision?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** Client emergency snapshot before a destructive resync (doc 06 §9). */
export interface EmergencySnapshotRecord {
  id?: number;
  bindingId: string;
  ts: number;
  reason: string;
  data: {
    mirrors: LocalNodeRecord[];
    pending: PendingOpRecord[];
    epoch: number;
    appliedRevision: number;
    receivedRevision: number;
    clientSeq: number;
  };
}

export interface DiagnosticEvent {
  id?: number;
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  data?: unknown;
}

const DIAGNOSTIC_CAP = 500;

/** The single active reconciliation session of a binding, if any. */
export async function activeReconSession(
  db: PontisDB,
  bindingId: string,
): Promise<ReconSessionRecord | undefined> {
  const rows = await db.reconSessions
    .where('[bindingId+state]')
    .anyOf([[bindingId, 'RUNNING'], [bindingId, 'WAITING_USER']])
    .toArray();
  return rows[0];
}

export function emptyReconProgress(): ReconProgress {
  return { matched: 0, localOnly: 0, serverOnly: 0, ambiguous: 0, uploaded: 0, applied: 0 };
}

export class PontisDB extends Dexie {
  bindings!: Table<BindingRecord, string>;
  localNodes!: Table<LocalNodeRecord, [string, string]>;
  pendingOps!: Table<PendingOpRecord, string>;
  expectedMutations!: Table<ExpectedMutationRecord, number>;
  remoteChanges!: Table<RemoteChangeRecord, string>;
  reconSessions!: Table<ReconSessionRecord, string>;
  emergencySnapshots!: Table<EmergencySnapshotRecord, number>;
  runLocks!: Table<RunLockRecord, string>;
  diagnostics!: Table<DiagnosticEvent, number>;

  constructor(name = 'pontis-replica') {
    super(name);
    this.version(1).stores({
      bindings: 'id, spaceId, state',
      // Compound primary key [bindingId+browserId]; the canonical side is
      // a lookup index and must stay unique by convention (doc 05 §4).
      localNodes: '[bindingId+browserId], bindingId, [bindingId+canonicalId]',
      pendingOps: 'opId, bindingId, [bindingId+status], clientSeq',
      expectedMutations: '++id, bindingId, revision, [bindingId+kind]',
      remoteChanges: 'id, bindingId, [bindingId+revision]',
      diagnostics: '++id, ts',
    });
    this.version(2).stores({
      reconSessions: 'id, bindingId, [bindingId+state]',
      emergencySnapshots: '++id, bindingId, ts',
    });
    this.version(3).stores({
      // One row per binding being driven right now (doc 05 §15). Held in
      // IndexedDB rather than memory because an MV3 worker can be replaced by
      // a second instance at any await, and two workers interleaving on one
      // binding corrupts the replica.
      runLocks: 'bindingId, takenAt',
    });
  }
}

/** A binding's exclusive right to run sync or a reconciliation. */
export interface RunLockRecord {
  bindingId: string;
  token: string;
  takenAt: number;
}

/**
 * A lock older than this belongs to a worker that was killed mid-round; the
 * next trigger may take it over. Well above a real round's duration, so a live
 * owner is never stolen from.
 */
export const RUN_LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * Compare-and-set the run lock for one binding. Returns the token on success
 * and null when another live holder has it; callers release in a finally.
 */
export async function acquireRunLock(
  db: PontisDB,
  bindingId: string,
  token: string,
  now = Date.now(),
): Promise<string | null> {
  let held: string | null = null;
  await db.transaction('rw', [db.runLocks], async () => {
    const current = await db.runLocks.get(bindingId);
    if (current && current.bindingId !== bindingId) return;
    if (current && current.token !== token && now - current.takenAt < RUN_LOCK_STALE_MS) return;
    await db.runLocks.put({ bindingId, token, takenAt: now });
    held = token;
  });
  return held;
}

/**
 * Forget every lock. A worker runs this at startup: MV3 keeps one service
 * worker per extension, so a lock that survives into a new worker belongs to
 * the instance that was killed mid-round, and leaving it would stall the
 * binding until the stale window expires.
 */
export async function releaseAllRunLocks(db: PontisDB): Promise<number> {
  const stale = await db.runLocks.toArray();
  await db.runLocks.clear();
  return stale.length;
}

/** Drop the lock, but only if we still hold it (a stale lock was taken over). */
export async function releaseRunLock(db: PontisDB, bindingId: string, token: string): Promise<void> {
  await db.transaction('rw', [db.runLocks], async () => {
    const current = await db.runLocks.get(bindingId);
    if (current?.token === token) await db.runLocks.delete(bindingId);
  });
}

/** Ring-buffer diagnostic log (doc 16 direction; local only). */
export async function logDiagnostic(
  db: PontisDB,
  level: DiagnosticEvent['level'],
  scope: string,
  message: string,
  data?: unknown,
): Promise<void> {
  try {
    await db.diagnostics.add({ ts: Date.now(), level, scope, message, data });
    const count = await db.diagnostics.count();
    if (count > DIAGNOSTIC_CAP) {
      const stale = await db.diagnostics.orderBy('id').limit(count - DIAGNOSTIC_CAP).primaryKeys();
      await db.diagnostics.bulkDelete(stale);
    }
  } catch {
    // Diagnostics must never break the sync path.
  }
}

/**
 * Mirror lookup by canonical id — the primary key is browser-side, so
 * canonical identity must go through the [bindingId+canonicalId] index.
 */
export async function findMirrorByCanonical(
  db: PontisDB,
  bindingId: string,
  canonicalId: string,
): Promise<LocalNodeRecord | undefined> {
  return db.localNodes.where('[bindingId+canonicalId]').equals([bindingId, canonicalId]).first();
}

/**
 * All mirror records of the subtree rooted at browserId (inclusive),
 * derived from the mapping itself.
 */
export async function collectSubtree(db: PontisDB, bindingId: string, browserId: string): Promise<LocalNodeRecord[]> {
  const all = await db.localNodes.where('bindingId').equals(bindingId).toArray();
  const byParent = new Map<string, LocalNodeRecord[]>();
  for (const row of all) {
    if (!row.parentBrowserId) continue;
    const list = byParent.get(row.parentBrowserId) ?? [];
    list.push(row);
    byParent.set(row.parentBrowserId, list);
  }
  const out: LocalNodeRecord[] = [];
  const queue = all.filter((r) => r.browserId === browserId);
  while (queue.length > 0) {
    const cur = queue.pop()!;
    out.push(cur);
    queue.push(...(byParent.get(cur.browserId) ?? []));
  }
  return out;
}

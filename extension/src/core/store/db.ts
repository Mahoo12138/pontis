// Local Replica Store on Dexie/IndexedDB — the sync state Source of Truth.
// MV3 service worker memory is cache only (doc 05 §1): every durable sync
// fact lives here, and mirror + pending op updates share one transaction.

import Dexie, { type Table } from 'dexie';
import type { NodeType, OpStatus, OpType, ParentRefWire } from '../protocol/types';

export type BindingMode = 'full' | 'partial';

export type BindingState = 'active' | 'paused' | 'mount_missing' | 'needs_recovery';

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
  type: OpType;
  /** Canonical node id; '' for a local create not yet acked. */
  nodeId: string;
  nodeType?: NodeType;
  title?: string;
  url?: string;
  parent?: ParentRefWire;
  beforeId?: string | null;
  /** Browser node the intent came from; used for in-place edits pre-ack. */
  browserId?: string;
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

export interface DiagnosticEvent {
  id?: number;
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  data?: unknown;
}

const DIAGNOSTIC_CAP = 500;

export class PontisDB extends Dexie {
  bindings!: Table<BindingRecord, string>;
  localNodes!: Table<LocalNodeRecord, [string, string]>;
  pendingOps!: Table<PendingOpRecord, string>;
  expectedMutations!: Table<ExpectedMutationRecord, number>;
  remoteChanges!: Table<RemoteChangeRecord, string>;
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
  }
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
 * All mirror records of the subtree rooted at browserId (inclusive),
 * derived from the mapping itself.
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

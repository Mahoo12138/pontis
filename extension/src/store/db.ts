import Dexie, { Table } from 'dexie';

// Local replica database (doc 05 §3). V1 core subset: bindings with
// watermarks, the mirror/mapping (local_nodes), the pending operation
// outbox, the remote change inbox and expected remote mutations.

export interface BindingRow {
  bindingId: string;
  spaceId: string;
  deviceId: string;
  deviceName: string;
  epoch: number;
  appliedRevision: number;
  receivedRevision: number;
  maxClientSeq: number;
  /** canonical root slot key → browser root id (doc 03 §3). */
  rootMap: Record<string, string>;
}

export interface MirrorNode {
  bindingId: string;
  canonicalId: string;
  browserId: string;
  type: 'folder' | 'bookmark';
  title: string;
  url?: string;
  parentType: 'node' | 'root';
  parentCanonicalId?: string;
  parentRootKey?: string;
  position: number;
}

export type PendingState = 'QUEUED' | 'RESOLVED' | 'SETTLED';

export interface PendingOpRow {
  /** Auto increment; insertion order within a capture transaction. */
  rowId?: number;
  bindingId: string;
  opId: string;
  clientSeq: number;
  baseRevision: number;
  op: unknown; // protocol Operation, kept opaque for the store layer
  state: PendingState;
  result?: { status: string; reason: string; resultRevision: number; settleAfterRevision: number };
  settleAfter: number;
}

export interface RemoteChangeRow {
  bindingId: string;
  revision: number;
  type: string;
  nodeId: string;
  payload: unknown;
  applied: 0 | 1;
}

export interface ExpectedMutationRow {
  id?: number;
  bindingId: string;
  kind: 'create' | 'update' | 'move' | 'delete' | 'project_root';
  canonicalId?: string;
  /** Provisional create matching fields (doc 05 §9). */
  parentBrowserId?: string;
  type?: 'folder' | 'bookmark';
  title?: string;
  url?: string;
  createdAt: number;
}

export class ReplicaDB extends Dexie {
  bindings!: Table<BindingRow, string>;
  localNodes!: Table<MirrorNode, [string, string]>;
  pendingOperations!: Table<PendingOpRow, number>;
  remoteChanges!: Table<RemoteChangeRow, [string, number]>;
  expectedMutations!: Table<ExpectedMutationRow, number>;

  constructor(name = 'pontis-replica') {
    super(name);
    this.version(1).stores({
      bindings: 'bindingId',
      localNodes: '[bindingId+canonicalId], [bindingId+browserId], [bindingId+parentCanonicalId], [bindingId+parentRootKey]',
      pendingOperations: '++rowId, [bindingId+state], [bindingId+opId]',
      remoteChanges: '[bindingId+revision], [bindingId+applied]',
      expectedMutations: '++id, [bindingId+kind], [bindingId+canonicalId], [bindingId+parentBrowserId]',
    });
  }
}

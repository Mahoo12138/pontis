import { Change, Operation, SyncRequest, SyncResponse, ParentRef } from '@pontis/protocol';

/**
 * Protocol-plausible in-memory server for engine tests. It mirrors the
 * Go sync engine's decision semantics closely enough to exercise the
 * client paths (settle, inbox persistence, ensure-state idempotency):
 * receipts, per-node field revisions, same-field conflicts, delete
 * wins, stale-anchor rebase and same-binding causality. The real
 * protocol truth is validated by the Go syncsim and the integration
 * tests against the actual server.
 */
interface FakeNode {
  id: string;
  type: 'folder' | 'bookmark';
  title: string;
  url?: string;
  parent: ParentRef;
  position: number;
  createdRev: number;
  titleRev: number;
  urlRev: number;
  structureRev: number;
}

interface JournalEntry {
  revision: number;
  type: Operation['type'];
  nodeId: string;
  payload: unknown;
  origin?: { bindingId: string; clientSeq: number };
}

export interface OpResult {
  op_id: string;
  client_seq: number;
  status: 'APPLIED' | 'REBASED' | 'NOOP' | 'CONFLICT' | 'REJECTED' | 'RECOVERED';
  reason: string;
  result_revision: number;
  settle_after_revision: number;
}

export class FakeSyncServer {
  private head = 0;
  private journal: JournalEntry[] = [];
  private nodes = new Map<string, FakeNode>();
  private tombstones = new Map<string, number>();
  private childrenOf = new Map<string, string[]>(); // container key → ordered cids
  private receipts = new Map<string, { hash: string; result: OpResult }>();
  private roots = new Set<string>(['main']);

  /** Direct server-side insert (test seeding), journal included. */
  seed(parent: ParentRef, type: 'folder' | 'bookmark', title: string, url?: string): string {
    const id = `srv-${this.head + 1}`;
    const rev = ++this.head;
    this.nodes.set(id, {
      id,
      type,
      title,
      url,
      parent,
      position: this.containerChildren(parent).length,
      createdRev: rev,
      titleRev: rev,
      urlRev: rev,
      structureRev: rev,
    });
    this.containerChildren(parent).push(id);
    this.journal.push({
      revision: rev,
      type: 'create',
      nodeId: id,
      payload: { type, title, ...(url ? { url } : {}), parent, position: this.nodes.get(id)!.position },
    });
    return id;
  }

  addRootSlot(key: string): void {
    this.roots.add(key);
  }

  /** Current canonical head revision. */
  getHead(): number {
    return this.head;
  }

  tree(): { order: Map<string, string[]>; nodes: Map<string, { parent: string; type: string; title: string; url?: string }> } {
    const order = new Map<string, string[]>();
    const nodes = new Map<string, { parent: string; type: string; title: string; url?: string }>();
    const walk = (container: string, parent: ParentRef) => {
      const ids = this.containerChildren(parent);
      order.set(container, [...ids]);
      for (const id of ids) {
        const node = this.nodes.get(id)!;
        nodes.set(id, { parent: container, type: node.type, title: node.title, url: node.url });
        if (node.type === 'folder') {
          walk(id, { type: 'node', id });
        }
      }
    };
    for (const key of this.roots) {
      walk(`root:${key}`, { type: 'root', key });
    }
    return { order, nodes };
  }

  private containerChildren(parent: ParentRef): string[] {
    const key = parent.type === 'node' ? parent.id! : `root:${parent.key}`;
    let list = this.childrenOf.get(key);
    if (!list) {
      list = [];
      this.childrenOf.set(key, list);
    }
    return list;
  }

  sync(bindingId: string, req: SyncRequest): SyncResponse {
    const sorted = [...req.operations].sort((a, b) => a.client_seq - b.client_seq);
    const results: OpResult[] = [];
    for (const op of sorted) {
      const hash = JSON.stringify({ ...op, client_seq: op.client_seq });
      const receipt = this.receipts.get(op.op_id);
      if (receipt) {
        if (receipt.hash !== hash) {
          throw Object.assign(new Error('OP_ID_REUSED'), { code: 'OP_ID_REUSED' });
        }
        results.push(receipt.result);
        continue;
      }
      const result = this.apply(bindingId, op);
      this.receipts.set(op.op_id, { hash, result });
      results.push(result);
    }

    const from = req.received_revision + 1;
    const slice = this.journal.slice(from - 1, from - 1 + Math.max(1, req.max_changes));
    return {
      protocol_version: 1,
      epoch: 1,
      journal_floor_revision: 0,
      from_revision: from,
      through_revision: from - 1 + slice.length,
      server_revision: this.head,
      has_more: from - 1 + slice.length < this.head,
      operation_results: results,
      changes: slice.map((entry) => ({
        revision: entry.revision,
        type: entry.type,
        node_id: entry.nodeId,
        payload: entry.payload as Change['payload'],
      })),
    };
  }

  private apply(bindingId: string, op: Operation): OpResult {
    switch (op.type) {
      case 'create':
        return this.applyCreate(bindingId, op);
      case 'update_title':
        return this.applyUpdate(bindingId, op, 'title');
      case 'update_url':
        return this.applyUpdate(bindingId, op, 'url');
      case 'move':
        return this.applyMove(bindingId, op);
      case 'delete':
        return this.applyDelete(bindingId, op);
      default:
        return rejected(op, 'invalid_payload', 0);
    }
  }

  private applyCreate(bindingId: string, op: Operation): OpResult {
    if (this.nodes.has(op.node_id)) {
      const created = this.nodes.get(op.node_id)!.createdRev;
      return { op_id: op.op_id, client_seq: op.client_seq, status: 'NOOP', reason: 'already_exists', result_revision: created, settle_after_revision: created };
    }
    // The client pre-generates the canonical id; the server must adopt it.
    const id = op.node_id;
    if (!this.validParent(op.parent)) {
      // Parent deleted after base: protect the new data under
      // Recovered/<Device> (doc 04 §11).
      const parentTomb = op.parent?.type === 'node' ? this.tombstones.get(op.parent.id!) : undefined;
      if (parentTomb !== undefined) {
        return this.applyRecoveredCreate(bindingId, op);
      }
      return rejected(op, 'invalid_parent', 0);
    }
    const parent = op.parent!;
    let rebased = false;
    let anchor = op.before_id;
    if (anchor && !this.containerChildren(parent).includes(anchor)) {
      rebased = true;
      anchor = undefined;
    }
    const rev = ++this.head;
    const siblings = this.containerChildren(parent);
    const at = anchor ? siblings.indexOf(anchor) : siblings.length;
    siblings.splice(at, 0, id);
    this.reindex(parent);
    this.nodes.set(id, {
      id,
      type: op.node_type ?? 'bookmark',
      title: op.title ?? '',
      url: op.url,
      parent,
      position: at,
      createdRev: rev,
      titleRev: rev,
      urlRev: rev,
      structureRev: rev,
    });
    this.journal.push({
      revision: rev,
      type: 'create',
      nodeId: op.node_id,
      payload: { type: op.node_type ?? 'bookmark', title: op.title ?? '', ...(op.url ? { url: op.url } : {}), parent: op.parent, position: at },
      origin: { bindingId, clientSeq: op.client_seq },
    });
    return {
      op_id: op.op_id,
      client_seq: op.client_seq,
      status: rebased ? 'REBASED' : 'APPLIED',
      reason: rebased ? 'anchor_moved' : '',
      result_revision: rev,
      settle_after_revision: rev,
    };
  }

  /** Offline create whose parent was deleted: recover under a dedicated root slot. */
  private applyRecoveredCreate(bindingId: string, op: Operation): OpResult {
    const rootKey = `recovered:${bindingId}`;
    this.roots.add(rootKey);
    const id = op.node_id;
    const rev = ++this.head;
    const parent: ParentRef = { type: 'root', key: rootKey };
    const siblings = this.containerChildren(parent);
    const at = siblings.length;
    siblings.push(id);
    this.nodes.set(id, {
      id,
      type: op.node_type ?? 'bookmark',
      title: op.title ?? '',
      url: op.url,
      parent,
      position: at,
      createdRev: rev,
      titleRev: rev,
      urlRev: rev,
      structureRev: rev,
    });
    this.journal.push({
      revision: rev,
      type: 'create',
      nodeId: id,
      payload: { type: op.node_type ?? 'bookmark', title: op.title ?? '', ...(op.url ? { url: op.url } : {}), parent, position: at },
      origin: { bindingId, clientSeq: op.client_seq },
    });
    return { op_id: op.op_id, client_seq: op.client_seq, status: 'RECOVERED', reason: 'parent_deleted', result_revision: rev, settle_after_revision: rev };
  }

  private applyUpdate(bindingId: string, op: Operation, field: 'title' | 'url'): OpResult {
    const node = this.nodes.get(op.node_id);
    if (!node) {
      const tomb = this.tombstones.get(op.node_id);
      return rejected(op, 'target_deleted', tomb ?? 0);
    }
    const fieldRev = field === 'title' ? node.titleRev : node.urlRev;
    const current = field === 'title' ? node.title : (node.url ?? '');
    const wanted = (field === 'title' ? op.title : op.url) ?? '';
    if (fieldRev > op.base_revision) {
      if (!this.sameBindingCausal(bindingId, fieldRev, op.client_seq)) {
        if (current === wanted) {
          return { op_id: op.op_id, client_seq: op.client_seq, status: 'NOOP', reason: 'concurrent_update', result_revision: 0, settle_after_revision: fieldRev };
        }
        return { op_id: op.op_id, client_seq: op.client_seq, status: 'CONFLICT', reason: 'concurrent_update', result_revision: 0, settle_after_revision: fieldRev };
      }
    }
    const rev = ++this.head;
    if (field === 'title') {
      node.title = wanted;
      node.titleRev = rev;
    } else {
      node.url = wanted;
      node.urlRev = rev;
    }
    this.journal.push({ revision: rev, type: field === 'title' ? 'update_title' : 'update_url', nodeId: op.node_id, payload: field === 'title' ? { title: wanted } : { url: wanted }, origin: { bindingId, clientSeq: op.client_seq } });
    return { op_id: op.op_id, client_seq: op.client_seq, status: 'APPLIED', reason: '', result_revision: rev, settle_after_revision: rev };
  }

  private applyMove(bindingId: string, op: Operation): OpResult {
    const node = this.nodes.get(op.node_id);
    if (!node) {
      const tomb = this.tombstones.get(op.node_id);
      return rejected(op, 'target_deleted', tomb ?? 0);
    }
    if (!this.validParent(op.parent)) {
      return rejected(op, 'invalid_parent', 0);
    }
    const parent = op.parent!;
    let rebased = false;
    let anchor = op.before_id;
    if (anchor && (!this.nodes.has(anchor) || !this.containerChildren(parent).includes(anchor))) {
      rebased = true;
      anchor = undefined;
    }
    const siblings = this.containerChildren(parent);
    const base = siblings.filter((id) => id !== op.node_id);
    const at = anchor ? base.indexOf(anchor) : base.length;
    const sameParent = parentKeyOf(node.parent) === parentKeyOf(parent);
    if (sameParent && node.position === at) {
      return { op_id: op.op_id, client_seq: op.client_seq, status: 'NOOP', reason: 'already_in_place', result_revision: 0, settle_after_revision: node.structureRev };
    }
    if (node.structureRev > op.base_revision && !this.sameBindingCausal(bindingId, node.structureRev, op.client_seq)) {
      return { op_id: op.op_id, client_seq: op.client_seq, status: 'CONFLICT', reason: 'concurrent_move', result_revision: 0, settle_after_revision: node.structureRev };
    }
    const rev = ++this.head;
    if (!sameParent) {
      const oldSiblings = this.containerChildren(node.parent);
      oldSiblings.splice(oldSiblings.indexOf(op.node_id), 1);
      this.reindex(node.parent);
    }
    const newSiblings = this.containerChildren(parent);
    newSiblings.splice(at, 0, op.node_id);
    node.parent = parent;
    this.reindex(parent);
    node.structureRev = rev;
    this.journal.push({
      revision: rev,
      type: 'move',
      nodeId: op.node_id,
      payload: { parent, position: at },
      origin: { bindingId, clientSeq: op.client_seq },
    });
    return {
      op_id: op.op_id,
      client_seq: op.client_seq,
      status: rebased ? 'REBASED' : 'APPLIED',
      reason: rebased ? 'anchor_moved' : '',
      result_revision: rev,
      settle_after_revision: rev,
    };
  }

  private applyDelete(bindingId: string, op: Operation): OpResult {
    const node = this.nodes.get(op.node_id);
    if (!node) {
      const tomb = this.tombstones.get(op.node_id);
      if (tomb !== undefined) {
        return { op_id: op.op_id, client_seq: op.client_seq, status: 'NOOP', reason: 'already_deleted', result_revision: 0, settle_after_revision: tomb };
      }
      return rejected(op, 'invalid_target', 0);
    }
    const rev = ++this.head;
    const stack = [op.node_id];
    let count = 0;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const curNode = this.nodes.get(cur);
      if (!curNode) {
        continue;
      }
      stack.push(...this.containerChildren({ type: 'node', id: cur }));
      this.tombstones.set(cur, rev);
      if (curNode.parent.type === 'node') {
        const siblings = this.containerChildren(curNode.parent);
        const at = siblings.indexOf(cur);
        if (at >= 0) {
          siblings.splice(at, 1);
        }
      } else {
        const siblings = this.containerChildren(curNode.parent);
        const at = siblings.indexOf(cur);
        if (at >= 0) {
          siblings.splice(at, 1);
        }
      }
      this.reindex(curNode.parent);
      this.nodes.delete(cur);
      count++;
    }
    this.journal.push({ revision: rev, type: 'delete', nodeId: op.node_id, payload: { count }, origin: { bindingId, clientSeq: op.client_seq } });
    return { op_id: op.op_id, client_seq: op.client_seq, status: 'APPLIED', reason: '', result_revision: rev, settle_after_revision: rev };
  }

  private reindex(parent: ParentRef): void {
    this.containerChildren(parent).forEach((id, i) => {
      const node = this.nodes.get(id);
      if (node) {
        node.position = i;
      }
    });
  }

  private validParent(parent?: ParentRef): boolean {
    if (!parent) {
      return false;
    }
    if (parent.type === 'root') {
      return this.roots.has(parent.key!);
    }
    const node = this.nodes.get(parent.id!);
    return node !== undefined && node.type === 'folder';
  }

  private sameBindingCausal(bindingId: string, revision: number, opSeq: number): boolean {
    const entry = this.journal[revision - 1];
    if (!entry || !entry.origin) {
      return false;
    }
    return entry.origin.bindingId === bindingId && entry.origin.clientSeq < opSeq;
  }
}

function parentKeyOf(parent: ParentRef): string {
  return parent.type === 'node' ? parent.id! : `root:${parent.key}`;
}

function rejected(op: Operation, reason: string, settle: number): OpResult {
  return { op_id: op.op_id, client_seq: op.client_seq, status: 'REJECTED', reason, result_revision: 0, settle_after_revision: settle };
}

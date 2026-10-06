// Initial Sync engine (doc 06 §4-§6): persistent reconciliation state
// machine over the incremental pipeline.
//
//   PREPARE → FETCH_SERVER (inbox only, no apply) → SNAPSHOT_BROWSER →
//   ANALYZE (journal replay + four-case classification) →
//   [WAIT_USER] → COMMIT_SERVER (mappings + uploads) → APPLY_BROWSER
//   (release the normal coordinator loop) → VERIFY (mandatory, §14) →
//   ACTIVE.
//
// Every phase is persisted to a recon session so an MV3 worker kill can
// resume; fetch/match are idempotent, so resuming re-runs them safely.
// Nested browser-only subtrees cannot reference a canonical parent until
// the parent's create is acked, so uploads advance one level per quiesce
// iteration (uploadPass / importPass). Event capture keeps running the
// whole time (doc 05 §13); nodes captured mid-reconciliation are
// protected from double-upload by the outbox skip check, and VERIFY's
// targeted repair pass picks up the rest.

import type { BrowserAdapter, BrowserNode } from '../browser/types';
import {
  activeReconSession,
  emptyReconProgress,
  findMirrorByCanonical,
  logDiagnostic,
  type BindingRecord,
  type ExpectedMutationRecord,
  type LocalNodeRecord,
  type PontisDB,
  type PendingOpRecord,
  type ReconDecision,
  type ReconSessionRecord,
  type ReconType,
} from '../store/db';
import {
  MAX_CHANGES_PER_ROUND,
  SYNC_PROTOCOL_VERSION,
  type ChangeWire,
  type NodeType,
  type ParentRefWire,
  type SnapshotWire,
  type SyncRequestWire,
} from '../protocol/types';
import { ApiError, type SnapshotTransport, type SyncTransport } from '../transport/client';
import { uuidv7 } from '../util/ids';
import {
  countBrowserSubtree,
  matchExact,
  snapshotBrowserTree,
  type BrowserSnapshotNode,
  type MatchResult,
} from './exactMatcher';
import {
  canonicalChildren,
  countSubtree,
  replayChanges,
  snapshotToTree,
  type CanonicalTree,
  type CanonicalTreeNode,
} from './canonicalTree';
import type { SyncCoordinator } from './syncCoordinator';

const MAX_FETCH_ROUNDS = 200;
/** One level of an unmapped subtree resolves per iteration. */
const MAX_QUIESCE_ROUNDS = 64;

export interface VerifyProblem {
  kind: 'missing_mirror' | 'orphan_mirror' | 'field_mismatch' | 'order_drift';
  browserId?: string;
  canonicalId?: string;
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  problems: VerifyProblem[];
}

/** Import queue entry: outbox op → the source browser node it copied. */
interface ImportQueueItem {
  opId: string;
  sourceBrowserId: string;
}

export class InitialSyncEngine {
  constructor(
    private db: PontisDB,
    private adapter: BrowserAdapter,
    private transport: SyncTransport & Partial<SnapshotTransport>,
    private coordinator: SyncCoordinator,
  ) {}

  // --- entry points ---

  /** Start (or resume) an initial / mapping-lost reconciliation. */
  async start(bindingId: string, type: ReconType = 'INITIAL'): Promise<ReconSessionRecord> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding) throw new Error(`initialSync: unknown binding ${bindingId}`);
    let session = await activeReconSession(this.db, bindingId);
    if (!session) {
      session = {
        id: uuidv7(),
        bindingId,
        type,
        state: 'RUNNING',
        phase: 'prepare',
        journalFloor: 0,
        serverRevision: 0,
        progress: emptyReconProgress(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.db.reconSessions.put(session);
    }
    await this.db.bindings.update(bindingId, { state: 'initializing' });

    try {
      // FETCH_SERVER: pull the whole journal into the inbox without apply.
      // A pruned journal (floor above our watermarks) falls back to the
      // server snapshot endpoint (doc 06 §8).
      const fetched = await this.fetchIntoInbox(bindingId, session);
      session.phase = 'snapshot';
      await this.touch(session);
      const fresh = await this.mustGetBinding(bindingId);
      const snap = await snapshotBrowserTree(this.adapter, this.mountRootId(fresh));

      // ANALYZE: journal replay + four-case classification (doc 06 §5).
      session.phase = 'analyze';
      await this.touch(session);
      const tree = fetched.status === 'ok' ? await this.replayInbox(bindingId) : fetched.tree;
      const rootParent: ParentRefWire = { type: 'root', key: fresh.mount.rootKey };
      const serverCount = countSubtree(tree, rootParent);
      const browserCount = countBrowserSubtree(snap);

      let match: MatchResult | null = null;
      let decision: ReconDecision;
      if (serverCount === 0 && browserCount === 0) {
        decision = 'merge'; // empty baseline: nothing to upload or apply
      } else if (serverCount > 0 && browserCount > 0) {
        match = matchExact(snap, tree, rootParent);
        session.progress = {
          ...emptyReconProgress(),
          matched: match.matched.length,
          localOnly: match.browserOnly.reduce((n, b) => n + countBrowserSubtree(b) + 1, 0),
          serverOnly: match.serverOnly.length,
          ambiguous: match.ambiguous.length,
        };
        await this.touch(session);
        if (!session.decision) {
          session.state = 'WAITING_USER';
          session.phase = 'wait_user';
          await this.touch(session);
          await this.db.bindings.update(bindingId, { state: 'waiting_user' });
          return session;
        }
        decision = session.decision;
      } else if (serverCount === 0) {
        decision = 'use_browser'; // server empty + browser non-empty → upload
      } else {
        decision = 'use_server'; // server non-empty + browser empty → apply
      }

      return await this.finishWithDecision(bindingId, session, tree, snap, match, decision);
    } catch (err) {
      session.state = 'FAILED';
      session.error = String(err);
      await this.touch(session);
      await logDiagnostic(this.db, 'error', 'initial-sync', 'reconciliation failed', {
        bindingId,
        error: String(err),
      });
      throw err;
    }
  }

  /** Apply a user decision recorded on a WAITING_USER session. */
  async resume(bindingId: string, decision: ReconDecision): Promise<ReconSessionRecord> {
    const session = await activeReconSession(this.db, bindingId);
    if (!session || session.state !== 'WAITING_USER') {
      throw new Error('initialSync: no waiting reconciliation session');
    }
    session.decision = decision;
    await this.touch(session);

    // Rebuild the analysis inputs deterministically (the fetch/match work
    // is idempotent, so re-running it after a worker kill is safe). A
    // snapshot-rebuilt session re-fetches the read-only snapshot instead
    // of replaying an empty inbox.
    const binding = await this.mustGetBinding(bindingId);
    const snap = await snapshotBrowserTree(this.adapter, this.mountRootId(binding));
    const tree = session.snapshotApplied
      ? snapshotToTree((await this.fetchSnapshotWire(bindingId)).nodes)
      : await this.replayInbox(bindingId);
    const rootParent: ParentRefWire = { type: 'root', key: binding.mount.rootKey };
    const serverCount = countSubtree(tree, rootParent);
    const browserCount = countBrowserSubtree(snap);
    const match = serverCount > 0 && browserCount > 0 ? matchExact(snap, tree, rootParent) : null;
    return this.finishWithDecision(bindingId, session, tree, snap, match, decision);
  }

  /** mount_missing recovery: re-select the mount folder (doc 03 §5). */
  async remount(bindingId: string, folderBrowserId: string): Promise<ReconSessionRecord> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding) throw new Error(`initialSync: unknown binding ${bindingId}`);
    if (binding.mount.mode !== 'partial') {
      throw new Error('initialSync: remount only supported for partial bindings');
    }
    // The old mapping is bound to the lost folder — drop replica state and
    // re-reconcile from scratch (mapping-lost, doc 06 §12).
    await this.db.transaction(
      'rw',
      [this.db.bindings, this.db.localNodes, this.db.pendingOps, this.db.expectedMutations, this.db.remoteChanges],
      async () => {
        const b = await this.db.bindings.get(bindingId);
        if (!b) return;
        b.mount = { ...b.mount, folderBrowserId };
        b.state = 'initializing';
        b.appliedRevision = 0;
        b.receivedRevision = 0;
        b.recovery = null;
        await this.db.bindings.put(b);
        await this.db.localNodes.where('bindingId').equals(bindingId).delete();
        await this.db.pendingOps.where('bindingId').equals(bindingId).delete();
        await this.db.expectedMutations.where('bindingId').equals(bindingId).delete();
        await this.db.remoteChanges.where('bindingId').equals(bindingId).delete();
      },
    );
    await logDiagnostic(this.db, 'info', 'initial-sync', 'mount remounted, mapping-lost reconciliation started', {
      bindingId,
      folderBrowserId,
    });
    return this.start(bindingId, 'MAPPING_LOST');
  }

  // --- commit / apply / verify ---

  private async finishWithDecision(
    bindingId: string,
    session: ReconSessionRecord,
    tree: CanonicalTree,
    snap: BrowserSnapshotNode,
    match: MatchResult | null,
    decision: ReconDecision,
  ): Promise<ReconSessionRecord> {
    session.state = 'RUNNING';
    // COMMIT_SERVER: mappings first, then uploads (doc 06 §6: Match/Create
    // only — no rename/move/delete inference).
    session.phase = 'commit';
    await this.touch(session);
    const uploaded = await this.commitDecision(bindingId, session, tree, snap, match, decision);
    session.progress.uploaded = uploaded;
    await this.touch(session);

    // APPLY_BROWSER: release the incremental pipeline and drive uploads
    // level by level until everything converges.
    session.phase = 'apply';
    await this.touch(session);
    await this.db.bindings.update(bindingId, { state: 'active' });
    // Snapshot rebuild (doc 06 §8): canonical nodes are not in the inbox,
    // so the server side is ensured straight into the browser (parent
    // first). use_browser deletes the server-only nodes instead.
    if (session.snapshotApplied && decision !== 'use_browser') {
      await this.applySnapshotNodes(bindingId, tree);
    }
    await this.quiesceLoop(bindingId, session);

    // VERIFY is mandatory (doc 06 §14).
    session.phase = 'verify';
    await this.touch(session);
    const report = await this.verifyAndRepair(bindingId);
    if (!report.ok) {
      session.state = 'FAILED';
      session.error = `verify failed: ${report.problems.map((p) => p.kind).join(',')}`;
      await this.touch(session);
      await this.db.bindings.update(bindingId, {
        state: 'needs_recovery',
        recovery: { code: 'VERIFY_FAILED', message: session.error },
      });
      await logDiagnostic(this.db, 'error', 'initial-sync', 'verification failed', {
        bindingId,
        problems: report.problems,
      });
      return session;
    }

    session.state = 'COMPLETED';
    session.phase = 'done';
    await this.touch(session);
    await this.db.bindings.update(bindingId, { state: 'active', lastSyncAt: Date.now() });
    await logDiagnostic(this.db, 'info', 'initial-sync', 'reconciliation completed', {
      bindingId,
      type: session.type,
      progress: session.progress,
    });
    return session;
  }

  private async commitDecision(
    bindingId: string,
    session: ReconSessionRecord,
    tree: CanonicalTree,
    snap: BrowserSnapshotNode,
    match: MatchResult | null,
    decision: ReconDecision,
  ): Promise<number> {
    // Matched pairs establish identity in every both-non-empty decision.
    if (match) {
      await this.writeMatchedMappings(bindingId, session, match, tree);
    }

    if (decision === 'use_server') {
      // Browser is demoted: remove browser-only subtrees locally; the
      // server-only side flows in through the normal inbox apply.
      if (match) {
        for (const b of match.browserOnly) {
          await this.adapter.remove(b.node.id);
        }
      }
      return 0;
    }

    if (decision === 'import') {
      // Whole browser snapshot is copied under a dated folder. Creates are
      // server-side ops only (never re-mapping the source nodes); each
      // level waits for the previous level's canonical ids (importPass).
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const binding = await this.mustGetBinding(bindingId);
      const opId = await this.enqueueCreate(bindingId, {
        nodeType: 'folder',
        title: `Imported ${stamp}`,
        url: '',
        parent: { type: 'root', key: binding.mount.rootKey },
        browserId: undefined,
        keepResolved: true,
      });
      session.importQueue = [{ opId, sourceBrowserId: this.mountRootId(binding) }];
      await this.touch(session);
      return 1;
    }

    // merge / use_browser: enqueue the first uploadable level; deeper
    // levels follow once parents get their canonical ids.
    let uploaded = 0;
    for (const top of snap.children) {
      uploaded += await this.uploadNode(bindingId, top);
    }
    if (decision === 'use_browser' && match) {
      // Browser is authoritative: server-only canonical nodes are deleted
      // through normal ops; their (absent) browser side is a NOOP.
      for (const c of match.serverOnly) {
        await this.enqueueOp(bindingId, { type: 'delete', nodeId: c.id });
      }
    }
    return uploaded;
  }

  private async writeMatchedMappings(
    bindingId: string,
    session: ReconSessionRecord,
    match: MatchResult,
    tree: CanonicalTree,
  ): Promise<void> {
    for (const pair of match.matched) {
      const c = tree.nodes.get(pair.canonicalId);
      if (!c) continue;
      const mirror = await this.db.localNodes.get([bindingId, pair.browserId]);
      if (mirror && mirror.canonicalId == null) {
        await this.db.localNodes.put({
          ...mirror,
          canonicalId: c.id,
          title: c.title,
          url: c.type === 'bookmark' ? c.url : null,
          position: c.position,
        });
      } else if (!mirror) {
        // Pre-binding browser node: establish the mapping from scratch.
        const node = await this.adapter.getNode(pair.browserId);
        if (!node) continue;
        await this.db.localNodes.put({
          bindingId,
          browserId: node.id,
          canonicalId: c.id,
          type: node.type,
          title: node.title,
          url: node.url,
          parentBrowserId: node.parentId,
          position: c.position,
        });
      }
    }
    session.progress.matched = match.matched.length;
  }

  // --- level-by-level upload ---

  /**
   * Enqueue a create for this node when its parent is already mapped and
   * the node is neither mapped nor captured by the event pipeline.
   * Returns 1 when enqueued. Children are handled by later passes once
   * this node's create is acked and adopted.
   */
  private async uploadNode(bindingId: string, node: BrowserSnapshotNode): Promise<number> {
    if (await this.shouldSkipUpload(bindingId, node.node.id)) {
      // Already mapped: its children may be uploadable right away.
      let count = 0;
      for (const child of node.children) count += await this.uploadNode(bindingId, child);
      return count;
    }
    const parentRef = await this.canonicalParentRef(bindingId, node.node.parentId);
    if (!parentRef) return 0; // parent not mapped yet; later pass
    await this.enqueueCreate(bindingId, {
      nodeType: node.node.type,
      title: node.node.title,
      url: node.node.url ?? '',
      parent: parentRef,
      browserId: node.node.id,
    });
    return 1;
  }

  /** Nodes already mapped or already captured by the event pipeline. */
  private async shouldSkipUpload(bindingId: string, browserId: string): Promise<boolean> {
    const mirror = await this.db.localNodes.get([bindingId, browserId]);
    if (mirror?.canonicalId) return true;
    const pending = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'QUEUED'])
      .filter((o) => o.browserId === browserId)
      .first();
    return pending != null || mirror != null;
  }

  /**
   * Import mode: for every resolved queue item, enqueue its source
   * children under the newly created canonical parent. Returns the number
   * of items that made progress this pass.
   */
  private async importPass(bindingId: string, session: ReconSessionRecord): Promise<number> {
    const queue = session.importQueue ?? [];
    if (queue.length === 0) return 0;
    const next: ImportQueueItem[] = [];
    let progress = 0;
    for (const item of queue) {
      const canonicalId = await this.resolvedCanonicalId(bindingId, item.opId);
      if (!canonicalId) {
        next.push(item);
        continue;
      }
      // The op was kept resolved only for this lookup; drop it now that
      // its canonical id is folded into the next queue level.
      await this.db.pendingOps.delete(item.opId);
      progress += 1;
      const source = await this.adapter.getNode(item.sourceBrowserId);
      if (!source) continue;
      for (const child of await this.adapter.getChildren(item.sourceBrowserId)) {
        const opId = await this.enqueueCreate(bindingId, {
          nodeType: child.type,
          title: child.title,
          url: child.url ?? '',
          parent: { type: 'node', id: canonicalId },
          browserId: undefined, // import creates copies, never re-maps
          keepResolved: true,
        });
        next.push({ opId, sourceBrowserId: child.id });
      }
    }
    session.importQueue = next.length > 0 ? next : undefined;
    await this.touch(session);
    return progress;
  }

  /** Canonical id produced by an acked create op, if visible yet. */
  private async resolvedCanonicalId(bindingId: string, opId: string): Promise<string | null> {
    const op = await this.db.pendingOps.get(opId);
    const revision = op?.result?.resultRevision;
    if (!op || op.status !== 'RESOLVED' || revision == null) return null;
    const change = await this.db.remoteChanges.get(`${bindingId}:${revision}`);
    return change?.nodeId ?? null;
  }

  // --- quiesce + verify ---

  /** Drive sync rounds + upload passes until no work remains. */
  private async quiesceLoop(bindingId: string, session?: ReconSessionRecord): Promise<void> {
    for (let i = 0; i < MAX_QUIESCE_ROUNDS; i++) {
      await this.coordinator.syncBinding(bindingId);
      const uploadProgress = await this.uploadPassAll(bindingId);
      const importProgress = session ? await this.importPass(bindingId, session) : 0;
      if (uploadProgress === 0 && importProgress === 0 && (await this.isQuiescent(bindingId))) {
        return;
      }
    }
    await logDiagnostic(this.db, 'warn', 'initial-sync', 'quiesce budget exhausted', { bindingId });
  }

  private async uploadPassAll(bindingId: string): Promise<number> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || binding.mount.mode !== 'partial' || !binding.mount.folderBrowserId) return 0;
    // Import copies the snapshot to a dated folder instead of uploading it
    // in place — the in-place upload pass must stay off, or the sources
    // would be uploaded a second time alongside their copies.
    const session = await activeReconSession(this.db, bindingId);
    if (session?.decision === 'import') return 0;
    const snap = await snapshotBrowserTree(this.adapter, binding.mount.folderBrowserId);
    let count = 0;
    for (const top of snap.children) count += await this.uploadNode(bindingId, top);
    return count;
  }

  private async isQuiescent(bindingId: string): Promise<boolean> {
    return isQuiescent(this.db, bindingId);
  }

  /**
   * Rescan the managed scope and compare browser ↔ mirror. Missing
   * mirrors and field drift are repaired once via targeted ops
   * (PROCESS_DEFERRED_LOCAL_CHANGES, doc 06 §13); whatever still
   * diverges fails verification.
   */
  async verifyAndRepair(bindingId: string): Promise<VerifyReport> {
    const binding = await this.mustGetBinding(bindingId);
    if (binding.mount.mode === 'partial' && binding.mount.folderBrowserId) {
      const snap = await snapshotBrowserTree(this.adapter, binding.mount.folderBrowserId);
      const mirrors = new Map(
        (await this.db.localNodes.where('bindingId').equals(bindingId).toArray()).map((m) => [m.browserId, m]),
      );
      const queue: BrowserSnapshotNode[] = [...snap.children];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        queue.push(...cur.children);
        const mirror = mirrors.get(cur.node.id);
        if (!mirror) continue; // repaired by uploadPass below
        if (mirror.canonicalId == null) continue; // upload still in flight
        if (cur.node.title !== mirror.title) {
          await this.enqueueOp(bindingId, { type: 'update_title', nodeId: mirror.canonicalId, title: cur.node.title });
        }
        if ((cur.node.url ?? null) !== mirror.url) {
          await this.enqueueOp(bindingId, { type: 'update_url', nodeId: mirror.canonicalId, url: cur.node.url ?? '' });
        }
      }
      await this.uploadPassAll(bindingId);
      await this.quiesceLoop(bindingId);
    }
    return this.verifyScan(bindingId);
  }

  /**
   * Read-only integrity scan (doc 05 §14): browser ↔ mirror drift
   * classification without side effects; also the verify half of
   * verifyAndRepair.
   */
  async verifyScan(bindingId: string): Promise<VerifyReport> {
    const binding = await this.mustGetBinding(bindingId);
    const snap = await snapshotBrowserTree(this.adapter, this.mountRootId(binding));
    const mirrors = await this.db.localNodes.where('bindingId').equals(bindingId).toArray();
    const byBrowser = new Map(mirrors.map((m) => [m.browserId, m]));
    const problems: VerifyProblem[] = [];
    // Import deliberately leaves snapshot sources unmapped — their absence
    // from the replica state is the decision's semantics, not drift.
    const session = await activeReconSession(this.db, bindingId);
    const importMode = session?.decision === 'import';

    const queue: BrowserSnapshotNode[] = [...snap.children];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      queue.push(...cur.children);
      const mirror = byBrowser.get(cur.node.id);
      if (!mirror) {
        if (!importMode) problems.push({ kind: 'missing_mirror', browserId: cur.node.id });
        continue;
      }
      if (mirror.canonicalId == null) {
        problems.push({ kind: 'missing_mirror', browserId: cur.node.id, detail: 'unmapped after apply' });
        continue;
      }
      if (cur.node.title !== mirror.title || (cur.node.url ?? null) !== mirror.url) {
        problems.push({ kind: 'field_mismatch', browserId: cur.node.id, canonicalId: mirror.canonicalId });
      }
    }

    for (const m of mirrors) {
      if (!m.browserId) continue;
      const node = await this.adapter.getNode(m.browserId);
      if (!node && m.browserId !== this.mountRootId(binding)) {
        problems.push({ kind: 'orphan_mirror', browserId: m.browserId, canonicalId: m.canonicalId ?? undefined });
      }
    }

    // Order drift is advisory only: sibling reorder may be genuine local
    // intent that the next sync round propagates.
    problems.push(...(await this.orderDrift(bindingId, binding, mirrors, snap)));

    return { ok: !problems.some((p) => p.kind !== 'order_drift'), problems };
  }

  private async orderDrift(
    bindingId: string,
    binding: BindingRecord,
    mirrors: LocalNodeRecord[],
    snap: BrowserSnapshotNode,
  ): Promise<VerifyProblem[]> {
    const tree = await this.replayInbox(bindingId);
    const mapped = mirrors.filter((m) => m.canonicalId);
    const canonicalToBrowser = new Map(mapped.map((m) => [m.canonicalId!, m.browserId]));
    const browserToCanonical = new Map(mapped.map((m) => [m.browserId, m.canonicalId!]));
    const problems: VerifyProblem[] = [];

    const checkLevel = async (parent: BrowserSnapshotNode, canonicalParent: ParentRefWire): Promise<void> => {
      const canonicalOrder = canonicalChildren(tree, canonicalParent)
        .map((c) => canonicalToBrowser.get(c.id))
        .filter((id): id is string => id != null);
      const browserOrder = parent.children
        .map((c) => c.node.id)
        .filter((id) => browserToCanonical.has(id) && canonicalOrder.includes(id));
      for (let i = 0; i < Math.min(canonicalOrder.length, browserOrder.length); i++) {
        if (canonicalOrder[i] !== browserOrder[i]) {
          problems.push({
            kind: 'order_drift',
            browserId: parent.node.id,
            detail: `canonical ${canonicalOrder[i]} vs browser ${browserOrder[i]}`,
          });
          break;
        }
      }
      for (const child of parent.children) {
        if (child.node.type !== 'folder') continue;
        const canonicalId = browserToCanonical.get(child.node.id);
        if (canonicalId) {
          await checkLevel(child, { type: 'node', id: canonicalId });
        }
      }
    };
    await checkLevel(snap, { type: 'root', key: binding.mount.rootKey });
    return problems;
  }

  // --- fetch + replay ---

  /**
   * Pull the full journal into the inbox without applying. When the
   * journal floor is above our watermarks the incremental stream is
   * unreconstructable; the server snapshot endpoint (doc 06 §8) takes
   * over: fetch the canonical tree, anchor the watermarks at
   * snapshot_revision and hand the rebuilt tree to the caller.
   */
  private async fetchIntoInbox(
    bindingId: string,
    session: ReconSessionRecord,
  ): Promise<{ status: 'ok' } | { status: 'snapshot'; tree: CanonicalTree }> {
    let floor = 0;
    for (let round = 0; round < MAX_FETCH_ROUNDS; round++) {
      const b = await this.mustGetBinding(bindingId);
      if (b.state !== 'initializing') return { status: 'ok' };
      const req: SyncRequestWire = {
        protocol_version: SYNC_PROTOCOL_VERSION,
        epoch: b.epoch,
        applied_revision: b.appliedRevision,
        received_revision: b.receivedRevision,
        operations: [],
        max_changes: MAX_CHANGES_PER_ROUND,
      };
      let resp;
      try {
        resp = await this.transport.sync(bindingId, req);
      } catch (err) {
        // The server rejects a request whose received_revision is below
        // the journal floor before we ever see the floor field — fall
        // back to the snapshot just like the in-band check below.
        if (err instanceof ApiError && err.code === 'HISTORY_EXPIRED' && b.appliedRevision === 0 && b.receivedRevision === 0) {
          const tree = await this.recoverViaSnapshot(bindingId, session);
          return { status: 'snapshot', tree };
        }
        if (err instanceof ApiError && err.isProtocolError) {
          await this.db.bindings.update(bindingId, {
            state: 'needs_recovery',
            recovery: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
      if (resp.journal_floor_revision > 0 && b.appliedRevision === 0 && b.receivedRevision === 0) {
        // Pruned history: the tree cannot be rebuilt from the journal.
        const tree = await this.recoverViaSnapshot(bindingId, session);
        return { status: 'snapshot', tree };
      }
      // Rule 3 (doc 05 §16): inbox persisted, then received_revision.
      await this.db.transaction('rw', [this.db.bindings, this.db.remoteChanges], async () => {
        const current = await this.db.bindings.get(bindingId);
        if (!current) return;
        if (current.epoch !== resp.epoch) {
          current.state = 'needs_recovery';
          current.recovery = { code: 'EPOCH_MISMATCH', message: 'epoch changed during initial fetch' };
          await this.db.bindings.put(current);
          return;
        }
        for (const c of resp.changes) {
          await this.db.remoteChanges.put({
            id: `${bindingId}:${c.revision}`,
            bindingId,
            revision: c.revision,
            type: c.type,
            nodeId: c.node_id,
            payload: c.payload,
          });
        }
        current.receivedRevision = Math.max(current.receivedRevision, resp.through_revision);
        await this.db.bindings.put(current);
      });
      floor = Math.max(floor, resp.journal_floor_revision);
      session.journalFloor = floor;
      session.serverRevision = resp.server_revision;
      session.progress.applied = resp.through_revision;
      await this.touch(session);
      if (!resp.has_more) return { status: 'ok' };
    }
    throw new Error('initialSync: fetch did not converge within round budget');
  }

  private async replayInbox(bindingId: string): Promise<CanonicalTree> {
    const rows = await this.db.remoteChanges.where('bindingId').equals(bindingId).sortBy('revision');
    const changes: ChangeWire[] = rows.map((r) => ({
      revision: r.revision,
      type: r.type,
      node_id: r.nodeId,
      payload: r.payload as ChangeWire['payload'],
    }));
    return replayChanges(changes);
  }

  // --- snapshot recovery (doc 06 §8) ---

  /** Fetch the read-only snapshot; the transport must support it. */
  private async fetchSnapshotWire(bindingId: string): Promise<SnapshotWire> {
    if (!this.transport.fetchSnapshot) {
      throw new Error('initialSync: transport cannot serve snapshots');
    }
    return this.transport.fetchSnapshot(bindingId);
  }

  /**
   * Pruned-journal recovery: fetch the canonical snapshot, anchor the
   * watermarks at (epoch, snapshot_revision) and rebuild the in-memory
   * tree from the snapshot nodes. Browser-side ensure happens later, in
   * applySnapshotNodes, after the four-case decision.
   */
  private async recoverViaSnapshot(bindingId: string, session: ReconSessionRecord): Promise<CanonicalTree> {
    const snap = await this.fetchSnapshotWire(bindingId);
    await this.db.transaction('rw', [this.db.bindings], async () => {
      const b = await this.db.bindings.get(bindingId);
      if (!b) return;
      if (b.epoch !== snap.epoch) {
        b.state = 'needs_recovery';
        b.recovery = { code: 'EPOCH_MISMATCH', message: 'epoch changed before snapshot apply' };
        await this.db.bindings.put(b);
        return;
      }
      b.appliedRevision = snap.snapshot_revision;
      b.receivedRevision = snap.snapshot_revision;
      await this.db.bindings.put(b);
    });
    const b = await this.mustGetBinding(bindingId);
    if (b.epoch !== snap.epoch) {
      throw new Error('initialSync: epoch changed during snapshot fetch');
    }
    session.journalFloor = snap.journal_floor_revision;
    session.serverRevision = snap.snapshot_revision;
    session.snapshotApplied = true;
    session.progress.applied = snap.snapshot_revision;
    await this.touch(session);
    await logDiagnostic(this.db, 'info', 'initial-sync', 'canonical snapshot fetched, rebuilding replica state', {
      bindingId,
      snapshotRevision: snap.snapshot_revision,
      floor: snap.journal_floor_revision,
      nodes: snap.nodes.length,
    });
    return snapshotToTree(snap.nodes);
  }

  /**
   * Snapshot rebuild: create the canonical tree in the browser level by
   * level (parent first) and record mirrors. Nodes that already have a
   * mirror (crash-resume) are skipped; creation follows the applier's
   * expected-mutation pattern so event capture never mistakes these
   * ensures for local intent (doc 05 §8).
   */
  private async applySnapshotNodes(bindingId: string, tree: CanonicalTree): Promise<void> {
    const binding = await this.mustGetBinding(bindingId);
    const mountRootId = this.mountRootId(binding);
    const rootParent: ParentRefWire = { type: 'root', key: binding.mount.rootKey };
    const queue: Array<{ node: CanonicalTreeNode; parentBrowserId: string }> = [];
    for (const node of canonicalChildren(tree, rootParent)) {
      queue.push({ node, parentBrowserId: mountRootId });
    }
    while (queue.length > 0) {
      const { node, parentBrowserId } = queue.shift()!;
      const existing = await findMirrorByCanonical(this.db, bindingId, node.id);
      let browserId: string;
      if (existing) {
        browserId = existing.browserId;
      } else {
        const exp: ExpectedMutationRecord = {
          bindingId,
          revision: node.revision,
          kind: 'create',
          canonicalId: node.id,
          browserId: null,
          parentBrowserId,
          position: node.position,
          title: node.title,
          url: node.type === 'bookmark' ? node.url : '',
          createdAt: Date.now(),
        };
        await this.db.expectedMutations.add(exp);
        const created = await this.adapter.create(parentBrowserId, {
          title: node.title,
          url: node.type === 'bookmark' ? node.url || undefined : undefined,
        });
        await this.db.transaction('rw', [this.db.localNodes, this.db.expectedMutations], async () => {
          await this.db.expectedMutations.delete(exp.id!);
          await this.db.localNodes.put({
            bindingId,
            browserId: created.id,
            canonicalId: node.id,
            type: created.type,
            title: created.title,
            url: created.url,
            parentBrowserId: created.parentId,
            position: node.position,
          });
        });
        browserId = created.id;
      }
      for (const child of canonicalChildren(tree, { type: 'node', id: node.id })) {
        queue.push({ node: child, parentBrowserId: browserId });
      }
    }
  }

  // --- outbox helpers ---

  private async enqueueCreate(
    bindingId: string,
    create: {
      nodeType: NodeType;
      title: string;
      url: string;
      parent: ParentRefWire;
      browserId?: string;
      /** Keep the op after settle: the import queue needs its result. */
      keepResolved?: boolean;
    },
  ): Promise<string> {
    const opId = uuidv7();
    await this.db.transaction('rw', [this.db.bindings, this.db.pendingOps, this.db.localNodes], async () => {
      const b = await this.db.bindings.get(bindingId);
      if (!b) return;
      b.clientSeq += 1;
      const record: PendingOpRecord = {
        opId,
        bindingId,
        clientSeq: b.clientSeq,
        baseRevision: b.appliedRevision,
        status: 'QUEUED',
        type: 'create',
        nodeId: '',
        nodeType: create.nodeType,
        title: create.title,
        url: create.url || undefined,
        parent: create.parent,
        beforeId: null,
        browserId: create.browserId,
        keepResolved: create.keepResolved,
        createdAt: Date.now(),
      };
      await this.db.pendingOps.add(record);
      // Mirror with null canonical id: the ack回流 adopts this node via
      // tryAdoptLocalCreate instead of creating a browser duplicate.
      if (create.browserId) {
        await this.db.localNodes.put({
          bindingId,
          browserId: create.browserId,
          canonicalId: null,
          type: create.nodeType,
          title: create.title,
          url: create.url || null,
          parentBrowserId: null,
          position: null,
        });
      }
      await this.db.bindings.put(b);
    });
    return opId;
  }

  private async enqueueOp(
    bindingId: string,
    op: { type: PendingOpRecord['type']; nodeId: string; title?: string; url?: string },
  ): Promise<void> {
    await this.db.transaction('rw', [this.db.bindings, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(bindingId);
      if (!b) return;
      b.clientSeq += 1;
      await this.db.pendingOps.add({
        opId: uuidv7(),
        bindingId,
        clientSeq: b.clientSeq,
        baseRevision: b.appliedRevision,
        status: 'QUEUED',
        type: op.type,
        nodeId: op.nodeId,
        title: op.title,
        url: op.url,
        createdAt: Date.now(),
      });
      await this.db.bindings.put(b);
    });
  }

  // --- misc helpers ---

  private async canonicalParentRef(bindingId: string, parentBrowserId: string | null): Promise<ParentRefWire | null> {
    if (parentBrowserId == null) return null;
    const binding = await this.mustGetBinding(bindingId);
    if (binding.mount.mode === 'partial' && parentBrowserId === binding.mount.folderBrowserId) {
      return { type: 'root', key: binding.mount.rootKey };
    }
    const parent = await this.db.localNodes.get([bindingId, parentBrowserId]);
    if (parent?.canonicalId) return { type: 'node', id: parent.canonicalId };
    return null;
  }

  private mountRootId(binding: BindingRecord): string {
    if (binding.mount.mode === 'partial') {
      if (!binding.mount.folderBrowserId) throw new Error('initialSync: partial binding has no mount folder');
      return binding.mount.folderBrowserId;
    }
    const first = Object.values(binding.mount.roots ?? {})[0];
    if (!first) throw new Error('initialSync: full binding has no roots');
    return first;
  }

  private async mustGetBinding(bindingId: string): Promise<BindingRecord> {
    const b = await this.db.bindings.get(bindingId);
    if (!b) throw new Error(`initialSync: binding ${bindingId} vanished`);
    return b;
  }

  private async touch(session: ReconSessionRecord): Promise<void> {
    session.updatedAt = Date.now();
    await this.db.reconSessions.put(session);
  }
}

/** No queued ops, no unapplied inbox rows, watermarks level. */
export async function isQuiescent(db: PontisDB, bindingId: string): Promise<boolean> {
  const b = await db.bindings.get(bindingId);
  if (!b) return true;
  if (b.appliedRevision !== b.receivedRevision) return false;
  const queued = await db.pendingOps.where('[bindingId+status]').equals([bindingId, 'QUEUED']).count();
  if (queued > 0) return false;
  const unapplied = await db.remoteChanges
    .where('[bindingId+revision]')
    .between([bindingId, b.appliedRevision + 1], [bindingId, Number.MAX_SAFE_INTEGER], true, true)
    .count();
  return unapplied === 0;
}

export type { BrowserNode };

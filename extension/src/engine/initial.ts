import { ClientSnapshot } from '@pontis/protocol';

import { BrowserAdapter, BrowserNode } from '../adapter/types';
import { ReplicaStore } from '../store/replica';
import { RemoteApplier } from './applier';
import { ServerClient } from './client';
import { decodeSession } from '@pontis/protocol';

/**
 * Initial reconciliation client flow (doc 06 §4): snapshot the browser,
 * let the server plan, commit server-side, apply the steps, finalize.
 * Ambiguities keep the safe default (duplicate create, never guessed).
 * Every phase runs through durable store state, so a killed worker can
 * simply re-run the flow.
 */
export class InitialReconciler {
  private applier: RemoteApplier;

  constructor(private store: ReplicaStore, private adapter: BrowserAdapter, private client: ServerClient, private bindingId: string) {
    this.applier = new RemoteApplier(store, adapter, bindingId);
  }

  async run(): Promise<{ commitRevision: number }> {
    // SNAPSHOT_BROWSER
    const snapshot = await this.buildClientSnapshot();

    // PREPARE: open the session and hand over the browser snapshot.
    let decoded = decodeSession(await this.client.createReconciliation(this.bindingId, { type: 'initial', reason: 'initial sync' }));
    await this.client.submitClientSnapshot(this.bindingId, snapshot);

    // FETCH_SERVER: freeze the canonical point-in-time.
    await this.client.createServerSnapshot(this.bindingId);

    // ANALYZE / PREPARE_PLAN.
    decoded = decodeSession(await this.client.plan(decoded.session.id));

    // WAIT_USER_DECISION: V1 keeps the safe default; the recovery UI
    // replaces this block later.
    if (decoded.session.state === 'waiting_user') {
      const decisions: Record<string, string> = {};
      for (const issue of decoded.issues) {
        decisions[issue.id] = issue.default_choice;
      }
      decoded = decodeSession(await this.client.decide(decoded.session.id, { decisions }));
    }

    // COMMIT_SERVER.
    const commitBody = (await this.client.commit(decoded.session.id)) as { committed: boolean; commit_revision: number };

    // APPLY_BROWSER (ensure-state steps, assign_identity first).
    const steps = await this.client.steps(decoded.session.id);
    await this.applier.applySteps(steps.steps);

    // FINALIZE: the binding baseline jumps to the committed revision.
    await this.client.complete(decoded.session.id);
    const binding = await this.store.getBinding(this.bindingId);
    if (!binding) {
      throw new Error(`initial: unknown binding ${this.bindingId}`);
    }
    const commitRevision = commitBody.commit_revision || decoded.session.target_revision;
    await this.store.db.bindings.update(this.bindingId, {
      appliedRevision: commitRevision,
      receivedRevision: commitRevision,
      epoch: decoded.session.target_epoch || 1,
    });
    // PROCESS_DEFERRED_LOCAL_CHANGES: intents captured before the
    // baseline exist only inside the imported snapshot — replaying them
    // would duplicate the data. V1 drops them; the periodic integrity
    // scan heals any later drift (doc 06 §13).
    await this.store.clearPendingOperations(this.bindingId);
    return { commitRevision };
  }

  /**
   * Projects the browser tree into the doc 08 §10 wire shape with
   * session-local refs (the browser node ids themselves).
   */
  async buildClientSnapshot(): Promise<ClientSnapshot> {
    const binding = await this.store.getBinding(this.bindingId);
    if (!binding) {
      throw new Error(`initial: unknown binding ${this.bindingId}`);
    }
    const snapshot: ClientSnapshot = { epoch: binding.appliedRevision, revision: binding.receivedRevision, roots: [], nodes: [] };
    for (const [rootKey, browserRootId] of Object.entries(binding.rootMap)) {
      const root = await this.adapter.getNode(browserRootId);
      if (!root) {
        throw new Error(`initial: mapped root ${rootKey} (${browserRootId}) missing in the browser`);
      }
      snapshot.roots.push({ local_ref: browserRootId, root_key: rootKey, title: root.title });
      await this.walk(browserRootId, snapshot);
    }
    return snapshot;
  }

  private async walk(browserId: string, snapshot: ClientSnapshot): Promise<void> {
    const children = await this.adapter.getChildren(browserId);
    for (const child of children) {
      snapshot.nodes.push({
        local_ref: child.id,
        parent_local_ref: browserId,
        type: child.type as 'folder' | 'bookmark',
        title: child.title,
        url: child.url ?? '',
      });
      if (child.type === 'folder') {
        await this.walk(child.id, snapshot);
      }
    }
  }
}

export type { BrowserNode };

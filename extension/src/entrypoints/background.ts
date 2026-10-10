// MV3 service worker: wires the sync core to the browser. Keep thin —
// all logic lives in the core modules. The worker may be killed at any
// await; every durable fact is in IndexedDB / storage.local.
//
// Everything below is chrome.* plumbing and message routing. The trigger
// orchestration an alarm, a manual click, a wake and a recovery all share is
// core/sync/workerLoop, where it can be tested.

import { defineBackground } from 'wxt/utils/define-background';
import { createChromiumAdapter } from '../core/browser/chromium';
import { ApiClient } from '../core/transport/client';
import { BootstrapStore } from '../core/store/bootstrap';
import { PontisDB, logDiagnostic, releaseAllRunLocks } from '../core/store/db';
import { InitialReconciler } from '../core/sync/initialReconcile';
import { ReplicaVerifier } from '../core/sync/verifyReplica';
import { RemoteChangeApplier } from '../core/sync/remoteChangeApplier';
import { ResyncService, type IntentDecision } from '../core/sync/resync';
import { SyncCoordinator } from '../core/sync/syncCoordinator';
import { WorkerLoop } from '../core/sync/workerLoop';
import { chromeApi, kvArea } from '../runtime/chromeApi';

export default defineBackground(() => {
  const chrome = chromeApi();
  const db = new PontisDB();
  const bootstrap = new BootstrapStore(kvArea(chrome.storage.local));
  const adapter = createChromiumAdapter(chrome.bookmarks);
  const client = new ApiClient(async () => {
    const b = await bootstrap.get();
    return { serverUrl: b.serverUrl ?? '', token: b.deviceToken };
  });
  const coordinator = new SyncCoordinator(db, new RemoteChangeApplier(db, adapter), client, client);
  const verifier = new ReplicaVerifier(db, adapter, coordinator);
  const resync = new ResyncService(db, client, bootstrap, coordinator, verifier);
  const reconciler = new InitialReconciler(db, adapter, client);
  const loop = new WorkerLoop({ db, adapter, coordinator, reconciler, resync, verifier });

  chrome.alarms.create('pontis-sync', { periodInMinutes: 5 });
  chrome.alarms.create('pontis-integrity', { periodInMinutes: 24 * 60 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'pontis-sync') void loop.runSync('alarm');
    if (alarm.name === 'pontis-integrity') void loop.runIntegrity('daily');
  });
  chrome.runtime.onStartup.addListener(() => {
    void loop.runSync('startup');
    void loop.runIntegrity('startup');
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (isMessage(msg, 'pontis/manual-sync')) {
      void loop.runSync('manual').then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err) }),
      );
      return true; // async response
    }
    if (isMessage(msg, 'pontis/resolve-intents')) {
      const { bindingId, decisions } = msg as { bindingId: string; decisions: IntentDecision[] };
      void resync
        .resolveIntents(bindingId, decisions)
        .then((outcome) => sendResponse({ ok: true, outcome }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (isMessage(msg, 'pontis/integrity-check')) {
      const { bindingId } = msg as { bindingId: string };
      void loop
        .integrityFor(bindingId)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (isMessage(msg, 'pontis/initial-reconcile-answer')) {
      const { bindingId, decisions } = msg as { bindingId: string; decisions: Record<string, string> };
      void reconciler
        .answer(bindingId, decisions)
        .then((outcome) => sendResponse({ ok: true, outcome }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (isMessage(msg, 'pontis/remount')) {
      const { bindingId, folderBrowserId } = msg as { bindingId: string; folderBrowserId: string };
      void reconciler
        .remount(bindingId, folderBrowserId)
        .then((outcome) => sendResponse({ ok: true, outcome }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    return undefined;
  });

  // --- event capture: never pauses (doc 05 §13) ---

  adapter.onCreated((node) => void loop.dispatch({ kind: 'created', node }));
  adapter.onChanged((node) => void loop.dispatch({ kind: 'changed', node }));
  adapter.onMoved((node, oldParentId) => void loop.dispatch({ kind: 'moved', node, oldParentId }));
  adapter.onRemoved((node) => void loop.dispatch({ kind: 'removed', node }));

  // A lock left behind belongs to the worker this one replaced: MV3 runs a
  // single service worker, so anything still held was abandoned by a kill.
  void releaseAllRunLocks(db)
    .then((cleared) => {
      if (cleared > 0) {
        return logDiagnostic(db, 'warn', 'background', 'cleared run locks left by the previous worker', { cleared });
      }
      return undefined;
    })
    .then(() => loop.runSync('wake'));
});

function isMessage(msg: unknown, type: string): boolean {
  return typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === type;
}

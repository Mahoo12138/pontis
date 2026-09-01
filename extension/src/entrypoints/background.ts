// MV3 service worker: wires the sync core to the browser. Keep thin —
// all logic lives in the core modules. The worker may be killed at any
// await; every durable fact is in IndexedDB / storage.local.

import { defineBackground } from 'wxt/utils/define-background';
import { createChromiumAdapter } from '../core/browser/chromium';
import type { BrowserEvent } from '../core/browser/types';
import { ApiClient } from '../core/transport/client';
import { BootstrapStore } from '../core/store/bootstrap';
import { PontisDB, logDiagnostic, type ReconDecision } from '../core/store/db';
import { EventProcessor } from '../core/sync/eventProcessor';
import { InitialSyncEngine } from '../core/sync/initialSync';
import { RemoteChangeApplier } from '../core/sync/remoteChangeApplier';
import { ResyncService } from '../core/sync/resync';
import { SyncCoordinator } from '../core/sync/syncCoordinator';
import { chromeApi } from '../runtime/chromeApi';

export default defineBackground(() => {
  const chrome = chromeApi();
  const db = new PontisDB();
  const bootstrap = new BootstrapStore(chrome.storage.local);
  const adapter = createChromiumAdapter(chrome.bookmarks);
  const client = new ApiClient(async () => {
    const b = await bootstrap.get();
    return { serverUrl: b.serverUrl ?? '', token: b.deviceToken };
  });
  const applier = new RemoteChangeApplier(db, adapter);
  const coordinator = new SyncCoordinator(db, applier, client);
  const engine = new InitialSyncEngine(db, adapter, client, coordinator);
  const resync = new ResyncService(db, client, bootstrap, coordinator, engine);

  // --- sync triggers (doc 05 §15) ---

  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSync = (delayMs = 1500): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runSync('debounce');
    }, delayMs);
  };

  async function runSync(trigger: string): Promise<void> {
    try {
      await coordinator.syncAll();
      // Recovery is idempotent (doc 06 §7): attempt it on every trigger
      // for bindings stuck in needs_recovery.
      const stuck = await db.bindings.where('state').equals('needs_recovery').toArray();
      for (const b of stuck) {
        try {
          await resync.attemptRecovery(b.id);
        } catch (err) {
          await logDiagnostic(db, 'warn', 'background', 'recovery attempt failed', {
            bindingId: b.id,
            error: String(err),
          });
        }
      }
    } catch (err) {
      await logDiagnostic(db, 'error', 'background', `sync (${trigger}) crashed`, { error: String(err) });
    }
  }

  chrome.alarms.create('pontis-sync', { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'pontis-sync') void runSync('alarm');
  });
  chrome.runtime.onStartup.addListener(() => void runSync('startup'));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (isMessage(msg, 'pontis/manual-sync')) {
      void runSync('manual').then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err) }),
      );
      return true; // async response
    }
    if (isMessage(msg, 'pontis/initial-decision')) {
      const { bindingId, decision } = msg as { bindingId: string; decision: ReconDecision };
      void engine
        .resume(bindingId, decision)
        .then((session) => sendResponse({ ok: true, state: session.state, error: session.error }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (isMessage(msg, 'pontis/remount')) {
      const { bindingId, folderBrowserId } = msg as { bindingId: string; folderBrowserId: string };
      void engine
        .remount(bindingId, folderBrowserId)
        .then((session) => sendResponse({ ok: true, state: session.state, error: session.error }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    return undefined;
  });

  // --- event capture: never pauses (doc 05 §13) ---

  // Serialize event handling so per-binding transactions stay ordered.
  let eventChain: Promise<void> = Promise.resolve();

  const dispatch = (event: BrowserEvent): void => {
    eventChain = eventChain
      .then(async () => {
        // 'initializing' keeps processing so reconciliation-time user
        // intent is captured (doc 05 §13).
        const bindings = await db.bindings.where('state').anyOf(['active', 'initializing']).toArray();
        let producedLocalOp = false;
        for (const b of bindings) {
          const disposition = await new EventProcessor(db, adapter).handleEvent(b.id, event);
          if (disposition === 'local-op') producedLocalOp = true;
        }
        if (producedLocalOp) scheduleSync();
      })
      .catch(async (err) => {
        await logDiagnostic(db, 'error', 'background', 'event dispatch failed', { error: String(err), event });
      });
  };

  adapter.onCreated((node) => dispatch({ kind: 'created', node }));
  adapter.onChanged((node) => dispatch({ kind: 'changed', node }));
  adapter.onMoved((node, oldParentId) => dispatch({ kind: 'moved', node, oldParentId }));
  adapter.onRemoved((node) => dispatch({ kind: 'removed', node }));

  // Sync on worker wake (covers popup-open, event wake, update).
  void runSync('wake');
});

function isMessage(msg: unknown, type: string): boolean {
  return typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === type;
}

// The options page's replica state and the actions that change it.
//
// Everything the 同步管理 tab shows, plus the read loop that keeps it live: the
// worker writes bindings, sessions and diagnostics into IndexedDB asynchronously,
// so the page polls rather than being told. `run` lives here too because every
// action needs both its spin state and the refresh that follows it, and the
// account tab's pairing actions use the same runner.

import { useCallback, useEffect, useState } from 'react';
import { runtime } from './optionsRuntime';
import { isUnsettledOp, type BindingRecord, type DiagnosticEvent, type PendingOpRecord, type ReconSessionRecord } from '../core/store/db';
import type { IntentDecision } from '../core/sync/resync';
import { countScopeBookmarks } from '../core/browser/scopeCount';
import { mountFolderTree } from './mountFolders';
import { errText } from './runtime';
import type { FolderTreeNode } from './folderTree';
import type { SpaceOption } from './BindForm';
import { metadataForBuild, offerUpdate, platformForBuild, variantForBuild, type UpdateOffer } from '../core/update/release';

/** Which actions spin their own control; the key is the control's identity. */
export type RunAction = (key: string, fn: () => Promise<void>, then?: () => void) => Promise<void>;

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

export function useSyncState() {
  const { chrome, db, bootstrap, adapter, pairing, client } = runtime;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<SpaceOption[]>([]);
  const [folders, setFolders] = useState<FolderTreeNode[]>([]);
  const [addBinding, setAddBinding] = useState(false);
  const [bindings, setBindings] = useState<BindingRecord[]>([]);
  const [sessions, setSessions] = useState<ReconSessionRecord[]>([]);
  const [remountFolders, setRemountFolders] = useState<Record<string, string>>({});
  /** Binding the user has asked to unbind and is now confirming, in place. */
  const [confirmUnbind, setConfirmUnbind] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([]);
  const [intents, setIntents] = useState<PendingOpRecord[]>([]);
  const [intentChoices, setIntentChoices] = useState<Record<string, IntentDecision['decision']>>({});
  /** Issue id → the candidate the user picked; unset keeps the server default. */
  const [issueChoices, setIssueChoices] = useState<Record<string, string>>({});
  /** bindingId → bookmarks this browser really holds in the mounted scope. */
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  /** Who this browser is, read from the same bootstrap row on every tick: the
   *  page can be opened while pairing finishes in another tab. */
  const [paired, setPaired] = useState(false);
  const [serverHost, setServerHost] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [updateSource, setUpdateSource] = useState<{ serverUrl: string; deviceToken: string } | null>(null);
  const [update, setUpdate] = useState<UpdateOffer | null>(null);
  const [installUrl, setInstallUrl] = useState('');

  const refresh = useCallback(async () => {
    // Identity is read first, on purpose. It is the cheapest and most certain
    // of these reads, and the whole page's copy hangs on it: queued behind the
    // bookmark walk, a slow or stalled tree left a paired device being told 这台
    // 浏览器还没有配对.
    const b = await bootstrap.get();
    setPaired(Boolean(b.serverUrl && b.deviceToken));
    setDeviceLabel(b.deviceName ?? '');
    setServerHost(b.serverUrl ? hostOf(b.serverUrl) : '');
    // Stable while polling, but changes when the user pairs, switches servers,
    // replaces credentials or unpairs. A request for the previous identity must
    // never leave its update/install link on the new account.
    setUpdateSource((previous) => {
      if (!b.serverUrl || !b.deviceToken) return null;
      return previous?.serverUrl === b.serverUrl && previous.deviceToken === b.deviceToken
        ? previous : { serverUrl: b.serverUrl, deviceToken: b.deviceToken };
    });
    setBindings(await db.bindings.toArray());
    setSessions(await db.reconSessions.toArray());
    setIntents((await db.pendingOps.filter((o) => isUnsettledOp(o)).toArray()));
    setDiagnostics((await db.diagnostics.orderBy('id').reverse().limit(30).toArray()).reverse());
    setFolders(await mountFolderTree(adapter));
    if (b.deviceToken) {
      try {
        setSpaces(await pairing.listSpaces());
      } catch {
        setSpaces([]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    setUpdate(null);
    setInstallUrl(updateSource ? `${updateSource.serverUrl.replace(/\/+$/, '')}/devices#install-extension` : '');
    if (updateSource) {
      void (async () => {
        try {
          const release = await client.deviceExtensions();
          const offer = offerUpdate(release, {
            platform: platformForBuild(), variant: variantForBuild(),
            version: chrome.runtime.getManifest().version,
            release: metadataForBuild().release,
          });
          if (!cancelled) setUpdate(offer);
        } catch {
          // Offline/legacy instances simply have no update information.
          if (!cancelled) setUpdate(null);
        }
      })();
    }
    return () => { cancelled = true; };
  }, [updateSource]);

  const refreshCounts = useCallback(async () => {
    const rows = await db.bindings.toArray();
    const next: Record<string, number | null> = {};
    await Promise.all(
      rows.map(async (b) => {
        next[b.id] = await countScopeBookmarks(adapter, b.mount);
      }),
    );
    setCounts(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    void refreshCounts();
    // Reconciliation progress and decisions update asynchronously.
    const id = setInterval(() => void refresh(), 2000);
    // Counting walks the browser tree, so it runs on its own, slower clock.
    const countId = setInterval(() => void refreshCounts(), 10_000);
    return () => {
      clearInterval(id);
      clearInterval(countId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Run one action: spin only that control, and surface its failure. */
  const run: RunAction = async (key, fn, then) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      then?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const doBind = (spaceId: string, folderId: string, spaceName: string) =>
    void run('bind', async () => {
      await pairing.bindSpace(spaceId, spaceName, folderId);
      setAddBinding(false);
    });

  const doUnbind = (bindingId: string) => run(`unbind:${bindingId}`, () => pairing.unbind(bindingId));

  /**
   * The user's switch. Off stops every round of sync for this binding; local
   * edits keep being captured, so switching back on drains what accumulated —
   * the same path an offline device takes when it reconnects.
   */
  const toggleSync = (bindingId: string, enabled: boolean) =>
    run(`toggle:${bindingId}`, async () => {
      const row = await db.bindings.get(bindingId);
      if (!row) return;
      await db.bindings.put({ ...row, enabled });
      if (enabled) await chrome.runtime.sendMessage({ type: 'pontis/manual-sync' });
    });

  /**
   * Answer the server plan's open questions (doc 08 §11). An issue left out of
   * the map keeps the server's safe default, so the user may answer only the
   * ones they care about.
   */
  const answerIssues = (bindingId: string, issues: { id: string }[]) => {
    const decisions: Record<string, string> = {};
    for (const issue of issues) {
      const chosen = issueChoices[issue.id];
      if (chosen) decisions[issue.id] = chosen;
    }
    return run(`answer:${bindingId}`, async () => {
      const resp = (await chrome.runtime.sendMessage({
        type: 'pontis/initial-reconcile-answer',
        bindingId,
        decisions,
      })) as { ok: boolean; error?: string } | undefined;
      if (resp && !resp.ok) setError(resp.error ?? '提交选择失败');
    });
  };

  /** Doc 06 §11 default policy: destructive delete defaults to discard. */
  const defaultIntentDecision = (op: PendingOpRecord): IntentDecision['decision'] =>
    op.type === 'delete' ? 'discard' : 'apply';

  const setIntentChoice = (opId: string, decision: IntentDecision['decision']) =>
    setIntentChoices((prev) => ({ ...prev, [opId]: decision }));

  const resolveIntents = (bindingId: string) => {
    const list = intents.filter((o) => o.bindingId === bindingId);
    const decisions: IntentDecision[] = list.map((o) => ({
      opId: o.opId,
      decision: intentChoices[o.opId] ?? defaultIntentDecision(o),
    }));
    return run(`intents:${bindingId}`, async () => {
      const resp = (await chrome.runtime.sendMessage({ type: 'pontis/resolve-intents', bindingId, decisions })) as
        | { ok: boolean; error?: string }
        | undefined;
      if (resp && !resp.ok) setError(resp.error ?? '决策执行失败');
    });
  };

  const doIntegrityCheck = (bindingId: string) =>
    run(`integrity:${bindingId}`, async () => {
      const resp = (await chrome.runtime.sendMessage({ type: 'pontis/integrity-check', bindingId })) as
        | { ok: boolean; result?: string; error?: string }
        | undefined;
      if (resp && !resp.ok) setError(resp.error ?? '完整性检查失败');
    });

  const doRemount = (bindingId: string) => {
    const folder = remountFolders[bindingId];
    if (!folder) return Promise.resolve();
    return run(`remount:${bindingId}`, async () => {
      const resp = (await chrome.runtime.sendMessage({ type: 'pontis/remount', bindingId, folderBrowserId: folder })) as
        | { ok: boolean; error?: string }
        | undefined;
      if (resp && !resp.ok) setError(resp.error ?? '重新挂载失败');
    });
  };

  /** Bindings whose state asks something of the reader. */
  const attention = bindings.filter((b) => ['waiting_user', 'mount_missing', 'needs_recovery'].includes(b.state));

  return {
    busy,
    error,
    setError,
    run,
    refresh,
    paired,
    serverHost,
    deviceLabel,
    update,
    installUrl,
    spaces,
    folders,
    addBinding,
    setAddBinding,
    bindings,
    sessions,
    attention,
    remountFolders,
    setRemountFolders,
    confirmUnbind,
    setConfirmUnbind,
    diagnostics,
    intents,
    intentChoices,
    setIntentChoice,
    setIntentChoices,
    defaultIntentDecision,
    issueChoices,
    setIssueChoices,
    counts,
    doBind,
    doUnbind,
    toggleSync,
    answerIssues,
    resolveIntents,
    doIntegrityCheck,
    doRemount,
  };
}

export type SyncState = ReturnType<typeof useSyncState>;

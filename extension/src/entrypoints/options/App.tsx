// Settings: three tabs — 账号管理 (this device's pairing), 同步管理 (bindings)
// and 本地日志 (diagnostics written by the worker).
//
// Deliberately not a wizard. The numbered steps live in onboarding.html, which
// a first-time user lands on; by the time someone reaches this page the pairing
// is done, so it reads as an admin panel: state first, actions next to the
// thing they act on, and a repair path only where one exists. The one thing
// this page still has to offer cold is the unpaired account tab, because
// re-pairing after a server move is an edit here, not a trip back to the guide.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  List,
  Modal,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { countScopeBookmarks } from '../../core/browser/scopeCount';
import type { ReconciliationIssueWire } from '../../core/protocol/types';
import {
  isSyncEnabled,
  isUnsettledOp,
  PontisDB,
  type BindingRecord,
  type DiagnosticEvent,
  type PendingOpRecord,
  type ReconSessionRecord,
} from '../../core/store/db';
import type { IntentDecision } from '../../core/sync/resync';
import { originPatternFor } from '../../core/pairing/pairing';
import { BindForm, type SpaceOption } from '../../ui/BindForm';
import { listMountFolders, type FolderOption } from '../../ui/mountFolders';
import { PairingForm } from '../../ui/PairingForm';
import { createRuntime, errText, wakeWorker } from '../../ui/runtime';
import { StartPageSettings } from '../../ui/StartPageSettings';
import { bindingStatus, relTime, sortBindings } from '../../ui/bindingStatus';
import { PontisLogo } from '../../ui/PontisLogo';
import { chromeApi } from '../../runtime/chromeApi';

// Built once for the page: a Dexie handle, an ApiClient and a PairingService
// per render would be rebuilt on every tab switch. A binding written here is
// activated by the worker, so ask it for a round instead of waiting on an alarm.
const runtime = createRuntime(() => wakeWorker(chromeApi()));

type Tab = 'account' | 'sync' | 'start-page' | 'log';

/**
 * Where the page opens. The guide and the popup each mean a particular tab when
 * they send someone here, so making them click out of 账号管理 to get there
 * undoes the link.
 */
function initialTab(): Tab {
  const h = window.location.hash.slice(1);
  if (h === 'sync' || h === 'log' || h === 'start-page') return h;
  return 'account';
}

export function App() {
  const { chrome, db, bootstrap, adapter, pairing } = runtime;

  const [tab, setTab] = useState<Tab>(initialTab);

  /** Switch tab and put it in the address.
   *
   * The hash is read on load so the guide and the popup can send someone to a
   * particular tab; without writing it back, the URL kept lying about where
   * the reader was, and a reload dropped them on 账号管理. replaceState rather
   * than location.hash so the back button does not walk through tabs the
   * reader already left. */
  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
  }, []);
  const [unpairOpen, setUnpairOpen] = useState(false);
  const [paired, setPaired] = useState(false);
  const [serverHost, setServerHost] = useState('');
  /** The registered device name, read back from storage for the header. */
  const [deviceLabel, setDeviceLabel] = useState('');
  /** Which action is running: only its own button spins. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** bindingId → bookmarks this browser really holds in the mounted scope. */
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  /** Pairing collapses into the header once it is done; the form is for setup. */
  const [editPairing, setEditPairing] = useState(false);

  const [spaces, setSpaces] = useState<SpaceOption[]>([]);
  const [folders, setFolders] = useState<FolderOption[]>([]);
  /** The 绑定新空间 disclosure inside 同步管理. */
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

  const refresh = useCallback(async () => {
    const rows = await db.bindings.toArray();
    setBindings(rows);
    setFolders(await listMountFolders(adapter));
    setSessions(await db.reconSessions.toArray());
    setIntents((await db.pendingOps.filter((o) => isUnsettledOp(o)).toArray()));
    setDiagnostics((await db.diagnostics.orderBy('id').reverse().limit(30).toArray()).reverse());
    const b = await bootstrap.get();
    setPaired(Boolean(b.serverUrl && b.deviceToken));
    setDeviceLabel(b.deviceName ?? '');
    if (b.serverUrl) setServerHost(hostOf(b.serverUrl));
    if (b.deviceToken) {
      try {
        setSpaces(await pairing.listSpaces());
      } catch {
        setSpaces([]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  async function run(key: string, fn: () => Promise<void>, then?: () => void) {
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
  }

  const doPair = (params: {
    serverUrl: string;
    username: string;
    password: string;
    deviceName: string;
  }) =>
    void run(
      'pair',
      async () => {
        // Granted inside the click gesture, before any other await: the server
        // sends no CORS headers on purpose, so without this origin permission
        // the first pairing fetch is a blocked cross-origin request.
        const origin = originPatternFor(params.serverUrl);
        const granted = await new Promise<boolean>((resolve) => {
          chrome.permissions.request({ origins: [origin] }, resolve);
        });
        if (!granted) throw new Error(`需要允许扩展访问 ${origin}`);
        await pairing.pair({
          serverUrl: params.serverUrl,
          username: params.username,
          password: params.password,
          deviceName: params.deviceName || '浏览器插件',
          browser: 'chromium',
          platform: navigator.platform,
        });
        setPaired(true);
      },
      () => setEditPairing(false),
    );

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

  const doUnpair = async () => {
    await bootstrap.clearPairing();
    setEditPairing(true);
    await refresh();
  };

  /**
   * Answer the server plan's open questions (doc 08 §11). An issue left out of
   * the map keeps the server's safe default, so the user may answer only the
   * ones they care about.
   */
  const answerIssues = (bindingId: string, issues: ReconciliationIssueWire[]) => {
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
    (op.type === 'delete' ? 'discard' : 'apply');
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

  // Only states the user can act on count as waiting for them; pending_initial
  // and initializing resolve on their own in the next lifecycle round.
  const attention = bindings.filter((b) =>
    ['waiting_user', 'mount_missing', 'needs_recovery'].includes(b.state),
  );
  const showPairForm = !paired || editPairing;

  const unbindTarget = bindings.find((b) => b.id === confirmUnbind);
  const unbindPending = unbindTarget
    ? Math.max(0, unbindTarget.receivedRevision - unbindTarget.appliedRevision)
    : 0;

  return (
    <div className="pontis-page">
      <header className="pontis-pageHead">
        <Group gap="xs" wrap="nowrap">
          <PontisLogo size={22} alt="Pontis" />
          <Text className="pontis-pageTitle">Pontis</Text>
          <Text size="md" fw={600}>
            设置
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          {paired ? `${serverHost}${deviceLabel ? ` · ${deviceLabel}` : ''}` : '尚未配对'}
        </Text>
      </header>

      <div className="pontis-pagePad">
        {error && (
          <Alert color="errorRed" title="操作失败" withCloseButton onClose={() => setError(null)} mb="md">
            {error}
          </Alert>
        )}
        {!paired && (
          <Alert color="accentBlue" title="这台浏览器还没有配对" mb="md">
            <Stack gap="xs">
              <Text size="sm">
                登录后注册本设备，再选择要同步的空间和书签目录。
              </Text>
              <Group gap="xs" wrap="nowrap">
                <Button
                  size="xs"
                  component="a"
                  href={chrome.runtime.getURL('onboarding.html')}
                  target="_blank"
                >
                  打开初始设置
                </Button>
                <Text size="xs" c="dimmed">
                  或者直接在「账号管理」里登录
                </Text>
              </Group>
            </Stack>
          </Alert>
        )}

        <Tabs value={tab} onChange={(v) => selectTab((v as typeof tab) ?? 'account')}>
          <Tabs.List mb="md">
            <Tabs.Tab value="account">
              账号管理
            </Tabs.Tab>
            <Tabs.Tab
              value="sync"
              rightSection={
                attention.length > 0 ? (
                  <Badge size="xs" color="warningAmber" variant="filled" circle>
                    {attention.length}
                  </Badge>
                ) : undefined
              }
            >
              同步管理
            </Tabs.Tab>
            <Tabs.Tab value="start-page">起始页</Tabs.Tab>
            <Tabs.Tab value="log">本地日志</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="account">
            <Section
              title="这台浏览器"
              hint="服务器上的设备身份。撤销它会让所有绑定失效，书签本身不受影响。"
              right={
                paired ? (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="coolGray"
                    onClick={() => setEditPairing((v) => !v)}
                  >
                    {editPairing ? '收起' : '修改配对'}
                  </Button>
                ) : undefined
              }
            >
              <Box className="pontis-listBox" p="md">
                {paired && !editPairing ? (
                  <Stack gap={8}>
                    <MetaRow label="服务器">
                      <Text size="sm" className="pontis-mono">
                        {serverHost}
                      </Text>
                    </MetaRow>
                    <MetaRow label="设备名称">
                      <Text size="sm">{deviceLabel || '当前设备'}</Text>
                    </MetaRow>
                    <MetaRow label="状态">
                      <Group gap="xs" wrap="nowrap">
                        <Badge color="healthyGreen" variant="light">
                          已配对
                        </Badge>
                        <Text size="xs" c="dimmed">
                          {`${bindings.length} 个空间绑定在这台设备上`}
                        </Text>
                      </Group>
                    </MetaRow>
                    <Group gap="xs" mt="xs">
                      <Button size="xs" variant="subtle" color="errorRed" onClick={() => setUnpairOpen(true)}>
                        解除配对
                      </Button>
                      <Text size="xs" c="dimmed">
                        会撤销本机所有绑定并清空本地副本
                      </Text>
                    </Group>
                  </Stack>
                ) : (
                  <Stack gap="sm">
                    <PairingForm
                      initialServerUrl={serverHost ? `http://${serverHost}` : ''}
                      busy={busy === 'pair'}
                      submitLabel={paired ? '重新登录并注册' : '登录并注册设备'}
                      onPair={doPair}
                    />
                    {paired && (
                      <Text size="xs" c="dimmed">
                        重新配对会换掉本设备的凭据，已有的绑定需要重新建立。
                      </Text>
                    )}
                  </Stack>
                )}
              </Box>
            </Section>
          </Tabs.Panel>

          <Tabs.Panel value="sync">
            {/* No Stack gap: .pontis-section + .pontis-section already puts 24px
                between sections, and both together read as a broken column. */}
            <Box>
              <Section
                title="绑定列表"
                right={
                  <Group gap="sm" wrap="nowrap">
                    <Text size="xs" c="dimmed">
                      {`${bindings.length} 个绑定`}
                    </Text>
                    <Button
                      size="compact-xs"
                      variant="light"
                      disabled={!paired}
                      onClick={() => setAddBinding((v) => !v)}
                    >
                      {addBinding ? '收起' : '绑定新空间'}
                    </Button>
                  </Group>
                }
              >
                {addBinding && (
                  <Box className="pontis-listBox" p="md" mb="sm">
                    <BindForm
                      spaces={spaces}
                      folders={folders}
                      boundSpaceIds={bindings.map((b) => b.spaceId)}
                      busy={busy === 'bind'}
                      onBind={doBind}
                    />
                  </Box>
                )}
                {bindings.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    暂无绑定。
                  </Text>
                ) : (
                  <Box className="pontis-listBox">
                    {sortBindings(bindings).map((b) => {
                      const st = bindingStatus(b);
                      return (
                        <Box key={b.id} className="pontis-block">
                          <Group justify="space-between" wrap="wrap">
                            <Group gap="xs" wrap="nowrap">
                              <Text fw={600} truncate maw={280}>
                                {b.spaceName}
                              </Text>
                              <Badge color={st.color} variant="light">
                                {st.label}
                              </Badge>
                              {b.recovery && (
                                <Tooltip label={b.recovery.message}>
                                  <Badge color="errorRed" variant="outline">
                                    {b.recovery.code}
                                  </Badge>
                                </Tooltip>
                              )}
                            </Group>
                            <Group gap="xs" wrap="nowrap">
                              <Group gap={6} wrap="nowrap">
                                <Text size="xs" c="dimmed">
                                  同步
                                </Text>
                                <Switch
                                  size="xs"
                                  checked={isSyncEnabled(b)}
                                  disabled={busy === `toggle:${b.id}`}
                                  aria-label={`${b.spaceName} 的同步开关`}
                                  title={isSyncEnabled(b) ? '暂停这个空间的同步' : '恢复这个空间的同步'}
                                  onChange={(e) => void toggleSync(b.id, e.currentTarget.checked)}
                                />
                              </Group>
                              <Text size="xs" c="dimmed">
                                {relTime(b.lastSyncAt)}
                              </Text>
                              <Button
                                size="compact-xs"
                                variant="light"
                                disabled={b.state !== 'active'}
                                loading={busy === `integrity:${b.id}`}
                                onClick={() => void doIntegrityCheck(b.id)}
                              >
                                完整性检查
                              </Button>
                              <Button
                                size="compact-xs"
                                variant="subtle"
                                color="errorRed"
                                onClick={() => setConfirmUnbind(b.id)}
                              >
                                解绑
                              </Button>
                            </Group>
                          </Group>
                          <Group gap="md" wrap="nowrap">
                            <Text size="xs" c="dimmed" className="pontis-numerals">
                              {counts[b.id] === null || counts[b.id] === undefined
                                ? '读不到这个目录'
                                : `${counts[b.id]} 个书签`}
                            </Text>
                            {!st.disabled && st.pending > 0 && (
                              <Text size="xs" c="recoveryOrange">
                                还有 {st.pending} 项远端改动没落到浏览器
                              </Text>
                            )}
                            {st.disabled && (
                              <Text size="xs" c="dimmed">
                                同步已关闭，本机的改动会攒着
                              </Text>
                            )}
                          </Group>
                        </Box>
                      );
                    })}
                  </Box>
                )}
              </Section>
              <Section
                title="初始化与恢复"
                right={
                  attention.length > 0 ? (
                    <Badge color="warningAmber" variant="filled">
                      {`${attention.length} 个绑定待处理`}
                    </Badge>
                  ) : undefined
                }
              >
                {(() => {
                  const active = bindings.filter((b) =>
                    ['initializing', 'resyncing', 'waiting_user', 'mount_missing'].includes(b.state),
                  );
                  if (active.length === 0) {
                    return (
                      <Text size="sm" c="dimmed">
                        所有绑定状态正常。
                      </Text>
                    );
                  }
                  const rows = active.map((b) => {
                    const session = sessions.find(
                      (s) => s.bindingId === b.id && (s.state === 'RUNNING' || s.state === 'WAITING_USER'),
                    );
                    const st = bindingStatus(b);
                    return (
                      <Box key={b.id} className="pontis-block">
                        <Stack gap="sm">
                          <Group justify="space-between" wrap="nowrap">
                            <Title
                              order={3}
                              size="md"
                              fw={600}
                              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            >
                              {b.spaceName}
                            </Title>
                            <Badge color={st.color} variant="light" style={{ flex: '0 0 auto' }}>
                              {st.label}
                            </Badge>
                          </Group>

                          {session && (
                            <Text size="xs" c="dimmed">
                              阶段 <Code>{session.serverPhase ?? session.phase}</Code>
                              {session.serverSessionId ? ` · 服务端会话 ${session.serverSessionId.slice(0, 8)}` : ''}
                              {session.error ? ` · ${session.error}` : ''}
                            </Text>
                          )}

                          {session?.state === 'WAITING_USER' && session.type === 'FULL_RESYNC' && (
                            <ResyncIntents
                              intents={intents.filter((o) => o.bindingId === b.id)}
                              chosen={(op) => intentChoices[op.opId] ?? defaultIntentDecision(op)}
                              onChoose={setIntentChoice}
                              onAll={(decision) =>
                                setIntentChoices((prev) => {
                                  const next = { ...prev };
                                  for (const op of intents.filter((o) => o.bindingId === b.id)) {
                                    next[op.opId] = decision === 'default' ? defaultIntentDecision(op) : decision;
                                  }
                                  return next;
                                })
                              }
                              onSubmit={() => void resolveIntents(b.id)}
                              busy={busy === `intents:${b.id}`}
                            />
                          )}

                          {session?.state === 'WAITING_USER' && (session.issues?.length ?? 0) > 0 && (
                            <Stack gap="xs">
                              <Text size="sm" fw={600}>
                                服务端在提交合并前有几处身份要你确认：
                              </Text>
                              {session.issues!.map((issue) => (
                                <Group key={issue.id} gap="xs" wrap="wrap" justify="space-between">
                                  <Stack gap={0} style={{ flex: '1 1 220px' }}>
                                    <Text size="sm" truncate maw={280}>
                                      {issue.payload.title || issue.payload.source_ref}
                                    </Text>
                                    {issue.payload.url && (
                                      <Text size="xs" c="dimmed" truncate maw={280}>
                                        {issue.payload.url}
                                      </Text>
                                    )}
                                  </Stack>
                                  <Select
                                    size="xs"
                                    maw={260}
                                    style={{ flex: '1 1 180px' }}
                                    placeholder="沿用服务端默认"
                                    data={issue.payload.candidates.map((c) => ({ value: c, label: c }))}
                                    value={issueChoices[issue.id] || null}
                                    onChange={(v) => setIssueChoices((prev) => ({ ...prev, [issue.id]: v ?? '' }))}
                                    searchable
                                  />
                                </Group>
                              ))}
                              <Divider />
                              <Group justify="space-between" wrap="nowrap">
                                <Text size="xs" c="dimmed">
                                  未做选择的条目按服务端安全默认处理(doc 08 §11)。
                                </Text>
                                <Button
                                  color="accentBlue"
                                  loading={busy === `answer:${b.id}`}
                                  onClick={() => void answerIssues(b.id, session.issues!)}
                                >
                                  提交选择
                                </Button>
                              </Group>
                            </Stack>
                          )}

                          {session?.state === 'WAITING_USER' &&
                            session.type !== 'FULL_RESYNC' &&
                            (session.issues?.length ?? 0) === 0 && (
                              <Text size="sm" c="dimmed">
                                服务端正在等待这台设备完成上一次选择。
                              </Text>
                            )}

                          {b.state === 'mount_missing' && (
                            <Group grow wrap="nowrap">
                              <Select
                                placeholder="重新选择挂载目录"
                                data={folders}
                                searchable
                                value={remountFolders[b.id] ?? null}
                                onChange={(v) => setRemountFolders((prev) => ({ ...prev, [b.id]: v ?? '' }))}
                              />
                              <Button
                                loading={busy === `remount:${b.id}`}
                                disabled={!remountFolders[b.id]}
                                onClick={() => void doRemount(b.id)}
                              >
                                重新挂载并重建映射
                              </Button>
                            </Group>
                          )}
                        </Stack>
                      </Box>
                    );
                  });
                  // Boxed like 绑定列表: these are rows that need an answer, and
                  // loose ones read as a broken section.
                  return <Box className="pontis-listBox">{rows}</Box>;
                })()}
              </Section>
            </Box>
          </Tabs.Panel>

          <Tabs.Panel value="start-page">
            <Section
              title="起始页来源"
              hint="起始页是这套书签的快速访问视图，不是另一套收藏：它读取工作台中已有的内容，不创建第二棵树，也不改变同步范围。"
            >
              <StartPageSettings onChanged={refresh} />
            </Section>
          </Tabs.Panel>

          <Tabs.Panel value="log">
            <Section
              title="诊断事件（本地）"
              right={
                diagnostics.some((d) => d.level === 'error') ? (
                  <Badge color="errorRed" variant="light">
                    有错误记录
                  </Badge>
                ) : undefined
              }
            >
              {diagnostics.length === 0 ? (
                <Text size="sm" c="dimmed">
                  暂无记录。
                </Text>
              ) : (
                <Box mah={280} style={{ overflowY: 'auto' }} className="pontis-stick">
                  <Table verticalSpacing="xs" highlightOnHover withTableBorder={false}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th w={72}>时间</Table.Th>
                        <Table.Th w={72}>级别</Table.Th>
                        <Table.Th w={120}>范围</Table.Th>
                        <Table.Th>消息</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {diagnostics.map((d) => (
                        <Table.Tr key={d.id}>
                          <Table.Td>
                            <Text size="xs" className="pontis-numerals" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                              {new Date(d.ts).toLocaleTimeString('zh-CN', { hour12: false })}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge
                              size="xs"
                              variant="light"
                              color={d.level === 'error' ? 'errorRed' : d.level === 'warn' ? 'warningAmber' : 'coolGray'}
                            >
                              {d.level}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed">
                              {d.scope}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Tooltip label={JSON.stringify(d.data ?? {})} maw={420} withArrow>
                              {/* Focusable so the payload is reachable without a mouse
                                  (docs/23 §34: keyboard paths and visible focus). */}
                              <Text size="xs" truncate tabIndex={0}>
                                {d.message}
                              </Text>
                            </Tooltip>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Box>
              )}
            </Section>
          </Tabs.Panel>
        </Tabs>
      </div>

      <Modal
        opened={!!unbindTarget}
        onClose={() => setConfirmUnbind(null)}
        title={`解绑「${unbindTarget?.spaceName ?? ''}」`}
      >
        <Stack gap="md">
          <Text size="sm">
            {unbindPending > 0
              ? `${unbindPending} 项还没同步的改动会被丢弃；`
              : ''}
            这台浏览器上的副本会被清空，服务器上的空间和其他设备都不受影响，书签也不会被删。
          </Text>
          <Group justify="flex-end" mt="lg">
            <Button variant="subtle" color="coolGray" onClick={() => setConfirmUnbind(null)}>
              取消
            </Button>
            <Button
              color="errorRed"
              loading={busy === `unbind:${unbindTarget?.id ?? ''}`}
              onClick={() =>
                unbindTarget && void doUnbind(unbindTarget.id).then(() => setConfirmUnbind(null))
              }
            >
              确认解绑
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={unpairOpen} onClose={() => setUnpairOpen(false)} title="解除配对">
        <Stack gap="md">
          <Text size="sm">
            这台设备会向服务器撤销自己的凭据，{bindings.length} 个绑定的本地副本一并清空。
            服务器上的空间和书签不变，重新登录即可再绑。
          </Text>
          <Group justify="flex-end" mt="lg">
            <Button variant="subtle" color="coolGray" onClick={() => setUnpairOpen(false)}>
              取消
            </Button>
            <Button
              color="errorRed"
              onClick={() => {
                setUnpairOpen(false);
                void doUnpair();
              }}
            >
              确认解除
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

/** A page section in the admin app's shape: a 13/600 title, a 12px hint under
 *  it, actions on the right. Only list bodies get boxed. */
function Section({
  title,
  hint,
  right,
  children,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pontis-section">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb={hint ? 4 : 'sm'}>
        <div>
          <div className="pontis-sectionTitle">{title}</div>
          {hint && <div className="pontis-sectionHint">{hint}</div>}
        </div>
        {right}
      </Group>
      {children}
    </section>
  );
}

function ResyncIntents({
  intents,
  chosen,
  onChoose,
  onAll,
  onSubmit,
  busy,
}: {
  intents: PendingOpRecord[];
  chosen: (op: PendingOpRecord) => IntentDecision['decision'];
  onChoose: (opId: string, decision: IntentDecision['decision']) => void;
  onAll: (decision: 'default' | 'discard') => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        以下未同步的操作跨过了服务端重置,请逐条决定是否保留(旧操作将按当前服务器状态重新生成):
      </Text>
      {intents.length === 0 ? (
        <Text size="xs" c="dimmed">
          无待审操作,可直接重新同步。
        </Text>
      ) : (
        <List withPadding size="sm" spacing={4}>
          {intents.map((op) => (
            <List.Item key={op.opId}>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <Badge
                    size="xs"
                    variant="light"
                    color={op.type === 'delete' ? 'errorRed' : 'accentBlue'}
                  >
                    {op.type}
                  </Badge>
                  <Text size="sm" truncate maw={320}>
                    {op.title || '(无标题)'}
                    {op.url ? ` · ${op.url}` : ''}
                  </Text>
                </Group>
                <Button.Group>
                  <Button
                    size="compact-xs"
                    variant={chosen(op) === 'apply' ? 'filled' : 'light'}
                    onClick={() => onChoose(op.opId, 'apply')}
                  >
                    保留
                  </Button>
                  <Button
                    size="compact-xs"
                    color="gray"
                    variant={chosen(op) === 'discard' ? 'filled' : 'light'}
                    onClick={() => onChoose(op.opId, 'discard')}
                  >
                    放弃
                  </Button>
                </Button.Group>
              </Group>
            </List.Item>
          ))}
        </List>
      )}
      <Group gap="xs" wrap="nowrap">
        <Button size="xs" variant="light" disabled={intents.length === 0} onClick={() => onAll('default')}>
          全部按建议
        </Button>
        <Button size="xs" variant="subtle" color="gray" disabled={intents.length === 0} onClick={() => onAll('discard')}>
          全部放弃
        </Button>
        <Button color="accentBlue" loading={busy} onClick={onSubmit}>
          提交决策
        </Button>
      </Group>
    </Stack>
  );
}

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

/** A labelled line in the account summary. */
function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap="md" wrap="nowrap" align="center">
      <Text size="xs" c="dimmed" w={72} flex="0 0 auto">
        {label}
      </Text>
      {children}
    </Group>
  );
}

// Options: pairing (server → login → device registration), binding
// (partial mount folder selection) and a local diagnostics view.

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Container,
  Divider,
  Group,
  List,
  PasswordInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { createChromiumAdapter } from '../../core/browser/chromium';
import type { ReconciliationIssueWire } from '../../core/protocol/types';
import { ApiClient } from '../../core/transport/client';
import { BootstrapStore } from '../../core/store/bootstrap';
import {
  PontisDB,
  type BindingRecord,
  type DiagnosticEvent,
  type PendingOpRecord,
  type ReconDecision,
  type ReconSessionRecord,
} from '../../core/store/db';
import type { IntentDecision } from '../../core/sync/resync';
import { PairingService, originPatternFor } from '../../core/pairing/pairing';
import { chromeApi, kvArea } from '../../runtime/chromeApi';
import { bindingStatus, relTime } from '../../ui/bindingStatus';

interface FolderOption {
  value: string;
  label: string;
}

export function App() {
  const chrome = chromeApi();
  const db = new PontisDB();
  const bootstrap = new BootstrapStore(kvArea(chrome.storage.local));
  const client = new ApiClient(async () => {
    const b = await bootstrap.get();
    return { serverUrl: b.serverUrl ?? '', token: b.deviceToken };
  });
  const adapter = createChromiumAdapter(chrome.bookmarks);
  const pairing = new PairingService(client, bootstrap, db);

  const [paired, setPaired] = useState(false);
  const [serverHost, setServerHost] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState('');
  /** Which action is running: only its own button spins. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Pairing collapses into the header once it is done; the form is for setup. */
  const [editPairing, setEditPairing] = useState(false);

  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([]);
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [selectedSpace, setSelectedSpace] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);

  const [bindings, setBindings] = useState<BindingRecord[]>([]);
  const [sessions, setSessions] = useState<ReconSessionRecord[]>([]);
  const [remountFolders, setRemountFolders] = useState<Record<string, string>>({});
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([]);
  const [intents, setIntents] = useState<PendingOpRecord[]>([]);
  const [intentChoices, setIntentChoices] = useState<Record<string, IntentDecision['decision']>>({});
  /** Issue id → the candidate the user picked; unset keeps the server default. */
  const [issueChoices, setIssueChoices] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setBindings(await db.bindings.toArray());
    setSessions(await db.reconSessions.toArray());
    setIntents((await db.pendingOps.filter((o) => o.status === 'QUEUED').toArray()));
    setDiagnostics((await db.diagnostics.orderBy('id').reverse().limit(30).toArray()).reverse());
    const b = await bootstrap.get();
    setPaired(Boolean(b.serverUrl && b.deviceToken));
    if (b.serverUrl) {
      setServerUrl(b.serverUrl);
      setServerHost(hostOf(b.serverUrl));
    }
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
    void refresh();
    void loadFolders();
    // Reconciliation progress and decisions update asynchronously.
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadFolders() {
    // Flatten the browser folder tree for mount selection.
    const options: FolderOption[] = [];
    const walk = async (parentId: string, depth: number, prefix: string) => {
      const children = await adapter.getChildren(parentId);
      for (const c of children.filter((n) => n.type === 'folder')) {
        const label = `${prefix}${c.title || '(未命名)'}`;
        options.push({ value: c.id, label: `${' '.repeat(depth * 2)}${label}` });
        await walk(c.id, depth + 1, `${label} / `);
      }
    };
    await walk('0', 0, '');
    setFolders(options);
  }

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

  const doPair = () =>
    run('pair', async () => {
      // Granted inside the click gesture, before any other await: the server
      // sends no CORS headers on purpose, so without this origin permission the
      // first pairing fetch is a blocked cross-origin request.
      const origin = originPatternFor(serverUrl.trim());
      const granted = await new Promise<boolean>((resolve) => {
        chrome.permissions.request({ origins: [origin] }, resolve);
      });
      if (!granted) throw new Error(`需要允许扩展访问 ${origin}`);
      await pairing.pair({
        serverUrl: serverUrl.trim(),
        username,
        password,
        deviceName: deviceName.trim() || '浏览器插件',
        browser: 'chromium',
        platform: navigator.platform,
      });
      setPaired(true);
      setPassword('');
    }, () => setEditPairing(false));

  const doBind = () =>
    run('bind', async () => {
      if (!selectedSpace || !selectedFolder) return;
      const space = spaces.find((s) => s.id === selectedSpace);
      await pairing.bindSpace(selectedSpace, space?.name ?? selectedSpace, selectedFolder);
    });

  const doUnbind = (bindingId: string) => run(`unbind:${bindingId}`, () => pairing.unbind(bindingId));

  const doUnpair = async () => {
    await bootstrap.clearPairing();
    setEditPairing(true);
    await refresh();
  };

  const decide = (bindingId: string, decision: ReconDecision) =>
    run(`decide:${bindingId}:${decision}`, async () => {
      const resp = (await chrome.runtime.sendMessage({ type: 'pontis/initial-decision', bindingId, decision })) as
        | { ok: boolean; error?: string }
        | undefined;
      if (resp && !resp.ok) setError(resp.error ?? '决策执行失败');
    });

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

  const attention = bindings.filter((b) => b.state !== 'active' && b.state !== 'paused');
  const showPairForm = !paired || editPairing;

  return (
    <div className="pontis-page">
      <Container size={760} py="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-end" wrap="nowrap">
            <Stack gap={2}>
              <Title order={1} size={18} fw={600} lh={1.4}>
                Pontis 设置
              </Title>
              <Text size="sm" c="dimmed">
                {paired ? `已配对到 ${serverHost}` : '尚未配对：先登录服务器并注册本设备'}
              </Text>
            </Stack>
            {paired && (
              <Group gap="xs" wrap="nowrap">
                {deviceName && (
                  <Text size="xs" c="dimmed">
                    {deviceName}
                  </Text>
                )}
                <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setEditPairing((v) => !v)}>
                  {editPairing ? '收起' : '修改'}
                </Button>
              </Group>
            )}
          </Group>

          {error && (
            <Alert color="errorRed" title="操作失败" withCloseButton onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <Section
            title="1. 配对服务器"
            right={
              paired ? (
                <Badge color="healthyGreen" variant="light">
                  已配对
                </Badge>
              ) : (
                <Badge color="accentBlue" variant="light">
                  待配对
                </Badge>
              )
            }
          >
            {showPairForm ? (
              <Stack gap="sm">
                <TextInput
                  label="服务器地址"
                  description="扩展需要被允许访问该地址，浏览器会在点击后询问"
                  placeholder="http://localhost:8080"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.currentTarget.value)}
                />
                <Group grow align="flex-start">
                  <TextInput label="用户名" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
                  <PasswordInput
                    label="密码"
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void doPair()}
                  />
                </Group>
                <TextInput
                  label="设备名称"
                  placeholder="例如:工作电脑 Edge"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.currentTarget.value)}
                />
                <Group gap="xs" wrap="nowrap">
                  <Button loading={busy === 'pair'} onClick={() => void doPair()}>
                    登录并注册设备
                  </Button>
                  {paired && (
                    <Button variant="subtle" color="errorRed" onClick={() => void doUnpair()}>
                      解除配对
                    </Button>
                  )}
                </Group>
              </Stack>
            ) : (
              <Group justify="space-between" wrap="nowrap">
                <Text size="sm">
                  本机已以设备身份连接 <Code>{serverHost}</Code>
                </Text>
                <Button size="compact-xs" variant="subtle" color="errorRed" onClick={() => void doUnpair()}>
                  解除配对
                </Button>
              </Group>
            )}
          </Section>

          <Section
            title="2. 绑定同步空间(Partial Sync)"
            hint="选择一个空间,再选择浏览器中作为挂载点的书签目录。挂载目录内的书签将与该空间保持同步;目录本身不会上传。"
            right={
              !paired ? (
                <Text size="xs" c="dimmed">
                  完成第 1 步后可用
                </Text>
              ) : undefined
            }
          >
            <Group grow align="flex-start" wrap="nowrap">
              <Select
                label="同步空间"
                placeholder="选择空间"
                data={spaces.map((s) => ({ value: s.id, label: s.name }))}
                value={selectedSpace}
                onChange={setSelectedSpace}
                disabled={!paired}
              />
              <Select
                label="挂载目录"
                placeholder="选择书签目录"
                data={folders}
                value={selectedFolder}
                onChange={setSelectedFolder}
                searchable
              />
            </Group>
            <Button
              loading={busy === 'bind'}
              disabled={!paired || !selectedSpace || !selectedFolder}
              onClick={() => void doBind()}
            >
              创建绑定
            </Button>
          </Section>

          <Section title="绑定列表" right={<Text size="xs" c="dimmed">{`${bindings.length} 个绑定`}</Text>}>
            {bindings.length === 0 ? (
              <Text size="sm" c="dimmed">
                暂无绑定。
              </Text>
            ) : (
              <Stack gap="xs">
                {bindings.map((b) => {
                  const st = bindingStatus(b);
                  return (
                    <Box key={b.id} className="pontis-block">
                      <Group justify="space-between" wrap="nowrap">
                        <Group gap="xs" wrap="nowrap">
                          <Text fw={600}>{b.spaceName}</Text>
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
                            loading={busy === `unbind:${b.id}`}
                            onClick={() => void doUnbind(b.id)}
                          >
                            解绑
                          </Button>
                        </Group>
                      </Group>
                      <Group gap="md" wrap="nowrap">
                        <Text size="xs" c="dimmed">
                          已应用 / 已收到
                        </Text>
                        <Text size="xs" className="pontis-numerals">
                          {b.appliedRevision} / {b.receivedRevision}
                        </Text>
                        {st.catchingUp && (
                          <Text size="xs" c="recoveryOrange">
                            尚有 {st.pending} 项未落地
                          </Text>
                        )}
                        <Text size="xs" c="dimmed">
                          epoch {b.epoch}
                        </Text>
                      </Group>
                    </Box>
                  );
                })}
              </Stack>
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
              return active.map((b) => {
                const session = sessions.find(
                  (s) => s.bindingId === b.id && (s.state === 'RUNNING' || s.state === 'WAITING_USER'),
                );
                const st = bindingStatus(b);
                return (
                  <Box key={b.id} className="pontis-block">
                    <Stack gap="sm">
                      <Group justify="space-between" wrap="nowrap">
                        <Title order={3} size="md" fw={600}>
                          {b.spaceName}
                        </Title>
                        <Badge color={st.color} variant="light">
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
                            服务端在提交合并前有几处身份要你确认:
                          </Text>
                          {session.issues!.map((issue) => (
                            <Group key={issue.id} gap="xs" wrap="nowrap" justify="space-between">
                              <Stack gap={0}>
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
                                w={260}
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
                          <Stack gap="xs">
                            <Text size="sm" fw={600}>
                              浏览器与服务器均有内容,请选择初始化策略:
                            </Text>
                            <Group gap="md" wrap="nowrap">
                              <Stat label="已匹配" value={session.progress.matched} />
                              <Stat label="仅本地" value={session.progress.localOnly} />
                              <Stat label="仅服务器" value={session.progress.serverOnly} />
                              <Stat label="歧义" value={session.progress.ambiguous} tone="warningAmber" />
                            </Group>
                            <Group gap="xs" wrap="nowrap">
                              <Button loading={busy === `decide:${b.id}:merge`} onClick={() => void decide(b.id, 'merge')}>
                                合并(推荐)
                              </Button>
                              <Button
                                variant="light"
                                loading={busy === `decide:${b.id}:use_server`}
                                onClick={() => void decide(b.id, 'use_server')}
                              >
                                以服务器为准
                              </Button>
                              <Button
                                variant="light"
                                loading={busy === `decide:${b.id}:use_browser`}
                                onClick={() => void decide(b.id, 'use_browser')}
                              >
                                以浏览器为准
                              </Button>
                              <Button
                                variant="subtle"
                                color="gray"
                                loading={busy === `decide:${b.id}:import`}
                                onClick={() => void decide(b.id, 'import')}
                              >
                                导入到独立文件夹
                              </Button>
                            </Group>
                          </Stack>
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
            })()}
          </Section>

          <Section
            title="诊断事件(本地)"
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
                          <Text size="xs" truncate>
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
        </Stack>
      </Container>
    </div>
  );
}

/** A setup step: title row carries status, body carries the work. */
function Section({
  title,
  hint,
  right,
  children,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card withBorder padding="md" radius="md" bg="var(--mantine-color-body)">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="center">
          <Title order={3} size="sm" fw={600} tt="uppercase" c="coolGray.6" lh={1.4}>
            {title}
          </Title>
          {right}
        </Group>
        {hint && (
          <Text size="xs" c="dimmed" maw="64ch">
            {hint}
          </Text>
        )}
        {children}
      </Stack>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={600} className="pontis-numerals" c={tone ?? 'default'}>
        {value}
      </Text>
    </Stack>
  );
}

/** Review the local edits that crossed a server reset (doc 06 §11). */
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

/** `http://127.0.0.1:8080` → `127.0.0.1:8080` for a readable identity line. */
function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

function errText(err: unknown): string {
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message;
  return code ? `${code}: ${message ?? ''}` : String(err);
}

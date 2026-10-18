// The 同步管理 tab: what this browser has bound, and the actions that change it.
//
// It takes the page's sync state as one object rather than 24 loose props — the
// tab genuinely needs all of it, and handing over the hook result whole is what
// keeps App() down to routing and layout.

import { Badge, Box, Button, Code, Divider, Group, Select, Stack, Switch, Text, Title, Tooltip } from '@mantine/core';
import { Section } from './Section';
import { ResyncIntents } from './ResyncIntents';
import { BindForm } from './BindForm';
import { FolderPickerField } from './FolderPickerField';
import { bindingStatus, relTime, sortBindings } from './bindingStatus';
import { isSyncEnabled } from '../core/store/db';
import type { SyncState } from './useSyncState';

export function SyncTab({ sync, paired }: { sync: SyncState; paired: boolean }) {
  const {
    busy, spaces, folders, addBinding, setAddBinding, bindings, sessions, attention,
    remountFolders, setRemountFolders, setConfirmUnbind, intents, intentChoices,
    setIntentChoice, setIntentChoices, defaultIntentDecision, issueChoices, setIssueChoices, counts,
    doBind, toggleSync, answerIssues, resolveIntents, doIntegrityCheck, doRemount,
  } = sync;

  return (
    <>
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
                              <Group gap="sm" wrap="nowrap">
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
                              <FolderPickerField
                                tree={folders}
                                value={remountFolders[b.id] ?? ''}
                                onChange={(id) => setRemountFolders((prev) => ({ ...prev, [b.id]: id }))}
                                placeholder="重新选择挂载目录"
                                groupName={`remount-${b.id}`}
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
    </>
  );
}

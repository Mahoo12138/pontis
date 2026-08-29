import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  NativeSelect,
  PasswordInput,
  SegmentedControl,
  Skeleton,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMantineColorScheme } from '@mantine/core';
import {
  IconCheck,
  IconCopy,
  IconDotsVertical,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ApiToken } from '@pontis/api';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import { contentRegion } from '../styles/app-shell.css';
import { pagePad, mono, sectionTitle, sectionHint } from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import { useMe } from '../hooks/use-auth';
import {
  useCreateToken,
  useRevokeToken,
  useSystemSettings,
  useTokens,
  useUpdateProfile,
  useUpdateSystemSettings,
} from '../hooks/use-settings';

const ALL_SCOPES = [
  { value: 'bookmarks:read', label: '读取书签' },
  { value: 'bookmarks:write', label: '写入书签' },
  { value: 'publications:read', label: '读取发布' },
  { value: 'publications:write', label: '写入发布' },
  { value: 'backups:read', label: '读取备份' },
  { value: 'backups:write', label: '写入备份' },
];

export default function SettingsPage() {
  return (
    <>
      <Header breadcrumb="设置" />
      <div className={`${contentRegion} ${pagePad}`} style={{ maxWidth: 860 }}>
        <Tabs defaultValue="account" styles={{ tab: { fontSize: 13 } }}>
          <Tabs.List mb="md">
            <Tabs.Tab value="account">账户</Tabs.Tab>
            <Tabs.Tab value="preferences">偏好</Tabs.Tab>
            <Tabs.Tab value="tokens">API Token</Tabs.Tab>
            <Tabs.Tab value="system">系统</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="account"><AccountPanel /></Tabs.Panel>
          <Tabs.Panel value="preferences"><PreferencesPanel /></Tabs.Panel>
          <Tabs.Panel value="tokens"><TokensPanel /></Tabs.Panel>
          <Tabs.Panel value="system"><SystemPanel /></Tabs.Panel>
        </Tabs>
      </div>
    </>
  );
}

// ─── Account ──────────────────────────────────────────────────

function AccountPanel() {
  const { data: me, isLoading } = useMe();
  const update = useUpdateProfile();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (me) {
      setDisplayName(me.display_name ?? '');
      setEmail(me.email ?? '');
    }
  }, [me]);

  if (isLoading) return <Skeleton height={200} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 480 }}>
      <section>
        <Text className={sectionTitle} mb={4}>个人资料</Text>
        <Text className={sectionHint} mb="sm">用户名创建后不可修改。</Text>
        <TextInput label="用户名" value={me?.username ?? ''} disabled mb="sm" />
        <TextInput
          label="显示名称"
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
          mb="sm"
        />
        <TextInput
          label="邮箱(可选)"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          mb="sm"
        />
        <Button
          size="xs"
          loading={update.isPending}
          onClick={() =>
            update.mutate(
              { display_name: displayName.trim(), email: email.trim() },
              { onSuccess: () => notifications.show({ message: '资料已更新', color: 'coolGray' }) },
            )
          }
        >
          保存
        </Button>
      </section>

      <section>
        <Text className={sectionTitle} mb={4}>修改密码</Text>
        <Text className={sectionHint} mb="sm">
          修改密码会使所有网页会话失效,设备与 API Token 不受影响。
        </Text>
        <PasswordForm />
      </section>
    </div>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setError(null);
    if (next.length < 8) {
      setError('新密码至少 8 位');
      return;
    }
    if (next !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setPending(true);
    try {
      const res = await fetch('/api/v1/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? '修改失败');
      }
      setCurrent('');
      setNext('');
      setConfirm('');
      notifications.show({ message: '密码已修改,其他网页会话已失效', color: 'coolGray' });
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改失败');
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ maxWidth: 360 }}>
      <PasswordInput label="当前密码" value={current} onChange={(e) => setCurrent(e.currentTarget.value)} mb="sm" />
      <PasswordInput label="新密码" value={next} onChange={(e) => setNext(e.currentTarget.value)} error={error ?? undefined} mb="sm" />
      <PasswordInput label="确认新密码" value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} mb="sm" />
      <Button size="xs" onClick={() => void submit()} loading={pending}>修改密码</Button>
    </div>
  );
}

// ─── Preferences ──────────────────────────────────────────────

function PreferencesPanel() {
  const { i18n } = useTranslation();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 480 }}>
      <section>
        <Text className={sectionTitle} mb={4}>界面语言</Text>
        <NativeSelect
          w={220}
          value={i18n.language}
          data={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en', label: 'English' },
          ]}
          onChange={(e) => void i18n.changeLanguage(e.currentTarget.value)}
        />
      </section>
      <section>
        <Text className={sectionTitle} mb={4}>外观</Text>
        <SegmentedControl
          w={220}
          value={colorScheme}
          onChange={(v) => {
            if (v !== colorScheme) toggleColorScheme();
          }}
          data={[
            { label: '浅色', value: 'light' },
            { label: '深色', value: 'dark' },
          ]}
          styles={{ root: { backgroundColor: tokens.hoverBg } }}
        />
      </section>
    </div>
  );
}

// ─── API Tokens ───────────────────────────────────────────────

function TokensPanel() {
  const { data, isLoading, isError, refetch } = useTokens();
  const revoke = useRevokeToken();
  const [createOpen, createOpenHandlers] = useDisclosure(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null);

  const tokenList = data?.tokens ?? [];

  return (
    <div>
      <Group justify="space-between" mb="sm">
        <Text className={sectionHint}>
          Token 用于外部程序访问 REST API,权限是账户权限的子集,不用于浏览器同步。
        </Text>
        <Button size="xs" leftSection={<IconPlus size={14} stroke={1.5} />} onClick={createOpenHandlers.open}>
          创建 Token
        </Button>
      </Group>

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isLoading ? (
        <Skeleton height={140} />
      ) : (
        <Table
          verticalSpacing={9}
          horizontalSpacing={12}
          withRowBorders={false}
          styles={{
            th: { fontSize: 12, fontWeight: 500, color: tokens.textSecondary },
            td: { fontSize: 13 },
          }}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>名称</Table.Th>
              <Table.Th>权限范围</Table.Th>
              <Table.Th w={130}>最近使用</Table.Th>
              <Table.Th w={110}>创建时间</Table.Th>
              <Table.Th w={60} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tokenList.map((token) => (
              <Table.Tr key={token.id}>
                <Table.Td fw={500}>{token.name}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {token.scopes.map((s) => (
                      <Badge key={s} size="sm" variant="light" color="coolGray" styles={{ root: { fontWeight: 400 } }}>
                        {s}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td c="dimmed" fz={12}>
                  {token.last_used_at ? new Date(token.last_used_at).toLocaleDateString('zh-CN') : '从未使用'}
                </Table.Td>
                <Table.Td c="dimmed" fz={12}>
                  {new Date(token.created_at).toLocaleDateString('zh-CN')}
                </Table.Td>
                <Table.Td>
                  <Menu shadow="md" width={150} position="bottom-end">
                    <Menu.Target>
                      <UnstyledButton
                        aria-label="Token 操作"
                        style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 4 }}
                      >
                        <IconDotsVertical size={16} stroke={1.5} />
                      </UnstyledButton>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        color="errorRed"
                        leftSection={<IconTrash size={14} stroke={1.5} />}
                        onClick={() => setRevokeTarget(token)}
                      >
                        撤销
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <CreateTokenModal opened={createOpen} onClose={createOpenHandlers.close} />

      <Modal
        opened={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title={`撤销「${revokeTarget?.name ?? ''}」？`}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>使用此 Token 的程序将立即失去访问权限,此操作不可恢复。</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setRevokeTarget(null)}>取消</Button>
          <Button
            color="errorRed"
            loading={revoke.isPending}
            onClick={() => {
              if (!revokeTarget) return;
              revoke.mutate(revokeTarget.id, {
                onSuccess: () => {
                  notifications.show({ message: `已撤销 ${revokeTarget.name}`, color: 'coolGray' });
                  setRevokeTarget(null);
                },
              });
            }}
          >
            撤销
          </Button>
        </Group>
      </Modal>
    </div>
  );
}

function CreateTokenModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const create = useCreateToken();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['bookmarks:read']);
  const [spaceScope, setSpaceScope] = useState<'all' | 'selected'>('all');
  const [nameError, setNameError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    if (opened) {
      setName('');
      setScopes(['bookmarks:read']);
      setSpaceScope('all');
      setNameError(null);
      setSecret(null);
    }
  }, [opened]);

  const handleCreate = () => {
    if (!name.trim()) {
      setNameError('名称不能为空');
      return;
    }
    create.mutate(
      { name: name.trim(), scopes, space_scope: 'all' },
      {
        onSuccess: (res) => setSecret(res.secret),
        onError: (e) => setNameError(e instanceof Error ? e.message : '创建失败'),
      },
    );
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={secret ? 'Token 密钥' : '创建 API Token'}
      size={460}
      styles={{ header: { fontSize: 15, fontWeight: 600 } }}
    >
      {secret ? (
        <div>
          <Text fz={13}>此密钥只显示一次,关闭后无法再次查看。</Text>
          <SecretBox secret={secret} />
          <Group justify="flex-end" mt="lg">
            <Button onClick={onClose}>我已保存密钥</Button>
          </Group>
        </div>
      ) : (
        <div>
          <TextInput
            label="名称"
            placeholder="例如:obsidian-sync"
            value={name}
            onChange={(e) => { setName(e.currentTarget.value); setNameError(null); }}
            error={nameError ?? undefined}
            mb="sm"
            data-autofocus
          />
          <Text fz={13} fw={500} mb={6}>权限范围</Text>
          <Group gap={6} mb="sm">
            {ALL_SCOPES.map((s) => {
              const active = scopes.includes(s.value);
              return (
                <Badge
                  key={s.value}
                  variant={active ? 'light' : 'outline'}
                  color={active ? 'accentBlue' : 'coolGray'}
                  style={{ cursor: 'pointer', fontWeight: 400 }}
                  onClick={() =>
                    setScopes((prev) =>
                      prev.includes(s.value) ? prev.filter((x) => x !== s.value) : [...prev, s.value],
                    )
                  }
                >
                  {s.label}
                </Badge>
              );
            })}
          </Group>
          <Switch
            label="允许访问所有空间"
            description="关闭后需要指定具体空间(V1 暂以全部空间为主)"
            checked={spaceScope === 'all'}
            onChange={(e) => setSpaceScope(e.currentTarget.checked ? 'all' : 'selected')}
            mb="sm"
          />
          <Group justify="flex-end" mt="lg">
            <Button variant="subtle" color="coolGray" onClick={onClose}>取消</Button>
            <Button onClick={handleCreate} loading={create.isPending}>创建</Button>
          </Group>
        </div>
      )}
    </Modal>
  );
}

function SecretBox({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={mono}
      style={{
        marginTop: 12,
        padding: '10px 12px',
        backgroundColor: tokens.raisedBg,
        border: `1px solid ${tokens.subtleBorder}`,
        borderRadius: 6,
        wordBreak: 'break-all',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
      }}
    >
      <span style={{ flex: 1 }}>{secret}</span>
      <UnstyledButton
        onClick={() => {
          void navigator.clipboard.writeText(secret).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        aria-label="复制密钥"
        style={{ color: copied ? tokens.syncHealthy : tokens.textSecondary, display: 'inline-flex' }}
      >
        {copied ? <IconCheck size={15} stroke={1.7} /> : <IconCopy size={15} stroke={1.5} />}
      </UnstyledButton>
    </div>
  );
}

// ─── System (admin) ───────────────────────────────────────────

function SystemPanel() {
  const { data, isLoading, isError, refetch } = useSystemSettings();
  const update = useUpdateSystemSettings();
  const navigate = useNavigate();

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton height={200} />;

  const s = data?.settings;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 480 }}>
      <section>
        <Text className={sectionTitle} mb={4}>注册模式</Text>
        <Text className={sectionHint} mb="sm">closed 仅允许已有用户登录;open 允许自由注册。</Text>
        <SegmentedControl
          w={280}
          value={s?.registration_mode ?? 'closed'}
          onChange={(v) => update.mutate({ registration_mode: v as 'closed' | 'open' | 'invite' })}
          data={[
            { label: '关闭', value: 'closed' },
            { label: '开放', value: 'open' },
            { label: '邀请(预留)', value: 'invite' },
          ]}
          styles={{ root: { backgroundColor: tokens.hoverBg } }}
        />
      </section>
      <section>
        <Text className={sectionTitle} mb={4}>会话有效期</Text>
        <NativeSelect
          w={220}
          value={String(s?.session_ttl_hours ?? 24)}
          data={[
            { value: '12', label: '12 小时' },
            { value: '24', label: '24 小时' },
            { value: '168', label: '7 天' },
            { value: '720', label: '30 天' },
          ]}
          onChange={(e) => update.mutate({ session_ttl_hours: Number(e.currentTarget.value) })}
        />
      </section>
      <section>
        <Text className={sectionTitle} mb={4}>每用户空间上限</Text>
        <NativeSelect
          w={220}
          value={String(s?.max_spaces_per_user ?? 16)}
          data={['4', '8', '16', '32', '64'].map((v) => ({ value: v, label: `${v} 个` }))}
          onChange={(e) => update.mutate({ max_spaces_per_user: Number(e.currentTarget.value) })}
        />
      </section>
      <section>
        <Text className={sectionTitle} mb={4}>用户管理</Text>
        <Text className={sectionHint} mb="sm">管理员可以在此管理用户状态与角色。</Text>
        <Group gap="sm">
          <Button size="xs" variant="default" onClick={() => navigate('/admin/users')}>
            打开用户管理
          </Button>
          <Button size="xs" variant="subtle" color="coolGray" onClick={() => navigate('/admin/jobs')}>
            后台任务
          </Button>
        </Group>
      </section>
    </div>
  );
}

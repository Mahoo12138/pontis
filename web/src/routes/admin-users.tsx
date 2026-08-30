import { useState } from 'react';
import {
  Badge,
  Button,
  CopyButton,
  Group,
  Menu,
  Modal,
  Skeleton,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconCheck,
  IconCopy,
  IconDotsVertical,
  IconKey,
  IconShieldHalf,
  IconUserOff,
  IconUserCheck,
} from '@tabler/icons-react';
import type { AdminUserView } from '@pontis/api';
import ErrorState from '../components/common/ErrorState';
import { mono } from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import { useMe } from '../hooks/use-auth';
import { useAdminUsers, useSetUserStatus, useSetUserRole } from '../hooks/use-admin-users';
import { formatRelativeTime } from '../lib/format';

export default function AdminUsersPage() {
  const { data: me } = useMe();
  const { data, isLoading, isError, refetch } = useAdminUsers();
  const setStatus = useSetUserStatus();
  const setRole = useSetUserRole();
  const [confirmTarget, setConfirmTarget] = useState<{ user: AdminUserView; action: 'disable' | 'enable' | 'promote' } | null>(null);

  const users = data?.users ?? [];

  const apply = () => {
    if (!confirmTarget) return;
    const { user, action } = confirmTarget;
    const mutation =
      action === 'promote'
        ? setRole.mutate({ userId: user.id, role: 'admin' })
        : setStatus.mutate({ userId: user.id, status: action === 'disable' ? 'disabled' : 'active' });
    void mutation;
    setConfirmTarget(null);
    notifications.show({
      message:
        action === 'promote'
          ? `已将 ${user.display_name} 设为管理员`
          : action === 'disable'
            ? `已禁用 ${user.display_name},其会话与凭据立即失效`
            : `已启用 ${user.display_name}`,
      color: 'coolGray',
    });
  };

  return (
    <>
      <Text fz={12} c="dimmed" mb="sm">
        管理员负责用户状态与角色,但无法浏览其他用户的私有书签内容。禁用后用户的会话、Token 与设备同步立即被拒绝,数据保留。
      </Text>

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={40} />
          ))}
        </div>
      ) : (
        <Table
          verticalSpacing={9}
          horizontalSpacing={12}
          withRowBorders={false}
          styles={{
            table: { tableLayout: 'fixed' },
            th: { fontSize: 12, fontWeight: 500, color: tokens.textSecondary },
            td: { fontSize: 13 },
          }}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>用户</Table.Th>
              <Table.Th w={90}>角色</Table.Th>
              <Table.Th w={90}>状态</Table.Th>
              <Table.Th w={80}>空间</Table.Th>
              <Table.Th w={120}>最近活跃</Table.Th>
              <Table.Th w={60} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                isSelf={user.id === me?.id}
                onAction={(action) => setConfirmTarget({ user, action })}
                onResetLink={(link) => {
                  void navigator.clipboard.writeText(link).catch(() => undefined);
                }}
              />
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Modal
        opened={confirmTarget !== null}
        onClose={() => setConfirmTarget(null)}
        title={confirmTitle(confirmTarget)}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          {confirmTarget?.action === 'disable' &&
            `${confirmTarget.user.display_name} 将无法登录,已有的会话、API Token 与设备同步都会被拒绝。用户数据与发布保留,重新启用后恢复。`}
          {confirmTarget?.action === 'enable' &&
            `${confirmTarget.user.display_name} 将恢复登录能力,原有凭据(未显式撤销的)继续有效。`}
          {confirmTarget?.action === 'promote' &&
            `${confirmTarget.user.display_name} 将获得系统配置、用户管理与广场治理权限。管理员并不能浏览其他用户的私有书签。`}
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setConfirmTarget(null)}>取消</Button>
          <Button
            color={confirmTarget?.action === 'disable' ? 'errorRed' : undefined}
            loading={setStatus.isPending || setRole.isPending}
            onClick={apply}
          >
            确认
          </Button>
        </Group>
      </Modal>
    </>
  );
}

function confirmTitle(target: { user: AdminUserView; action: string } | null): string {
  if (!target) return '';
  const name = target.user.display_name;
  if (target.action === 'disable') return `禁用「${name}」?`;
  if (target.action === 'enable') return `启用「${name}」?`;
  return `将「${name}」设为管理员?`;
}

function UserRow({
  user,
  isSelf,
  onAction,
  onResetLink,
}: {
  user: AdminUserView;
  isSelf: boolean;
  onAction: (action: 'disable' | 'enable' | 'promote') => void;
  onResetLink: (link: string) => void;
}) {
  const [resetLink, setResetLink] = useState<string | null>(null);
  return (
    <Table.Tr>
      <Table.Td>
        <div style={{ minWidth: 0 }}>
          <Group gap={6}>
            <Text fz={13} fw={500} truncate>{user.display_name}</Text>
            {isSelf && (
              <Badge size="xs" variant="light" color="coolGray" styles={{ root: { fontWeight: 400 } }}>
                自己
              </Badge>
            )}
          </Group>
          <Text fz={12} c="dimmed" truncate>
            {user.username}{user.email ? ` · ${user.email}` : ''}
          </Text>
        </div>
      </Table.Td>
      <Table.Td>
        <Badge size="sm" variant="light" color={user.role === 'admin' ? 'accentBlue' : 'coolGray'} styles={{ root: { fontWeight: 400 } }}>
          {user.role === 'admin' ? '管理员' : '用户'}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Badge size="sm" variant="light" color={user.status === 'active' ? 'healthyGreen' : 'errorRed'} styles={{ root: { fontWeight: 400 } }}>
          {user.status === 'active' ? '正常' : '已禁用'}
        </Badge>
      </Table.Td>
      <Table.Td c="dimmed" fz={12}>{user.space_count}</Table.Td>
      <Table.Td c="dimmed" fz={12}>
        {user.last_seen_at ? formatRelativeTime(user.last_seen_at) : '从未登录'}
      </Table.Td>
      <Table.Td>
        <Menu shadow="md" width={190} position="bottom-end">
          <Menu.Target>
            <UnstyledButton
              aria-label="用户操作"
              style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 4 }}
            >
              <IconDotsVertical size={16} stroke={1.5} />
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconUserCheck size={14} stroke={1.5} />}
              disabled={isSelf || user.status === 'active'}
              onClick={() => onAction('enable')}
            >
              启用
            </Menu.Item>
            <Menu.Item
              color="errorRed"
              leftSection={<IconUserOff size={14} stroke={1.5} />}
              disabled={isSelf || user.status === 'disabled'}
              onClick={() => onAction('disable')}
            >
              禁用
            </Menu.Item>
            <Menu.Item
              leftSection={<IconShieldHalf size={14} stroke={1.5} />}
              disabled={isSelf || user.role === 'admin'}
              onClick={() => onAction('promote')}
            >
              设为管理员
            </Menu.Item>
            <Menu.Item
              leftSection={<IconKey size={14} stroke={1.5} />}
              onClick={() => {
                import('@pontis/api/endpoints/admin-users').then(({ createResetLink }) =>
                  createResetLink(user.id).then((res) => {
                    setResetLink(res.reset_link);
                    onResetLink(res.reset_link);
                  }),
                );
              }}
            >
              生成重置密码链接
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Table.Td>
      {resetLink && (
        <Modal
          opened
          onClose={() => setResetLink(null)}
          title={`「${user.display_name}」的重置链接`}
          size={480}
          styles={{ header: { fontSize: 15, fontWeight: 600 } }}
        >
          <Text fz={13} mb="sm">
            请通过其他渠道将此链接发送给用户。链接只能使用一次,短期有效;管理员无需知道新密码。
          </Text>
          <div
            className={mono}
            style={{
              padding: '10px 12px',
              backgroundColor: tokens.raisedBg,
              border: `1px solid ${tokens.subtleBorder}`,
              borderRadius: 6,
              wordBreak: 'break-all',
            }}
          >
            {resetLink}
          </div>
          <Group justify="flex-end" mt="lg">
            <CopyButton value={resetLink}>
              {({ copied, copy }) => (
                <Button
                  size="xs"
                  variant="default"
                  leftSection={copied ? <IconCheck size={14} stroke={1.5} /> : <IconCopy size={14} stroke={1.5} />}
                  onClick={copy}
                >
                  {copied ? '已复制' : '复制链接'}
                </Button>
              )}
            </CopyButton>
            <Button size="xs" onClick={() => setResetLink(null)}>关闭</Button>
          </Group>
        </Modal>
      )}
    </Table.Tr>
  );
}

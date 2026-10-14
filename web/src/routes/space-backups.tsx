import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Group,
  List,
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
  IconArrowLeft,
  IconArchive,
  IconCalendarClock,
  IconDotsVertical,
  IconLock,
  IconLockOpen,
  IconPlus,
  IconRestore,
  IconShieldCheck,
  IconTrash,
} from '@tabler/icons-react';
import type { Backup } from '@pontis/api';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import { useNodes } from '../hooks/use-nodes';
import { useDeviceOverview } from '../hooks/use-devices';
import { contentRegion } from '../styles/app-shell.css';
import { pagePad, mono } from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import { useSpaces } from '../hooks/use-spaces';
import {
  useBackups,
  useCreateBackup,
  useDeleteBackup,
  useRestoreBackup,
  useToggleBackupProtected,
} from '../hooks/use-backups';
import { formatRelativeTime, formatSize } from '../lib/format';

const KIND_META: Record<Backup['kind'], { label: string; color: string; hint: string }> = {
  manual: { label: '手动', color: 'accentBlue', hint: '保留到手动删除' },
  scheduled: { label: '定时', color: 'coolGray', hint: '按保留策略滚动清理' },
  safety: { label: '安全', color: 'warningAmber', hint: '高风险操作前自动创建,约保留 30 天' },
};

export default function SpaceBackupsPage() {
  const { spaceId } = useParams();
  const navigate = useNavigate();
  const { data: spacesData } = useSpaces();
  const spaceName = spacesData?.spaces?.find((s) => s.id === spaceId)?.name ?? '空间';

  const { data, isLoading, isError, error, refetch } = useBackups(spaceId);
  const create = useCreateBackup(spaceId);
  const restore = useRestoreBackup(spaceId);
  const remove = useDeleteBackup(spaceId);
  const toggleProtect = useToggleBackupProtected(spaceId);

  // How much a restore actually moves, so the confirmation can name a number
  // instead of "everything": the tree it overwrites and the devices it detaches.
  const { data: nodesData } = useNodes(spaceId);
  const { data: devicesData } = useDeviceOverview();
  const currentNodes = nodesData?.nodes.length;
  const boundDevices = (devicesData?.devices ?? []).filter((d) =>
    d.bindings.some((b) => b.space_id === spaceId),
  ).length;

  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null);
  const [restored, setRestored] = useState<{ epoch: number } | null>(null);

  const backups = data?.backups ?? [];

  const handleRestore = () => {
    if (!restoreTarget) return;
    restore.mutate(restoreTarget.id, {
      onSuccess: (res) => {
        setRestoreTarget(null);
        setRestored({ epoch: res.new_epoch });
        void refetch();
      },
      onError: (e) =>
        notifications.show({
          message: e instanceof Error ? e.message : '恢复失败',
          color: 'errorRed',
        }),
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    remove.mutate(deleteTarget.id, {
      onSuccess: () => {
        notifications.show({ message: `已删除 ${deleteTarget.filename}`, color: 'coolGray' });
        setDeleteTarget(null);
      },
    });
  };

  return (
    <>
      <Header breadcrumb={`${spaceName} / 备份`} />
      <div className={`${contentRegion} ${pagePad}`}>
        <Group gap="xs" mb="md">
          <Button
            variant="subtle"
            color="coolGray"
            size="compact-sm"
            leftSection={<IconArrowLeft size={14} stroke={1.5} />}
            onClick={() => navigate(`/spaces/${spaceId}`)}
          >
            返回空间
          </Button>
          <span style={{ flex: 1 }} />
          <Button
            size="xs"
            leftSection={<IconPlus size={14} stroke={1.5} />}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: (b) =>
                  notifications.show({ message: `已创建备份 ${b.filename}`, color: 'coolGray' }),
              })
            }
            loading={create.isPending}
          >
            创建备份
          </Button>
        </Group>

        <Text fz={12} c="dimmed" mb="sm">
          备份以空间为单位,包含书签树与根目录结构,保留稳定的节点标识。手动备份永久保留,定时备份按策略滚动,安全备份由高风险操作自动创建。
        </Text>

        {isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} height={40} />
            ))}
          </div>
        ) : backups.length === 0 ? (
          <EmptyBackups onCreate={() => create.mutate(undefined)} creating={create.isPending} />
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
                <Table.Th>备份文件</Table.Th>
                <Table.Th w={90}>类型</Table.Th>
                <Table.Th w={90}>大小</Table.Th>
                <Table.Th w={150}>内容</Table.Th>
                <Table.Th w={120}>创建时间</Table.Th>
                <Table.Th w={60} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {backups.map((backup) => (
                <BackupRow
                  key={backup.id}
                  backup={backup}
                  onRestore={() => setRestoreTarget(backup)}
                  onDelete={() => setDeleteTarget(backup)}
                  onToggleProtect={() =>
                    toggleProtect.mutate(
                      { backupId: backup.id, backupProtected: !backup.protected },
                      {
                        onSuccess: (b) =>
                          notifications.show({
                            message: b.protected ? '已保护,不再被自动清理' : '已取消保护',
                            color: 'coolGray',
                          }),
                      },
                    )
                  }
                  protectPending={toggleProtect.isPending}
                />
              ))}
            </Table.Tbody>
          </Table>
        )}
      </div>

      {/* Restore confirmation */}
      <Modal
        opened={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        title={`恢复「${restoreTarget?.filename ?? ''}」？`}
        size={480}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          {currentNodes === undefined
            ? '空间的书签树将被整体替换为该备份的内容。'
            : `当前空间的 ${currentNodes} 个节点将被整体替换为备份里的 ${restoreTarget?.node_count ?? 0} 个（其中书签 ${restoreTarget?.bookmark_count ?? 0} 个）。`}
        </Text>
        <List fz={13} mt="xs" spacing={4}>
          <List.Item>替换之前服务器先自动留一份安全备份，退回它就是最坏的退路。</List.Item>
          <List.Item>
            {boundDevices > 0
              ? `空间进入新的 Epoch，现有的 ${boundDevices} 台已绑定设备全部退回「待初始化」`
              : '空间进入新的 Epoch，已绑定设备全部退回「待初始化」'}
            ：每台都要各自完成一次对账才会恢复同步，不是点一下同步就回来。
          </List.Item>
          <List.Item>这些设备在离线期间的改动不会直接盖掉新基线，而是作为待确认的恢复意图交回给你。</List.Item>
        </List>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setRestoreTarget(null)}>
            取消
          </Button>
          <Button color="errorRed" loading={restore.isPending} onClick={handleRestore}>
            开始恢复
          </Button>
        </Group>
      </Modal>

      {/* Restore done */}
      <Modal
        opened={restored !== null}
        onClose={() => setRestored(null)}
        title="恢复完成"
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          空间已恢复到所选备份,并进入 Epoch {restored?.epoch}。
          每台已绑定设备现在都停在「待初始化」，要各自跑一次对账才会回到 active——
          扩展会在下一次同步触发时自动开始，也可以在扩展设置里手动推进。
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button onClick={() => setRestored(null)}>知道了</Button>
        </Group>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`删除「${deleteTarget?.filename ?? ''}」？`}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>删除后无法再恢复到这个时间点。此操作只影响备份文件,不影响空间当前内容。</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setDeleteTarget(null)}>
            取消
          </Button>
          <Button color="errorRed" loading={remove.isPending} onClick={handleDelete}>
            删除
          </Button>
        </Group>
      </Modal>
    </>
  );
}

function BackupRow({
  backup,
  onRestore,
  onDelete,
  onToggleProtect,
  protectPending,
}: {
  backup: Backup;
  onRestore: () => void;
  onDelete: () => void;
  onToggleProtect: () => void;
  protectPending: boolean;
}) {
  const kind = KIND_META[backup.kind];
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={8} wrap="nowrap">
          {backup.protected && (
            <Tooltip label="已保护,不会被自动清理">
              <IconShieldCheck size={15} stroke={1.5} style={{ color: tokens.syncHealthy, flexShrink: 0 }} />
            </Tooltip>
          )}
          <span className={mono} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {backup.filename}
          </span>
        </Group>
      </Table.Td>
      <Table.Td>
        <Tooltip label={kind.hint}>
          <Badge size="sm" variant="light" color={kind.color} styles={{ root: { fontWeight: 400 } }}>
            {kind.label}
          </Badge>
        </Tooltip>
      </Table.Td>
      <Table.Td c="dimmed" fz={12}>{formatSize(backup.size_bytes)}</Table.Td>
      <Table.Td c="dimmed" fz={12}>
        {backup.bookmark_count} 书签 · {backup.node_count} 节点
      </Table.Td>
      <Table.Td c="dimmed" fz={12}>{formatRelativeTime(backup.created_at)}</Table.Td>
      <Table.Td>
        <Menu shadow="md" width={170} position="bottom-end">
          <Menu.Target>
            <UnstyledButton
              aria-label="备份操作"
              style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 4, borderRadius: 4 }}
            >
              <IconDotsVertical size={16} stroke={1.5} />
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconRestore size={14} stroke={1.5} />}
              onClick={onRestore}
            >
              恢复到此备份
            </Menu.Item>
            <Menu.Item
              leftSection={
                backup.protected
                  ? <IconLockOpen size={14} stroke={1.5} />
                  : <IconLock size={14} stroke={1.5} />
              }
              onClick={onToggleProtect}
              disabled={protectPending}
            >
              {backup.protected ? '取消保护' : '保护此备份'}
            </Menu.Item>
            <Menu.Item
              color="errorRed"
              leftSection={<IconTrash size={14} stroke={1.5} />}
              onClick={onDelete}
            >
              删除
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Table.Td>
    </Table.Tr>
  );
}

function EmptyBackups({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 240,
        color: tokens.textSecondary,
        gap: 8,
      }}
    >
      <IconArchive size={30} stroke={1.2} />
      <Text fz="sm">这个空间还没有备份</Text>
      <Text fz="xs" c="dimmed">
        建议在整理或大量导入前先创建一份备份。
      </Text>
      <Button
        size="compact-sm"
        variant="subtle"
        mt={4}
        leftSection={<IconCalendarClock size={14} stroke={1.5} />}
        onClick={onCreate}
        loading={creating}
      >
        创建备份
      </Button>
    </div>
  );
}

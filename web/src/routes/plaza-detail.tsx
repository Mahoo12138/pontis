import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  Skeleton,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconDotsVertical,
  IconDownload,
  IconGlobe,
  IconLock,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import PublicationTree from '../components/plaza/PublicationTree';
import ImportModal from '../components/plaza/ImportModal';
import { contentRegion } from '../styles/app-shell.css';
import { pagePad } from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import { usePublication, useUnpublish, useUpdatePublication, useApplyPublication } from '../hooks/use-plaza';
import { useSpaces } from '../hooks/use-spaces';
import { formatRelativeTime } from '../lib/format';

/** The server names an apply target as one string: `root:<key>` or `node:<id>`. */
function parseTargetParent(key: string) {
  const sep = key.indexOf(':');
  const kind = sep < 0 ? key : key.slice(0, sep);
  const rest = sep < 0 ? '' : key.slice(sep + 1);
  return kind === 'node' ? { type: 'node' as const, id: rest } : { type: 'root' as const, key: rest };
}

export default function PlazaDetailPage() {
  const { publicationId } = useParams();
  const navigate = useNavigate();
  const { data: pub, isLoading, isError, error, refetch } = usePublication(publicationId);
  const unpublish = useUnpublish();
  const update = useUpdatePublication();
  const apply = useApplyPublication();
  const { data: spacesData } = useSpaces();
  const [importOpen, setImportOpen] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);

  if (isError) {
    return (
      <>
        <Header breadcrumb="广场" />
        <div className={`${contentRegion} ${pagePad}`}>
          <ErrorState message="无法加载该发布" error={error} onRetry={() => void refetch()} />
        </div>
      </>
    );
  }

  if (isLoading || !pub) {
    return (
      <>
        <Header breadcrumb="广场" />
        <div className={`${contentRegion} ${pagePad}`}>
          <Skeleton height={28} width={280} />
          <Skeleton height={16} width={200} mt={10} />
          <Skeleton height={200} mt={20} radius={8} />
        </div>
      </>
    );
  }

  const reportError = (e: unknown, fallback: string) =>
    notifications.show({
      message: e instanceof Error ? e.message : fallback,
      color: 'errorRed',
    });

  const handleSnapshotUpdate = () => {
    update.mutate(
      { id: pub.id, params: { snapshot: true } },
      {
        onSuccess: (next) =>
          notifications.show({
            message: `已更新快照到 v${next.version}`,
            color: 'coolGray',
          }),
        onError: (e) => reportError(e, '更新快照失败'),
      },
    );
  };

  const handleToggleVisibility = () => {
    const next = pub.visibility === 'plaza' ? 'private' : 'plaza';
    update.mutate(
      { id: pub.id, params: { visibility: next } },
      {
        onSuccess: () =>
          notifications.show({
            message: next === 'plaza' ? `已公开「${pub.title}」到广场` : `「${pub.title}」已转为私有`,
            color: 'coolGray',
          }),
        onError: (e) => reportError(e, '操作失败'),
      },
    );
  };

  const imported = pub.import;
  const importedSpaceName = (spacesData?.spaces ?? []).find((s) => s.id === imported?.space_id)?.name;

  const handleUpdateImport = () => {
    if (!imported) return;
    apply.mutate(
      {
        id: pub.id,
        params: {
          space_id: imported.space_id,
          parent: parseTargetParent(imported.target_parent),
          strategy: 'merge',
        },
      },
      {
        onSuccess: (res) =>
          notifications.show({
            title: `已更新到 v${pub.version}`,
            message: `新建 ${res.created} 项 · 更新 ${res.updated} 项 · 保留 ${res.kept} 项`,
            color: 'coolGray',
          }),
        onError: (e) => reportError(e, '更新导入失败'),
      },
    );
  };

  const handleUnpublish = () => {
    unpublish.mutate(pub.id, {
      onSuccess: () => {
        notifications.show({ message: `已取消发布「${pub.title}」`, color: 'coolGray' });
        navigate('/plaza');
      },
      onError: (e) =>
        notifications.show({
          message: e instanceof Error ? e.message : '操作失败',
          color: 'errorRed',
        }),
    });
  };

  return (
    <>
      <Header breadcrumb={`广场 / ${pub.title}`} />
      <div className={`${contentRegion} ${pagePad}`} style={{ maxWidth: 860 }}>
        <Group gap="xs" mb="md">
          <Button
            variant="subtle"
            color="coolGray"
            size="compact-sm"
            leftSection={<IconArrowLeft size={14} stroke={1.5} />}
            onClick={() => navigate('/plaza')}
          >
            返回广场
          </Button>
        </Group>

        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <div style={{ minWidth: 0 }}>
            <Text fz={18} fw={600}>{pub.title}</Text>
            <Text fz={13} c="dimmed" mt={4}>
              {pub.publisher} · v{pub.version} · 更新于 {formatRelativeTime(pub.updated_at)}
            </Text>
          </div>
          <Group gap={8} style={{ flexShrink: 0 }}>
            {imported?.has_update && (
              <Button
                size="xs"
                onClick={handleUpdateImport}
                loading={apply.isPending}
                leftSection={<IconRefresh size={14} stroke={1.5} />}
              >
                更新到 v{pub.version}
              </Button>
            )}
            <Button
              size="xs"
              variant={imported?.has_update ? 'default' : 'filled'}
              onClick={() => setImportOpen(true)}
              leftSection={<IconDownload size={14} stroke={1.5} />}
            >
              导入到空间
            </Button>
            {pub.is_mine && (
              <Menu shadow="md" width={170} position="bottom-end">
                <Menu.Target>
                  <Button size="xs" variant="default" px={6} aria-label="发布操作">
                    <IconDotsVertical size={15} stroke={1.5} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    leftSection={<IconRefresh size={14} stroke={1.5} />}
                    disabled={update.isPending}
                    onClick={handleSnapshotUpdate}
                  >
                    从空间更新快照
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconGlobe size={14} stroke={1.5} />}
                    rightSection={pub.visibility === 'plaza' ? undefined : <IconLock size={12} />}
                    disabled={update.isPending}
                    onClick={handleToggleVisibility}
                  >
                    {pub.visibility === 'plaza' ? '设为私有' : '公开到广场'}
                  </Menu.Item>
                  <Menu.Item
                    color="errorRed"
                    leftSection={<IconTrash size={14} stroke={1.5} />}
                    onClick={() => setUnpublishOpen(true)}
                  >
                    取消发布
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        </Group>

        {pub.description && (
          <Text fz={13} mt="sm" style={{ maxWidth: 640 }}>
            {pub.description}
          </Text>
        )}

        <Group gap={4} mt="sm">
          {pub.tags.map((tag) => (
            <Badge key={tag} variant="light" color="coolGray" styles={{ root: { fontWeight: 400 } }}>
              {tag}
            </Badge>
          ))}
        </Group>

        {imported && (
          <Text fz={12} mt="sm" style={{ color: imported.has_update ? tokens.syncRecovery : tokens.textSecondary }}>
            {imported.has_update
              ? `你已导入到「${importedSpaceName ?? '未知空间'}」的 v${imported.last_version}，此发布已更新到 v${pub.version}。`
              : `你已导入到「${importedSpaceName ?? '未知空间'}」，与当前版本一致。`}
          </Text>
        )}

        <Text fz={12} c="dimmed" mt="md">
          {pub.bookmark_count} 个书签 · {pub.folder_count} 个文件夹
        </Text>

        <div
          style={{
            marginTop: 8,
            border: `1px solid ${tokens.subtleBorder}`,
            borderRadius: 8,
            padding: '6px 0',
            backgroundColor: tokens.workspaceBg,
          }}
        >
          <PublicationTree root={pub.tree} />
        </div>
      </div>

      <ImportModal
        publication={pub}
        opened={importOpen}
        onClose={() => setImportOpen(false)}
      />

      <Modal
        opened={unpublishOpen}
        onClose={() => setUnpublishOpen(false)}
        title={`取消发布「${pub.title}」？`}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          该发布将从广场移除,已导入到他人空间的书签副本不受影响。
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setUnpublishOpen(false)}>
            取消
          </Button>
          <Button color="errorRed" loading={unpublish.isPending} onClick={handleUnpublish}>
            取消发布
          </Button>
        </Group>
      </Modal>
    </>
  );
}

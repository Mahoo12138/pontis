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
import { usePublication, useUnpublish } from '../hooks/use-plaza';
import { formatRelativeTime } from '../lib/format';

export default function PlazaDetailPage() {
  const { publicationId } = useParams();
  const navigate = useNavigate();
  const { data: pub, isLoading, isError, refetch } = usePublication(publicationId);
  const unpublish = useUnpublish();
  const [importOpen, setImportOpen] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);

  if (isError) {
    return (
      <>
        <Header breadcrumb="广场" />
        <div className={`${contentRegion} ${pagePad}`}>
          <ErrorState message="无法加载该发布" onRetry={() => void refetch()} />
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
            <Button size="xs" onClick={() => setImportOpen(true)} leftSection={<IconDownload size={14} stroke={1.5} />}>
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
                  <Menu.Item leftSection={<IconRefresh size={14} stroke={1.5} />}>
                    从空间更新快照
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconGlobe size={14} stroke={1.5} />}
                    rightSection={pub.visibility === 'plaza' ? undefined : <IconLock size={12} />}
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

import { useEffect, useMemo, useState } from 'react';
import { Button, Group, Modal, NativeSelect, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { PublicationVisibility, Space } from '@pontis/api';
import { usePublish } from '../../hooks/use-plaza';
import { useNodes } from '../../hooks/use-nodes';

/** The three things a user can publish (doc 10 §3), all stored as one tree. */
type SourceKind = 'space' | 'folder' | 'bookmark';

/**
 * Publisher flow: pick a space, one folder inside it, or a single bookmark,
 * and describe the publication. The published snapshot is independent from
 * later edits.
 */
export default function PublishModal({
  opened,
  onClose,
  spaces,
  onPublished,
}: {
  opened: boolean;
  onClose: () => void;
  spaces: Space[];
  onPublished: () => void;
}) {
  const publish = usePublish();
  const [spaceId, setSpaceId] = useState('');
  const [source, setSource] = useState('');
  const [sourceKind, setSourceKind] = useState<SourceKind>('space');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [visibility, setVisibility] = useState<PublicationVisibility>('plaza');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (opened) {
      setSpaceId(spaces[0]?.id ?? '');
      setSource('');
      setSourceKind('space');
      setTitle('');
      setDescription('');
      setTags('');
      setVisibility('plaza');
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const { data: nodesData } = useNodes(sourceKind === 'space' ? undefined : spaceId || undefined);
  const sourceOptions = useMemo(
    () =>
      (nodesData?.nodes ?? [])
        .filter((n) => (sourceKind === 'space' ? false : n.type === sourceKind))
        .map((n) => ({ value: n.id, label: n.title })),
    [nodesData, sourceKind],
  );

  const handlePublish = () => {
    const trimmed = title.trim();
    if (trimmed.length < 1) {
      setError('标题不能为空');
      return;
    }
    if (sourceKind !== 'space' && !source) {
      setError(sourceKind === 'folder' ? '请选择要发布的文件夹' : '请选择要发布的书签');
      return;
    }
    setError(null);
    publish.mutate(
      {
        space_id: spaceId,
        root_node_id: sourceKind === 'space' ? undefined : source,
        title: trimmed,
        description: description.trim() || undefined,
        visibility,
        tags: tags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
      },
      {
        onSuccess: () => {
          notifications.show({
            message:
              visibility === 'plaza'
                ? `已发布「${trimmed}」到广场。后续对空间的修改不会自动进入发布。`
                : `已创建私有发布「${trimmed}」，只有你能在「我的发布」看到它。`,
            color: 'coolGray',
          });
          onPublished();
          onClose();
        },
        onError: (e) =>
          setError(e instanceof Error ? e.message : '发布失败'),
      },
    );
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="发布到广场"
      size={520}
      styles={{ header: { fontSize: 15, fontWeight: 600 } }}
    >
      <Stack gap="sm">
        <NativeSelect
          label="来源空间"
          data={spaces.map((s) => ({ value: s.id, label: s.name }))}
          value={spaceId}
          onChange={(e) => {
            setSpaceId(e.currentTarget.value);
            setSource('');
          }}
        />
        <NativeSelect
          label="发布范围"
          data={[
            { value: 'space', label: '整个空间' },
            { value: 'folder', label: '空间里的一个文件夹' },
            { value: 'bookmark', label: '单个书签' },
          ]}
          value={sourceKind}
          onChange={(e) => {
            setSourceKind(e.currentTarget.value as SourceKind);
            setSource('');
          }}
        />
        {sourceKind !== 'space' && (
          <NativeSelect
            label={sourceKind === 'folder' ? '发布内容' : '发布书签'}
            data={[
              { value: '', label: sourceKind === 'folder' ? '选择文件夹…' : '选择书签…', disabled: true },
              ...sourceOptions,
            ]}
            value={source}
            onChange={(e) => setSource(e.currentTarget.value)}
          />
        )}
        <TextInput
          label="标题"
          placeholder="例如:Go 开发资源导航"
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value);
            setError(null);
          }}
          error={error ?? undefined}
          data-autofocus
        />
        <TextInput
          label="描述"
          placeholder="一句话介绍这个合集"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <TextInput
          label="标签"
          placeholder="用逗号分隔,例如:Go, 后端"
          value={tags}
          onChange={(e) => setTags(e.currentTarget.value)}
        />
        <NativeSelect
          label="可见性"
          data={[
            { value: 'plaza', label: '公开到广场' },
            { value: 'private', label: '私有（仅自己在「我的发布」可见）' },
          ]}
          value={visibility}
          onChange={(e) => setVisibility(e.currentTarget.value as PublicationVisibility)}
        />
        <Text fz={12} c="dimmed">
          发布会创建一个独立的版本化快照,不包含私有 UUID、修订号或设备信息。
          空间后续变化不会自动同步到发布。
        </Text>
        <Group justify="flex-end" mt="xs">
          <Button variant="subtle" color="coolGray" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handlePublish} loading={publish.isPending}>
            发布
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

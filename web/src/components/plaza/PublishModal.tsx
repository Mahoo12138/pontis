import { useEffect, useMemo, useState } from 'react';
import { Button, Group, Modal, NativeSelect, Stack, Switch, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Space } from '@pontis/api';
import { usePublish } from '../../hooks/use-plaza';
import { useNodes } from '../../hooks/use-nodes';

/**
 * Publisher flow: pick a space (or a folder inside it) and describe the
 * publication. The published snapshot is independent from later edits.
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
  const [wholeSpace, setWholeSpace] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (opened) {
      setSpaceId(spaces[0]?.id ?? '');
      setSource('');
      setWholeSpace(true);
      setTitle('');
      setDescription('');
      setTags('');
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const { data: nodesData } = useNodes(wholeSpace ? undefined : spaceId || undefined);
  const folderOptions = useMemo(
    () => (nodesData?.nodes ?? []).filter((n) => n.type === 'folder'),
    [nodesData],
  );

  const handlePublish = () => {
    const trimmed = title.trim();
    if (trimmed.length < 1) {
      setError('标题不能为空');
      return;
    }
    if (!wholeSpace && !source) {
      setError('请选择要发布的文件夹');
      return;
    }
    setError(null);
    publish.mutate(
      {
        space_id: spaceId,
        root_node_id: wholeSpace ? undefined : source,
        title: trimmed,
        description: description.trim() || undefined,
        tags: tags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
      },
      {
        onSuccess: () => {
          notifications.show({
            message: `已发布「${trimmed}」。后续对空间的修改不会自动进入发布。`,
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
        <Switch
          label="发布整个空间"
          description="关闭后可以选择空间中的一个文件夹"
          checked={wholeSpace}
          onChange={(e) => setWholeSpace(e.currentTarget.checked)}
        />
        {!wholeSpace && (
          <NativeSelect
            label="发布内容"
            data={[
              { value: '', label: '选择文件夹…', disabled: true },
              ...folderOptions.map((f) => ({ value: f.id, label: f.title })),
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

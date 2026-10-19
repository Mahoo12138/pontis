import { useEffect, useState } from 'react';
import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { PublicationDetail } from '@pontis/api';
import { useUpdatePublication } from '../../hooks/use-plaza';

/**
 * Publisher-side metadata edit. It changes how a publication is listed and
 * described; the snapshot itself only moves through "update from space".
 */
export default function EditMetaModal({
  publication,
  opened,
  onClose,
}: {
  publication: PublicationDetail | null;
  opened: boolean;
  onClose: () => void;
}) {
  const update = useUpdatePublication();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (opened && publication) {
      setTitle(publication.title);
      setDescription(publication.description);
      setTags(publication.tags.join(', '));
      setError(null);
    }
  }, [opened, publication]);

  if (!publication) return null;

  const handleSave = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('标题不能为空');
      return;
    }
    setError(null);
    update.mutate(
      {
        id: publication.id,
        params: {
          title: trimmed,
          description: description.trim(),
          tags: tags
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
        },
      },
      {
        onSuccess: () => {
          notifications.show({ message: '已更新发布信息', color: 'coolGray' });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : '保存失败'),
      },
    );
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`编辑「${publication.title}」`}
      size={480}
      styles={{ header: { fontSize: 15, fontWeight: 600 } }}
    >
      <Stack gap="sm">
        <TextInput
          label="标题"
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
          修改只影响列表里的展示,不会改动已经发布的快照内容。
        </Text>
        <Group justify="flex-end" mt="xs">
          <Button variant="subtle" color="coolGray" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSave} loading={update.isPending}>
            保存
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

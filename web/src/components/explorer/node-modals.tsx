import { useEffect } from 'react';
import {
  Modal,
  TextInput,
  Button,
  Stack,
  Text,
  Group,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { classifyUrl } from '../../lib/safe-url';

export type NewNodeMode = 'bookmark' | 'folder';

interface NewNodeModalProps {
  opened: boolean;
  mode: NewNodeMode;
  parentLabel: string;
  pending?: boolean;
  onClose: () => void;
  onSubmit: (values: { title: string; url?: string }) => void;
}

/** Create-bookmark / create-folder dialog (Mantine Form validated). */
export function NewNodeModal({
  opened,
  mode,
  parentLabel,
  pending,
  onClose,
  onSubmit,
}: NewNodeModalProps) {
  const form = useForm({
    initialValues: { title: '', url: '' },
    validate: {
      title: (v) => (v.trim() ? null : '名称不能为空'),
      url: (v) => {
        if (mode !== 'bookmark') return null;
        if (!v.trim()) return '链接不能为空';
        return classifyUrl(v) === 'invalid' ? '链接格式无效' : null;
      },
    },
  });

  // Reset between opens.
  useEffect(() => {
    if (opened) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, mode]);

  const isBookmarklet =
    mode === 'bookmark' && classifyUrl(form.values.url) === 'bookmarklet';

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={mode === 'bookmark' ? '新建书签' : '新建文件夹'}
      size="sm"
    >
      <form
        onSubmit={form.onSubmit((values) =>
          onSubmit({
            title: values.title.trim(),
            url: mode === 'bookmark' ? values.url.trim() : undefined,
          }),
        )}
      >
        <Stack gap="sm">
          <Text fz="xs" c="dimmed">
            位置：{parentLabel}
          </Text>
          <TextInput
            label="名称"
            placeholder={mode === 'bookmark' ? '例如：React 文档' : '例如：工具'}
            data-autofocus
            {...form.getInputProps('title')}
          />
          {mode === 'bookmark' && (
            <>
              <TextInput
                label="链接"
                placeholder="https://…"
                {...form.getInputProps('url')}
              />
              {isBookmarklet && (
                <Text fz="xs" c="warningAmber">
                  这是一个 bookmarklet：仅保存代码，不会作为脚本执行。
                </Text>
              )}
            </>
          )}
          <Group justify="flex-end" mt="xs">
            <Button variant="subtle" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" loading={pending}>
              创建
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

interface ConfirmDeleteDialogProps {
  opened: boolean;
  count: number;
  pending?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/** Batch delete confirmation; warns that folders delete with contents. */
export function ConfirmDeleteDialog({
  opened,
  count,
  pending,
  onClose,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  return (
    <Modal opened={opened} onClose={onClose} title="删除确认" size="xs">
      <Stack gap="md">
        <Text fz="sm">
          确定删除选中的 {count} 个项目吗？文件夹会连同其中的书签一起删除。
        </Text>
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>
            取消
          </Button>
          <Button color="errorRed" loading={pending} onClick={onConfirm}>
            删除
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

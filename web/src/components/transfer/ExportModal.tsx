import { useEffect, useState } from 'react';
import { Button, Group, Modal, NativeSelect, Radio, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ImportFormat } from '@pontis/api';
import { useExport } from '../../hooks/use-transfer';
import { useRootSlots } from '../../hooks/use-nodes';

/**
 * Export is side-effect free (no revision/journal). The mock returns the
 * file content inline; the client turns it into a download.
 */
export default function ExportModal({
  spaceId,
  spaceName,
  opened,
  onClose,
}: {
  spaceId: string;
  spaceName: string;
  opened: boolean;
  onClose: () => void;
}) {
  const exportMutation = useExport(spaceId);
  const { data: rootSlots } = useRootSlots(spaceId);

  const [format, setFormat] = useState<ImportFormat>('netscape_html');
  const [scope, setScope] = useState('space:');

  useEffect(() => {
    if (opened) {
      setFormat('netscape_html');
      setScope('space:');
      exportMutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const slotOptions = (rootSlots?.root_slots ?? []).map((s) => ({
    value: `root:${s.key}`,
    label: `仅根目录 / ${s.display_name}`,
  }));

  const handleExport = () => {
    const [type, key] = scope.split(':');
    exportMutation.mutate(
      { format, root_key: type === 'root' ? key : undefined },
      {
        onSuccess: (res) => {
          const blob = new Blob([res.content], { type: res.content_type });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = res.filename;
          a.click();
          URL.revokeObjectURL(url);
          notifications.show({
            message: `已导出 ${res.filename}`,
            color: 'coolGray',
          });
          onClose();
        },
        onError: (e) =>
          notifications.show({
            message: e instanceof Error ? e.message : '导出失败',
            color: 'errorRed',
          }),
      },
    );
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`导出 — ${spaceName}`}
      size={460}
      styles={{ header: { fontSize: 15, fontWeight: 600 } }}
    >
      <Stack gap="sm">
        <Radio.Group
          label="格式"
          value={format}
          onChange={(v) => setFormat(v as ImportFormat)}
        >
          <Stack gap={6} mt={6}>
            <Radio
              value="netscape_html"
              label="Netscape HTML"
              description="可被各浏览器书签管理器直接导入"
            />
            <Radio
              value="native_json"
              label="Native JSON"
              description="保留根目录槽位语义,用于 Pontis 之间迁移"
            />
          </Stack>
        </Radio.Group>

        {slotOptions.length > 0 && (
          <NativeSelect
            label="导出范围"
            data={[
              { value: 'space:', label: '整个空间' },
              ...slotOptions,
            ]}
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value)}
          />
        )}

        <Text fz={12} c="dimmed">
          导出不会产生修订记录,也不影响同步状态。
        </Text>

        <Group justify="flex-end" mt="xs">
          <Button variant="subtle" color="coolGray" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleExport} loading={exportMutation.isPending}>
            导出
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

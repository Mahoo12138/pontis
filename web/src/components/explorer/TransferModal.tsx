import { useMemo, useState } from 'react';
import { Modal, Select, Button, Stack, Text, Group } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { Node } from '@pontis/api';
import { createSpaceTransfer } from '@pontis/api/endpoints/space-transfer';
import { useSpaces } from '../../hooks/use-spaces';
import { useNodes } from '../../hooks/use-nodes';

interface TransferModalProps {
  opened: boolean;
  sourceSpaceId: string;
  node: Node | null;
  onClose: () => void;
}

/** Cross-space transfer dialog (doc 03 §7): pick a target space and a
 *  target folder, then let the server move the subtree atomically. */
export default function TransferModal({ opened, sourceSpaceId, node, onClose }: TransferModalProps) {
  const qc = useQueryClient();
  const { data: spacesData } = useSpaces();

  const [targetSpaceId, setTargetSpaceId] = useState<string | null>(null);
  const [targetParentId, setTargetParentId] = useState<string | null>(null);

  const targetOptions = useMemo(
    () =>
      (spacesData?.spaces ?? [])
        .filter((s) => s.id !== sourceSpaceId)
        .map((s) => ({ value: s.id, label: s.name })),
    [spacesData, sourceSpaceId],
  );

  const enabled = opened && !!targetSpaceId;
  const { data: targetNodesData } = useNodes(enabled ? targetSpaceId : undefined);
  const folderOptions = useMemo(() => {
    const folders = (targetNodesData?.nodes ?? [])
      .filter((n) => n.type === 'folder')
      .map((n) => ({ value: n.id, label: n.title }));
    return [{ value: '', label: '根目录' }, ...folders];
  }, [targetNodesData]);

  const transfer = useMutation({
    mutationFn: () => {
      const target = targetSpaceId!;
      const parent = targetParentId
        ? { type: 'node' as const, id: targetParentId }
        : { type: 'root' as const, key: 'main' };
      return createSpaceTransfer(sourceSpaceId, {
        transfer_id: crypto.randomUUID(),
        target_space_id: target,
        node_id: node!.id,
        target_parent: parent,
      });
    },
    onSuccess: (res) => {
      notifications.show({
        color: 'healthyGreen',
        title: '已转移',
        message: `“${node?.title}” 已移动（${res.mapping.length} 个项目）`,
      });
      qc.invalidateQueries({ queryKey: ['spaces', sourceSpaceId, 'nodes'] });
      qc.invalidateQueries({ queryKey: ['spaces', targetSpaceId, 'nodes'] });
      close();
    },
    onError: (e: unknown) => {
      notifications.show({
        color: 'errorRed',
        title: '转移失败',
        message: e instanceof Error ? e.message : '请稍后重试',
      });
    },
  });

  const close = () => {
    setTargetSpaceId(null);
    setTargetParentId(null);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={close} title="转移到空间…" size="sm">
      <Stack gap="sm">
        <Text fz="xs" c="dimmed">
          将“{node?.title}”及其内容移动到另一个空间。服务器会在一个事务内完成移动。
        </Text>
        <Select
          label="目标空间"
          placeholder="选择空间"
          data={targetOptions}
          value={targetSpaceId}
          onChange={setTargetSpaceId}
          data-autofocus
        />
        {targetSpaceId && (
          <Select
            label="目标位置"
            placeholder="选择文件夹"
            data={folderOptions}
            value={targetParentId}
            onChange={setTargetParentId}
            searchable
            nothingFoundMessage="没有匹配的文件夹"
          />
        )}
        <Group justify="flex-end" mt="xs">
          <Button variant="subtle" onClick={close}>
            取消
          </Button>
          <Button
            loading={transfer.isPending}
            disabled={!targetSpaceId}
            onClick={() => transfer.mutate()}
          >
            转移
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

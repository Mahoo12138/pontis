import { useMemo, useState } from 'react';
import { Modal, Button, Group, Stack, Text, ScrollArea } from '@mantine/core';
import { IconFolder, IconFolderRoot } from '@tabler/icons-react';
import type { Node, ParentRef, RootSlot } from '@pontis/api';
import { listFolders } from '../../features/explorer';
import type { TreeIndex } from '../../features/explorer';
import { tokens } from '../../styles/semantic-tokens.css';

interface MoveNodesModalProps {
  opened: boolean;
  /** Rows being moved. */
  nodes: Node[];
  index: TreeIndex;
  rootSlots: RootSlot[];
  pending?: boolean;
  onClose: () => void;
  onSubmit: (parent: ParentRef, label: string) => void;
}

interface Target {
  parent: ParentRef;
  label: string;
  depth: number;
}

/**
 * Pick a folder in this space (or a root slot) as the new parent for the
 * selection. A selected folder — and everything under it — is left out of
 * the list, so a folder can never be moved inside itself.
 */
export default function MoveNodesModal({
  opened,
  nodes,
  index,
  rootSlots,
  pending,
  onClose,
  onSubmit,
}: MoveNodesModalProps) {
  const forbidden = useMemo(() => {
    const ids = new Set<string>();
    const collect = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const child of index.childrenOf(id)) collect(child.id);
    };
    for (const node of nodes) if (node.type === 'folder') collect(node.id);
    return ids;
  }, [nodes, index]);

  const targets = useMemo<Target[]>(() => {
    const folders = listFolders(index, forbidden).map(({ node, depth }) => ({
      parent: { type: 'node' as const, id: node.id },
      label: node.title,
      // Root folders sit under the root slot that holds them.
      depth: depth + 1,
    }));
    const roots = rootSlots.map((slot) => ({
      parent: { type: 'root' as const, key: slot.key },
      label: slot.display_name || '根目录',
      depth: 0,
    }));
    return [...roots, ...folders];
  }, [index, forbidden, rootSlots]);

  const [choiceKey, setChoiceKey] = useState<string | null>(null);
  const chosen = targets.find((t) => targetKey(t) === choiceKey);
  // The modal unmounts its children on close but this component outlives it,
  // so the picked target is cleared by hand.
  const reset = () => setChoiceKey(null);

  return (
    <Modal
      opened={opened}
      onClose={() => {
        reset();
        onClose();
      }}
      title={`移动 ${nodes.length} 项`}
      size={380}
    >
      <Text fz="xs" c="dimmed" mb={8}>
        选择目标文件夹：
      </Text>
      <ScrollArea.Autosize mah={300} type="auto">
        <Stack gap={0} align="stretch">
          {targets.map((target) => {
            const key = targetKey(target);
            const active = key === choiceKey;
            return (
              <button
                key={key}
                onClick={() => setChoiceKey(key)}
                aria-pressed={active}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  height: 30,
                  // Indent expresses tree depth, so the padding is the content.
                  padding: `0 8px 0 ${8 + target.depth * 14}px`,
                  fontSize: 13,
                  textAlign: 'left',
                  color: tokens.textPrimary,
                  backgroundColor: active ? tokens.selectedBg : 'transparent',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                {target.depth === 0 ? (
                  <IconFolderRoot size={14} stroke={1.5} style={{ color: tokens.textSecondary }} />
                ) : (
                  <IconFolder size={14} stroke={1.5} style={{ color: tokens.textSecondary }} />
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {target.label}
                </span>
              </button>
            );
          })}
        </Stack>
      </ScrollArea.Autosize>

      <Group justify="flex-end" mt="md">
        <Button variant="subtle" onClick={() => { reset(); onClose(); }}>
          取消
        </Button>
        <Button
          disabled={!chosen}
          loading={pending}
          onClick={() => {
            if (!chosen) return;
            onSubmit(chosen.parent, chosen.label);
          }}
        >
          移动到此处
        </Button>
      </Group>
    </Modal>
  );
}

const targetKey = (t: Target) => (t.parent.type === 'root' ? `root:${t.parent.key}` : `node:${t.parent.id}`);

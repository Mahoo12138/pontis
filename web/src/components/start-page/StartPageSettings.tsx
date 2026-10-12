import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { IconAlertCircle, IconChevronRight, IconFolder } from '@tabler/icons-react';
import { useNodes } from '../../hooks/use-nodes';
import { useSpaces } from '../../hooks/use-spaces';
import { useStartPageSnapshot } from '../../hooks/use-start-page';
import { buildTreeIndex } from '../../features/explorer/tree';
import type { Node } from '@pontis/api';
import type { StartPageConfig } from '../../features/start-page/config';
import * as styles from '../../styles/start-page.css';

interface Props {
  opened: boolean;
  onClose: () => void;
  config: StartPageConfig;
  /** Save a new source. Called only after that source has been read once, so
   * the page is never configured to show something it cannot fetch (§8.2). */
  onSelect: (source: { spaceId: string; folderId: string; folderTitle: string }) => void;
  onClear: () => void;
  onPatch: (patch: Partial<StartPageConfig>) => void;
}

/** The start page's settings for this browser: which folder it shows, how
 * entries open, how tight the grid is.
 *
 * One form, one place. The gear on the page and the entry in the workbench
 * both land here, so there is no second copy of the same state to keep in
 * step (§4.2). */
export default function StartPageSettings({ opened, onClose, config, onSelect, onClear, onPatch }: Props) {
  const spaces = useSpaces();
  const [spaceId, setSpaceId] = useState<string | undefined>(config.source?.spaceId);
  // Where the browser is looking inside the space. Empty means the space's own
  // top level, which is not a folder the page could show.
  const [browsePath, setBrowsePath] = useState<string[]>([]);
  const [picked, setPicked] = useState<{ id: string; title: string } | null>(
    config.source ? { id: config.source.folderId, title: '' } : null,
  );

  useEffect(() => {
    const first = spaces.data?.spaces[0];
    if (!spaceId && first) setSpaceId(first.id);
  }, [spaceId, spaces.data]);

  useEffect(() => {
    // A different space is a different tree: neither the path nor a folder
    // chosen in the previous one means anything here.
    setBrowsePath([]);
    setPicked(null);
  }, [spaceId]);

  const nodes = useNodes(spaceId);
  const tree = useMemo(() => (nodes.data ? buildTreeIndex(nodes.data.nodes) : null), [nodes.data]);

  const at = browsePath.length ? browsePath[browsePath.length - 1] : '';
  const level = at
    ? (tree?.childrenOf(at).filter((n) => n.type === 'folder') ?? [])
    : (tree?.roots.filter((n) => n.type === 'folder') ?? []);

  // Reading the chosen folder is the confirmation that it can be shown at
  // all. Only a snapshot that came back may be saved as the source.
  const preview = useStartPageSnapshot(picked && spaceId ? spaceId : undefined, picked?.id);

  const currentName = spaces.data?.spaces.find((s) => s.id === spaceId)?.name ?? '空间';
  const canSave = !!picked && !!spaceId && !!preview.data && !preview.isFetching && !preview.isError;

  return (
    <Modal opened={opened} onClose={onClose} title="起始页设置" size="lg" centered>
      <Stack gap="md">
        <Select
          label="来源空间"
          description="起始页只显示这一个空间里的一个文件夹；这里的选择不会创建同步绑定。"
          data={(spaces.data?.spaces ?? []).map((s) => ({ value: s.id, label: s.name }))}
          value={spaceId ?? null}
          onChange={(v) => setSpaceId(v ?? undefined)}
          disabled={spaces.isLoading}
          nothingFoundMessage={spaces.isError ? '无法读取空间列表' : '还没有空间'}
        />

        <div>
          <Text fz="xs" fw={500} mb={4}>
            来源文件夹
          </Text>
          <Group gap={4} mb="xs" style={{ flexWrap: 'wrap' }}>
            <Crumb label={`${currentName} 顶层`} strong={browsePath.length === 0} onClick={() => setBrowsePath([])} />
            {browsePath.map((id, i) => (
              <Group key={id} gap={2} wrap="nowrap">
                <IconChevronRight size={12} aria-hidden />
                <Crumb
                  label={tree?.byId.get(id)?.title ?? id}
                  strong={i === browsePath.length - 1}
                  onClick={() => setBrowsePath((prev) => prev.slice(0, i + 1))}
                />
              </Group>
            ))}
          </Group>

          <ScrollArea h={240} type="auto">
            {nodes.isLoading ? (
              <Group gap="xs" p="sm">
                <Loader size="sm" />
                {/* "This space has no folders" is a claim about the account;
                    this is a claim about a request still running (§8.2). */}
                <Text fz="sm" c="dimmed">
                  正在读取目录……
                </Text>
              </Group>
            ) : nodes.isError ? (
              <Alert icon={<IconAlertCircle size={14} />} color="errorRed" variant="light" title="无法读取目录">
                这个空间的目录没有加载出来，现在选择不了来源。
              </Alert>
            ) : level.length === 0 ? (
              <Text fz="sm" c="dimmed" p="sm">
                这一层没有子文件夹。可以选择上面「选择当前目录」那一项。
              </Text>
            ) : (
              <Stack gap={2}>
                {level.map((node: Node) => (
                  <FolderRow
                    key={node.id}
                    node={node}
                    selected={picked?.id === node.id}
                    onPick={() => setPicked({ id: node.id, title: node.title })}
                    onOpen={() => setBrowsePath((prev) => [...prev, node.id])}
                  />
                ))}
              </Stack>
            )}
          </ScrollArea>

          {/* The folder being looked at is itself a legitimate source: "show
              this folder" is the request, and a picker that only accepted
              deeper folders could not say it. */}
          {at && tree?.byId.get(at) ? (
            <Button
              variant="light"
              color="gray"
              size="xs"
              mt="xs"
              onClick={() => {
                const node = tree.byId.get(at);
                if (node) setPicked({ id: node.id, title: node.title });
              }}
            >
              选择当前目录「{tree.byId.get(at)?.title ?? ''}」
            </Button>
          ) : null}
        </div>

        {picked ? (
          preview.isError ? (
            <Alert icon={<IconAlertCircle size={14} />} color="errorRed" variant="light" title="这个目录读不出来">
              来源没有保存。可以换一个目录，或者稍后重试。
            </Alert>
          ) : preview.data ? (
            <Text fz="xs" c="dimmed">
              预览：{preview.data.source.space_name} / {preview.data.source.folder_title} ·{' '}
              {preview.data.nodes.length} 个子项
            </Text>
          ) : (
            <Text fz="xs" c="dimmed">
              正在确认这个目录……
            </Text>
          )
        ) : (
          <Text fz="xs" c="dimmed">
            尚未选择文件夹。
          </Text>
        )}

        <Divider label="显示" labelPosition="left" mt="xs" />

        <Group grow>
          <Select
            label="打开方式"
            description="也用于网页搜索结果。"
            data={[
              { value: 'current-tab', label: '当前标签页' },
              { value: 'new-tab', label: '新标签页' },
            ]}
            value={config.openTarget}
            onChange={(v) => onPatch({ openTarget: (v as StartPageConfig['openTarget']) ?? 'current-tab' })}
          />
          <Select
            label="密度"
            data={[
              { value: 'standard', label: '标准' },
              { value: 'compact', label: '紧凑' },
            ]}
            value={config.density}
            onChange={(v) => onPatch({ density: (v as StartPageConfig['density']) ?? 'standard' })}
          />
        </Group>

        <Group justify="space-between" mt="xs">
          {config.source ? (
            <Button variant="subtle" color="gray" onClick={onClear}>
              解除来源
            </Button>
          ) : (
            <span />
          )}
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              取消
            </Button>
            <Button
              disabled={!canSave}
              onClick={() => {
                if (!picked || !spaceId) return;
                onSelect({ spaceId, folderId: picked.id, folderTitle: picked.title });
              }}
            >
              保存来源
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function Crumb({ label, strong, onClick }: { label: string; strong: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={styles.crumb}
      onClick={onClick}
      style={{ fontWeight: strong ? 500 : 400 }}
    >
      {label}
    </button>
  );
}

function FolderRow({
  node,
  selected,
  onPick,
  onOpen,
}: {
  node: Node;
  selected: boolean;
  onPick: () => void;
  onOpen: () => void;
}) {
  return (
    <Group gap="xs" wrap="nowrap" pl="xs" pr="xs">
      <button
        type="button"
        onClick={onPick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: 1,
          minWidth: 0,
          padding: '6px 8px',
          borderRadius: 6,
          border: 'none',
          background: selected ? 'var(--mantine-color-accentBlue-0)' : 'transparent',
          color: 'inherit',
          fontSize: 14,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <IconFolder size={16} aria-hidden />
        <Text fz="sm" truncate>
          {node.title}
        </Text>
      </button>
      <Button variant="subtle" size="compact-xs" onClick={onOpen} aria-label={`进入 ${node.title}`}>
        进入
      </Button>
    </Group>
  );
}

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Group,
  Modal,
  NativeSelect,
  Radio,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ApplyPublicationRequest, ApplyPublicationResponse, PublicationSummary } from '@pontis/api';
import { previewApplyPublication } from '@pontis/api/endpoints/plaza';
import { useApplyPublication } from '../../hooks/use-plaza';
import { useNodes, useRootSlots } from '../../hooks/use-nodes';
import { useSpaces } from '../../hooks/use-spaces';
import { tokens } from '../../styles/semantic-tokens.css';

/**
 * Consumer apply flow: choose target space + location + strategy, then copy
 * the publication snapshot into the space. The impact is previewable because
 * the server runs the real copy and rolls it back, so the counts are not a
 * second guess at what the apply will do.
 */
export default function ImportModal({
  publication,
  opened,
  onClose,
}: {
  publication: PublicationSummary | null;
  opened: boolean;
  onClose: () => void;
}) {
  const apply = useApplyPublication();
  const { data: spacesData } = useSpaces();
  const spaces = spacesData?.spaces ?? [];

  const [spaceId, setSpaceId] = useState('');
  const [location, setLocation] = useState<string>('root:');
  const [strategy, setStrategy] = useState<'merge' | 'replace'>('merge');
  const [preview, setPreview] = useState<ApplyPublicationResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (opened) {
      setSpaceId(spaces[0]?.id ?? '');
      setLocation('root:');
      setStrategy('merge');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const { data: rootSlots } = useRootSlots(spaceId || undefined);
  const { data: nodesData } = useNodes(spaceId || undefined);

  const locationOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const slot of rootSlots?.root_slots ?? []) {
      opts.push({ value: `root:${slot.key}`, label: `根目录 / ${slot.display_name}` });
    }
    for (const node of nodesData?.nodes ?? []) {
      if (node.type === 'folder') {
        opts.push({ value: `node:${node.id}`, label: node.title });
      }
    }
    return opts;
  }, [rootSlots, nodesData]);

  // Switching space resets the location to a placeholder that is not one of
  // these options, and sending it asks the server for a root slot that does
  // not exist. Keep the selection pointing at a location the space has.
  useEffect(() => {
    const first = locationOptions[0];
    if (first && !locationOptions.some((o) => o.value === location)) {
      setLocation(first.value);
    }
  }, [locationOptions, location]);

  // Any change to where or how the copy would land invalidates a preview that
  // described a different target.
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
  }, [spaceId, location, strategy]);

  if (!publication) return null;

  const targetLabel =
    locationOptions.find((o) => o.value === location)?.label ?? '所选位置';

  const requestParams = (): ApplyPublicationRequest => {
    const [type, key] = location.split(':');
    return {
      space_id: spaceId,
      parent: type === 'node' ? { type: 'node', id: key } : { type: 'root', key: key || undefined },
      strategy,
    };
  };

  const handlePreview = () => {
    if (!spaceId) return;
    setPreviewing(true);
    setPreviewError(null);
    previewApplyPublication(publication.id, requestParams())
      .then(setPreview)
      .catch((e: unknown) =>
        setPreviewError(e instanceof Error ? e.message : '预览失败'),
      )
      .finally(() => setPreviewing(false));
  };

  const handleApply = () => {
    if (!spaceId) return;
    apply.mutate(
      {
        id: publication.id,
        params: requestParams(),
      },
      {
        onSuccess: (res) => {
          notifications.show({
            title: `已导入「${publication.title}」`,
            message: `新建 ${res.created} 项 · 更新 ${res.updated} 项 · 保留 ${res.kept} 项`,
            color: 'coolGray',
          });
          onClose();
        },
        onError: (e) =>
          notifications.show({
            message: e instanceof Error ? e.message : '导入失败',
            color: 'errorRed',
          }),
      },
    );
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`导入「${publication.title}」`}
      size={480}
      styles={{ header: { fontSize: 15, fontWeight: 600 } }}
    >
      <Stack gap="sm">
        <NativeSelect
          label="目标空间"
          data={spaces.map((s) => ({ value: s.id, label: s.name }))}
          value={spaceId}
          onChange={(e) => setSpaceId(e.currentTarget.value)}
        />
        <NativeSelect
          label="目标位置"
          data={locationOptions.map((o) => ({ value: o.value, label: o.label }))}
          value={location}
          onChange={(e) => setLocation(e.currentTarget.value)}
        />
        <Radio.Group
          label="导入方式"
          value={strategy}
          onChange={(v) => setStrategy(v as 'merge' | 'replace')}
        >
          <Group gap="lg" mt={6}>
            <Radio value="merge" label="合并" />
            <Radio value="replace" label="替换" />
          </Group>
        </Radio.Group>
        {strategy === 'merge' ? (
          <Text fz={12} c="dimmed">
            之前从这里导入过的内容会被认出来:缺失的新建,发布里改过标题或链接的会更新,其余保持不动。
          </Text>
        ) : (
          <Group gap={6} align="flex-start" wrap="nowrap"
            style={{
              padding: '8px 10px',
              backgroundColor: 'var(--mantine-color-recoveryOrange-light)',
              borderRadius: 6,
            }}
          >
            <IconAlertTriangle size={15} stroke={1.5} style={{ color: tokens.syncRecovery, flexShrink: 0, marginTop: 1 }} />
            <Text fz={12}>
              「{targetLabel}」中现有的内容将被替换为该发布的内容。这一步作为一个整体记入活动,可在最近活动中撤销。
            </Text>
          </Group>
        )}
        <Group gap="sm" align="center" wrap="nowrap">
          <Button
            size="compact-xs"
            variant="default"
            onClick={handlePreview}
            loading={previewing}
            disabled={locationOptions.length === 0}
          >
            预览影响
          </Button>
          {previewError && <Text fz={12} c="errorRed">{previewError}</Text>}
          {preview && (
            <Text fz={12} c="dimmed">
              预计新建 {preview.created} 项 · 更新 {preview.updated} 项 · 保留 {preview.kept} 项
            </Text>
          )}
        </Group>
        <Group justify="flex-end" mt="xs">
          <Button variant="subtle" color="coolGray" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleApply} loading={apply.isPending} disabled={locationOptions.length === 0}>
            {strategy === 'merge' ? '合并导入' : '替换导入'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

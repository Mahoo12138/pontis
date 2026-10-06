import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  FileButton,
  Group,
  Modal,
  NativeSelect,
  Radio,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconFileImport } from '@tabler/icons-react';
import type {
  ImportEntryAction,
  ImportFormat,
  ImportPlan,
} from '@pontis/api';
import { useImportApply, useImportPreview } from '../../hooks/use-transfer';
import { useNodes, useRootSlots } from '../../hooks/use-nodes';
import { useSpaces } from '../../hooks/use-spaces';
import { tokens } from '../../styles/semantic-tokens.css';
import { mono } from '../../styles/management.css';

const ACTION_META: Record<ImportEntryAction, { label: string; color: string }> = {
  create: { label: '新建', color: 'healthyGreen' },
  update: { label: '更新', color: 'accentBlue' },
  move: { label: '移动', color: 'accentBlue' },
  delete: { label: '删除', color: 'errorRed' },
  keep: { label: '保留', color: 'coolGray' },
  ambiguous: { label: '不明确', color: 'warningAmber' },
  unsupported: { label: '不支持', color: 'coolGray' },
};

/**
 * Import is always Parse → Validate → Plan → Preview before anything is
 * written (docs/11 §8). The plan is bound to the target revision; a stale
 * plan would be rejected and require re-preview.
 */
export default function ImportModal({
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
  const preview = useImportPreview(spaceId);
  const apply = useImportApply(spaceId);
  const { data: spacesData } = useSpaces();
  const { data: rootSlots } = useRootSlots(spaceId);
  const { data: nodesData } = useNodes(spaceId);

  const [format, setFormat] = useState<ImportFormat>('netscape_html');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('@sample');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [location, setLocation] = useState('root:');
  const [strategy, setStrategy] = useState<'merge' | 'replace'>('merge');
  const fileRef = useRef<number>(0);

  useEffect(() => {
    if (opened) {
      setFormat('netscape_html');
      setFileName(null);
      setFileContent('@sample');
      setPlan(null);
      setLocation('root:');
      setStrategy('merge');
      preview.reset();
      apply.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const locationOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const slot of rootSlots?.root_slots ?? []) {
      opts.push({ value: `root:${slot.key}`, label: `根目录 / ${slot.display_name}` });
    }
    if (opts.length === 0) opts.push({ value: 'root:', label: '空间根目录' });
    for (const node of nodesData?.nodes ?? []) {
      if (node.type === 'folder') opts.push({ value: `node:${node.id}`, label: node.title });
    }
    return opts;
  }, [rootSlots, nodesData]);

  const runPreview = (content: string, name: string | null, fmt: ImportFormat) => {
    setFileContent(content);
    setFileName(name);
    preview.mutate(
      { format: fmt, content },
      { onSuccess: (p) => setPlan(p) },
    );
  };

  const handleConfirm = () => {
    if (!plan) return;
    const [type, key] = location.split(':');
    apply.mutate(
      {
        plan_id: plan.plan_id,
        parent: type === 'node' ? { type: 'node', id: key } : { type: 'root', key: key || undefined },
        strategy,
      },
      {
        onSuccess: (res) => {
          notifications.show({
            title: `已导入到「${spaceName}」`,
            message: `新建 ${res.created} · 更新 ${res.updated} · 删除 ${res.deleted} · 保留 ${res.kept}`,
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

  const locationLabel = locationOptions.find((o) => o.value === location)?.label ?? '所选位置';

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={plan ? `导入预览 — ${spaceName}` : `导入书签 — ${spaceName}`}
      size={plan ? 640 : 480}
      styles={{ header: { fontSize: 15, fontWeight: 600 } }}
    >
      {!plan ? (
        <Stack gap="sm">
          <SegmentedControl
            size="xs"
            value={format}
            onChange={(v) => setFormat(v as ImportFormat)}
            data={[
              { label: 'Netscape HTML', value: 'netscape_html' },
              { label: 'Native JSON', value: 'native_json' },
            ]}
            styles={{ root: { backgroundColor: tokens.hoverBg } }}
          />
          <Text fz={12} c="dimmed">
            导入会先解析并生成预览,确认后才会写入。外部文件中的 ID 不会作为系统标识。
          </Text>
          <Group gap="sm" align="center">
            <FileButton
              key={fileRef.current}
              onChange={(file) => {
                if (!file) return;
                file.text().then((text) => runPreview(text, file.name, format));
              }}
              accept={format === 'netscape_html' ? '.html,.htm' : '.json'}
            >
              {(props) => (
                <Button variant="default" size="xs" leftSection={<IconFileImport size={14} stroke={1.5} />} {...props}>
                  选择文件
                </Button>
              )}
            </FileButton>
            <Button
              variant="subtle"
              color="coolGray"
              size="compact-xs"
              loading={preview.isPending}
              onClick={() => runPreview('@sample', null, format)}
            >
              使用示例内容预览
            </Button>
          </Group>
          {fileName && (
            <Text fz={12} c="dimmed">已选择:{fileName}</Text>
          )}
          {preview.isError && (
            <Text fz={12} c="errorRed">
              文件解析失败:{preview.error instanceof Error ? preview.error.message : '未知错误'}
            </Text>
          )}
        </Stack>
      ) : (
        <Stack gap="sm">
          <Group gap={6}>
            {(['create', 'update', 'move', 'delete', 'keep', 'ambiguous', 'unsupported'] as ImportEntryAction[])
              .filter((a) => plan.counts[a] > 0)
              .map((action) => (
                <Badge key={action} variant="light" color={ACTION_META[action].color} styles={{ root: { fontWeight: 400 } }}>
                  {ACTION_META[action].label} {plan.counts[action]}
                </Badge>
              ))}
            <span style={{ flex: 1 }} />
            <span className={mono} style={{ color: tokens.textSecondary }}>共 {plan.total} 项</span>
          </Group>

          {plan.warnings.map((w) => (
            <Group key={w} gap={6} align="flex-start" wrap="nowrap"
              style={{ padding: '7px 10px', backgroundColor: 'var(--mantine-color-warningAmber-light)', borderRadius: 6 }}
            >
              <IconAlertTriangle size={14} stroke={1.5} style={{ color: tokens.syncWarning, flexShrink: 0, marginTop: 2 }} />
              <Text fz={12}>{w}</Text>
            </Group>
          ))}

          <div
            style={{
              border: `1px solid ${tokens.subtleBorder}`,
              borderRadius: 6,
              maxHeight: 240,
              overflowY: 'auto',
            }}
          >
            {plan.entries.map((entry, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  borderBottom: i < plan.entries.length - 1 ? `1px solid ${tokens.subtleBorder}` : 'none',
                }}
              >
                <span style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 0 180px' }}>
                  {entry.title}
                </span>
                <span style={{ fontSize: 12, color: tokens.textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.path}
                </span>
                <Badge size="xs" variant="light" color={ACTION_META[entry.action].color} styles={{ root: { fontWeight: 400 } }}>
                  {ACTION_META[entry.action].label}
                </Badge>
                {entry.reason && (
                  <span style={{ fontSize: 11, color: tokens.textDisabled, flex: '0 0 150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.reason}
                  </span>
                )}
              </div>
            ))}
          </div>
          <Text fz={11} c="dimmed">
            显示前 {plan.entries.length} 项(共 {plan.total} 项)。预览绑定于当前修订,确认前如有变化将要求重新预览。
          </Text>

          <NativeSelect
            label="目标位置"
            data={locationOptions.map((o) => ({ value: o.value, label: o.label }))}
            value={location}
            onChange={(e) => setLocation(e.currentTarget.value)}
          />
          <Radio.Group label="导入方式" value={strategy} onChange={(v) => setStrategy(v as 'merge' | 'replace')}>
            <Group gap="lg" mt={6}>
              <Radio value="merge" label="合并(保留现有)" />
              <Radio value="replace" label="替换(清空后写入)" />
            </Group>
          </Radio.Group>
          {strategy === 'replace' && (
            <Text fz={12} style={{ color: tokens.syncRecovery }}>
              「{locationLabel}」的现有内容将被替换,服务器会先自动创建安全备份。
            </Text>
          )}

          <Group justify="flex-end" mt="xs">
            <Button variant="subtle" color="coolGray" onClick={() => setPlan(null)}>
              重新选择文件
            </Button>
            <Button onClick={handleConfirm} loading={apply.isPending}>
              {strategy === 'merge' ? '确认导入' : '确认替换导入'}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

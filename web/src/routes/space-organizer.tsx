import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  SegmentedControl,
  Skeleton,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconLink,
  IconLoader2,
  IconRefresh,
  IconStack2,
  IconTrash,
} from '@tabler/icons-react';
import type { LinkCheckResult, LinkStatusClass } from '@pontis/api';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import { contentRegion } from '../styles/app-shell.css';
import { pagePad, mono } from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import { useSpaces } from '../hooks/use-spaces';
import { useNodeCrud } from '../hooks/use-node-crud';
import {
  useDuplicates,
  useLinkCheckResults,
  useLinkCheckRun,
} from '../hooks/use-organizer';
import { extractHost } from '../lib/format';

type OrganizerTab = 'links' | 'duplicates';

const STATUS_META: Record<LinkStatusClass, { label: string; color: string }> = {
  ok_2xx: { label: '正常', color: 'healthyGreen' },
  client_4xx: { label: '客户端错误', color: 'warningAmber' },
  server_5xx: { label: '服务器错误', color: 'errorRed' },
  timeout: { label: '超时', color: 'warningAmber' },
  network_error: { label: '网络错误', color: 'errorRed' },
};

export default function SpaceOrganizerPage() {
  const { spaceId } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<OrganizerTab>('links');

  const { data: spacesData } = useSpaces();
  const spaceName = spacesData?.spaces?.find((s) => s.id === spaceId)?.name ?? '空间';

  return (
    <>
      <Header breadcrumb={`${spaceName} / 整理`} />
      <div className={`${contentRegion} ${pagePad}`}>
        <Group gap="xs" mb="md">
          <Button
            variant="subtle"
            color="coolGray"
            size="compact-sm"
            leftSection={<IconArrowLeft size={14} stroke={1.5} />}
            onClick={() => navigate(`/spaces/${spaceId}`)}
          >
            返回空间
          </Button>
          <SegmentedControl
            size="xs"
            value={tab}
            onChange={(v) => setTab(v as OrganizerTab)}
            data={[
              { label: '失效链接', value: 'links' },
              { label: '重复书签', value: 'duplicates' },
            ]}
            styles={{ root: { backgroundColor: tokens.hoverBg } }}
          />
        </Group>

        {tab === 'links' ? (
          <LinkHealthPanel spaceId={spaceId} />
        ) : (
          <DuplicatesPanel spaceId={spaceId} />
        )}
      </div>
    </>
  );
}

// ─── Link health ─────────────────────────────────────────────

function LinkHealthPanel({ spaceId }: { spaceId: string | undefined }) {
  const run = useLinkCheckRun(spaceId);
  const crud = useNodeCrud(spaceId);
  const [hasRun, setHasRun] = useState(false);
  const { data, isLoading, isError, refetch } = useLinkCheckResults(spaceId, hasRun);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const results = data?.results ?? [];
  const problems = useMemo(
    () => results.filter((r) => r.status_class !== 'ok_2xx'),
    [results],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleStart = () => {
    run.mutate(undefined, {
      onSuccess: () => setHasRun(true),
    });
  };

  const handleDelete = () => {
    crud.remove.mutate([...selected], {
      onSuccess: () => {
        setConfirmOpen(false);
        setSelected(new Set());
        notifications.show({
          message: `已删除 ${selected.size} 个失效书签,30 天内可撤销`,
          color: 'coolGray',
        });
        void refetch();
      },
    });
  };

  if (!hasRun) {
    return (
      <EmptyCheck onStart={handleStart} starting={run.isPending} />
    );
  }

  if (isError) {
    return <ErrorState onRetry={() => void refetch()} />;
  }

  return (
    <div>
      <Group justify="space-between" mb="sm">
        <Text fz={13} c="dimmed">
          {isLoading
            ? '检查中…'
            : `发现 ${problems.length} 个问题链接(共检查 ${results.length} 个书签)。`}
        </Text>
        <Group gap="sm">
          {selected.size > 0 && (
            <Button
              size="xs"
              color="errorRed"
              variant="light"
              leftSection={<IconTrash size={14} stroke={1.5} />}
              onClick={() => setConfirmOpen(true)}
            >
              删除所选({selected.size})
            </Button>
          )}
          <Tooltip label="重新检查">
            <UnstyledButton
              aria-label="重新检查"
              onClick={handleStart}
              style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 4 }}
            >
              <IconRefresh size={15} stroke={1.5} />
            </UnstyledButton>
          </Tooltip>
        </Group>
      </Group>

      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={38} />
          ))}
        </div>
      ) : (
        <div
          style={{
            border: `1px solid ${tokens.subtleBorder}`,
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {problems.map((result, i) => (
            <CheckRow
              key={result.node_id}
              result={result}
              checked={selected.has(result.node_id)}
              onToggle={() => toggle(result.node_id)}
              withBorder={i < problems.length - 1}
            />
          ))}
          {problems.length === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                padding: '40px 0',
                color: tokens.textSecondary,
              }}
            >
              <IconCheck size={28} stroke={1.2} style={{ color: tokens.syncHealthy }} />
              <Text fz="sm">所有链接都可以正常访问</Text>
            </div>
          )}
        </div>
      )}

      <Modal
        opened={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`删除 ${selected.size} 个失效书签?`}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          这些书签无法访问将被移除。这个操作可以在 30 天内撤销,对应空间的同步历史会记录本次变更。
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setConfirmOpen(false)}>
            取消
          </Button>
          <Button color="errorRed" loading={crud.remove.isPending} onClick={handleDelete}>
            删除
          </Button>
        </Group>
      </Modal>
    </div>
  );
}

function CheckRow({
  result,
  checked,
  onToggle,
  withBorder,
}: {
  result: LinkCheckResult;
  checked: boolean;
  onToggle: () => void;
  withBorder: boolean;
}) {
  const meta = STATUS_META[result.status_class];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 38,
        padding: '0 12px',
        borderBottom: withBorder ? `1px solid ${tokens.subtleBorder}` : 'none',
        backgroundColor: checked ? tokens.selectedBg : undefined,
      }}
    >
      <Checkbox
        size="xs"
        checked={checked}
        onChange={onToggle}
        aria-label={`选择 ${result.title}`}
        styles={{ root: { flexShrink: 0 } }}
      />
      <Text fz={13} style={{ flex: '0 0 200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {result.title}
      </Text>
      <Text fz={12} c="dimmed" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {extractHost(result.checked_url)}
      </Text>
      <Badge size="sm" variant="light" color={meta.color} styles={{ root: { fontWeight: 400 } }}>
        {meta.label}
        {result.http_status ? ` ${result.http_status}` : ''}
      </Badge>
      <span className={mono} style={{ width: 70, textAlign: 'right', color: tokens.textSecondary, flexShrink: 0 }}>
        {result.latency_ms >= 1000 ? `${(result.latency_ms / 1000).toFixed(1)}s` : `${result.latency_ms}ms`}
      </span>
    </div>
  );
}

function EmptyCheck({ onStart, starting }: { onStart: () => void; starting: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 240,
        color: tokens.textSecondary,
        gap: 8,
      }}
    >
      <IconLink size={30} stroke={1.2} />
      <Text fz="sm">检查空间内所有书签的可达性</Text>
      <Text fz="xs" c="dimmed">
        检查在服务器后台运行,不会修改任何书签;结果仅作为整理参考。
      </Text>
      <Button
        size="compact-sm"
        variant="subtle"
        mt={4}
        leftSection={starting ? <IconLoader2 size={14} className="animate-spin" /> : <IconLink size={14} stroke={1.5} />}
        onClick={onStart}
        loading={starting}
      >
        开始检查
      </Button>
    </div>
  );
}

// ─── Duplicates ──────────────────────────────────────────────

function DuplicatesPanel({ spaceId }: { spaceId: string | undefined }) {
  const { data, isLoading, isError, refetch } = useDuplicates(spaceId);
  const crud = useNodeCrud(spaceId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  const groups = data?.groups ?? [];

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDelete = () => {
    if (!pendingDelete) return;
    crud.remove.mutate(pendingDelete, {
      onSuccess: () => {
        setPendingDelete(null);
        notifications.show({
          message: `已删除 ${pendingDelete.length} 个重复书签,30 天内可撤销`,
          color: 'coolGray',
        });
        void refetch();
      },
    });
  };

  if (isError) {
    return <ErrorState onRetry={() => void refetch()} />;
  }

  if (isLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} height={80} radius={8} />
        ))}
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 240,
          color: tokens.textSecondary,
          gap: 8,
        }}
      >
        <IconCheck size={28} stroke={1.2} style={{ color: tokens.syncHealthy }} />
        <Text fz="sm">没有发现重复书签</Text>
        <Text fz="xs" c="dimmed">
          完全相同的 URL 会列为重复;仅参数或斜杠不同的会列为疑似重复。
        </Text>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 900 }}>
      <Text fz={12} c="dimmed">
        {groups.length} 组重复。位置可能是有意分开的,删除前请确认。
      </Text>
      {groups.map((group) => {
        const isOpen = expanded.has(group.id);
        const dupCount = group.items.length - 1;
        return (
          <div
            key={group.id}
            style={{
              border: `1px solid ${tokens.subtleBorder}`,
              borderRadius: 8,
              backgroundColor: tokens.workspaceBg,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
              }}
            >
              <UnstyledButton
                onClick={() => toggle(group.id)}
                aria-expanded={isOpen}
                aria-label={isOpen ? '收起' : '展开'}
                style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 2 }}
              >
                {isOpen ? <IconChevronDown size={14} stroke={1.7} /> : <IconChevronRight size={14} stroke={1.7} />}
              </UnstyledButton>
              <Badge
                size="sm"
                variant="light"
                color={group.kind === 'exact' ? 'warningAmber' : 'coolGray'}
                styles={{ root: { fontWeight: 400 } }}
              >
                {group.kind === 'exact' ? '完全相同' : '疑似重复'}
              </Badge>
              <IconStack2 size={14} stroke={1.5} style={{ color: tokens.textSecondary }} />
              <Text fz={13} truncate style={{ flex: 1 }}>
                {extractHost(group.items[0]?.url ?? '')}
                {group.reason && (
                  <span style={{ color: tokens.textSecondary, fontSize: 12 }}> · {group.reason}</span>
                )}
              </Text>
              <Text fz={12} c="dimmed">
                {group.items.length} 项
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                color="errorRed"
                onClick={() =>
                  setPendingDelete(group.items.slice(1).map((i) => i.node_id))
                }
              >
                保留第一项,删除 {dupCount} 项
              </Button>
            </div>
            {isOpen &&
              group.items.map((item) => (
                <div
                  key={item.node_id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '7px 14px 7px 40px',
                    borderTop: `1px solid ${tokens.subtleBorder}`,
                  }}
                >
                  <Text fz={13} style={{ flex: '0 0 180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.title}
                  </Text>
                  <span className={mono} style={{ color: tokens.textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.url}
                  </span>
                  <Text fz={12} c="dimmed" style={{ flexShrink: 0 }}>
                    {item.path}
                  </Text>
                  <Tooltip label="仅删除这一项">
                    <UnstyledButton
                      aria-label={`删除 ${item.title}`}
                      onClick={() => setPendingDelete([item.node_id])}
                      style={{ color: tokens.textSecondary, display: 'inline-flex', padding: 4 }}
                    >
                      <IconTrash size={14} stroke={1.5} />
                    </UnstyledButton>
                  </Tooltip>
                </div>
              ))}
          </div>
        );
      })}

      <Modal
        opened={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={`删除 ${pendingDelete?.length ?? 0} 个重复书签?`}
        size={420}
        styles={{ header: { fontSize: 15, fontWeight: 600 } }}
      >
        <Text fz={13}>
          将保留每组中的第一个书签,移除所选的重复项。这个操作可以在 30 天内撤销。
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="subtle" color="coolGray" onClick={() => setPendingDelete(null)}>
            取消
          </Button>
          <Button color="errorRed" loading={crud.remove.isPending} onClick={handleDelete}>
            删除
          </Button>
        </Group>
      </Modal>
    </div>
  );
}

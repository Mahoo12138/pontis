import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { Group, SegmentedControl, Skeleton, Text, TextInput, Badge } from '@mantine/core';
import { IconSearch, IconFolder, IconBookmark } from '@tabler/icons-react';
import type { Node } from '@pontis/api';
import { listNodes } from '@pontis/api/endpoints/nodes';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import { contentRegion } from '../styles/app-shell.css';
import { explorerContainer, explorerRow, explorerRowTitle } from '../styles/explorer.css';
import { tokens } from '../styles/semantic-tokens.css';
import { extractHost, formatShortTime } from '../lib/format';
import { useSpaces } from '../hooks/use-spaces';
import { requestFocusNode } from '../components/command-palette/CommandPalette';

type SearchType = 'all' | 'bookmark' | 'folder';

interface Hit {
  node: Node;
  spaceName: string;
}

export default function SearchPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const [type, setType] = useState<SearchType>('all');

  const { data: spacesData } = useSpaces();
  const spaces = spacesData?.spaces ?? [];

  // One node query per space; keys match useNodes so caches stay shared.
  const nodeQueries = useQueries({
    queries: spaces.map((s) => ({
      queryKey: ['spaces', s.id, 'nodes'],
      queryFn: () => listNodes(s.id),
      staleTime: 30_000,
    })),
  });
  const isLoading = nodeQueries.some((r) => r.isLoading);
  const isError = nodeQueries.some((r) => r.isError);

  const hits = useMemo<Hit[]>(() => {
    if (!q) return [];
    const out: Hit[] = [];
    spaces.forEach((space, i) => {
      const nodes = nodeQueries[i]?.data?.nodes ?? [];
      for (const node of nodes) {
        if (type !== 'all' && node.type !== type) continue;
        const inTitle = node.title.toLowerCase().includes(q);
        const inUrl = (node.url ?? '').toLowerCase().includes(q);
        if (inTitle || inUrl) out.push({ node, spaceName: space.name });
      }
    });
    return out;
  }, [q, type, spaces, nodeQueries]);

  // The target explorer may mount after this event fires; the pending
  // handoff covers that, the event covers same-space navigation.
  const openHit = (hit: Hit) => {
    requestFocusNode(hit.node.id);
    navigate(`/spaces/${hit.node.space_id}`);
  };

  return (
    <>
      <Header breadcrumb="搜索" />
      <div className={contentRegion} style={{ padding: '16px 24px' }}>
        <Group gap="sm" align="flex-start" style={{ marginBottom: 16 }}>
          <TextInput
            autoFocus
            value={params.get('q') ?? ''}
            placeholder="在所有空间中搜索…"
            leftSection={<IconSearch size={14} stroke={1.5} />}
            w={360}
            onChange={(e) => setParams({ q: e.currentTarget.value }, { replace: true })}
            styles={{ input: { height: '34px', fontSize: '13px' } }}
          />
          <SegmentedControl
            size="xs"
            value={type}
            onChange={(v) => setType(v as SearchType)}
            data={[
              { label: '全部', value: 'all' },
              { label: '书签', value: 'bookmark' },
              { label: '文件夹', value: 'folder' },
            ]}
            styles={{ root: { backgroundColor: tokens.hoverBg } }}
          />
        </Group>

        {isError ? (
          <ErrorState onRetry={() => void Promise.all(nodeQueries.map((r) => r.refetch()))} />
        ) : isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={38} />
            ))}
          </div>
        ) : !q ? (
          <EmptyHint
            icon={<IconSearch size={32} stroke={1.2} />}
            title="搜索所有空间"
            body="输入关键词，匹配书签标题与链接。"
          />
        ) : hits.length === 0 ? (
          <EmptyHint
            icon={<IconSearch size={32} stroke={1.2} />}
            title="没有匹配结果"
            body={`“${params.get('q') ?? ''}” 未在任何空间中找到。`}
          />
        ) : (
          <div
            className={explorerContainer}
            style={{ border: `1px solid ${tokens.subtleBorder}`, borderRadius: 8 }}
          >
            <Text fz="xs" c="dimmed" style={{ padding: '10px 16px 6px' }}>
              {hits.length} 个结果
            </Text>
            {hits.map(({ node, spaceName }) => (
              <div
                key={node.id}
                className={explorerRow}
                role="button"
                tabIndex={0}
                onClick={() => openHit({ node, spaceName })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openHit({ node, spaceName });
                }}
                style={{ cursor: 'pointer' }}
              >
                {node.type === 'folder' ? (
                  <IconFolder size={16} stroke={1.5} style={{ color: tokens.textSecondary, flexShrink: 0 }} />
                ) : (
                  <IconBookmark size={16} stroke={1.5} style={{ color: tokens.textSecondary, flexShrink: 0 }} />
                )}
                <span className={explorerRowTitle}>{node.title}</span>
                {node.type === 'bookmark' && (
                  <span style={{ width: 200, flexShrink: 0, fontSize: 12, color: tokens.textSecondary }}>
                    {extractHost(node.url ?? '')}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <Badge variant="light" color="coolGray" styles={{ root: { fontWeight: 400 } }}>
                  {spaceName}
                </Badge>
                <span style={{ width: 60, textAlign: 'right', fontSize: 12, color: tokens.textSecondary }}>
                  {formatShortTime(node.updated_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function EmptyHint({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '60%',
        color: tokens.textSecondary,
        gap: 8,
      }}
    >
      {icon}
      <Text fz="sm">{title}</Text>
      <Text fz="xs" c="dimmed">{body}</Text>
    </div>
  );
}

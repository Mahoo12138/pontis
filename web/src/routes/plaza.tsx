import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Group,
  NativeSelect,
  SegmentedControl,
  Skeleton,
  Text,
  TextInput,
} from '@mantine/core';
import { IconSearch, IconPlus } from '@tabler/icons-react';
import type { PlazaSort, PublicationSummary } from '@pontis/api';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import PublishModal from '../components/plaza/PublishModal';
import { contentRegion } from '../styles/app-shell.css';
import { pagePad } from '../styles/management.css';
import { plazaGrid, pubCard, pubCardTitle, pubCardMeta, pubTag } from '../styles/plaza.css';
import { tokens } from '../styles/semantic-tokens.css';
import { usePlazaFacets, usePlazaPublications } from '../hooks/use-plaza';
import { useSpaces } from '../hooks/use-spaces';
import { formatRelativeTime } from '../lib/format';

type PlazaTab = 'all' | 'mine';

export default function PlazaPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const publisher = params.get('publisher') ?? '';
  const sort = (params.get('sort') || 'updated') as PlazaSort;
  const [tab, setTab] = useState<PlazaTab>('all');
  const [publishOpen, setPublishOpen] = useState(false);
  const [draft, setDraft] = useState(q);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  // The field keeps what the user typed and the request follows 300ms later:
  // typing out a long query must not fire one search per keystroke.
  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (draft === q) return;
    const timer = setTimeout(() => setParam('q', draft), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, q]);

  const { data: spacesData } = useSpaces();
  const spaces = spacesData?.spaces ?? [];
  const { data: facets } = usePlazaFacets();

  const search = useMemo(
    () => ({
      q: q || undefined,
      tag: tag || undefined,
      publisher: publisher || undefined,
      sort,
      mine: tab === 'mine' || undefined,
    }),
    [q, tag, publisher, sort, tab],
  );
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = usePlazaPublications(search);

  const publications = data?.pages.flatMap((page) => page.publications) ?? [];
  const total = data?.pages[data.pages.length - 1]?.total ?? 0;
  const filtered = !!(q || tag || publisher);

  return (
    <>
      <Header
        breadcrumb="广场"
        primaryAction={{ label: '发布', icon: <IconPlus size={14} stroke={1.5} />, onClick: () => setPublishOpen(true) }}
      />
      <div className={`${contentRegion} ${pagePad}`}>
        <Group gap="sm" mb={12} wrap="nowrap">
          <TextInput
            value={draft}
            placeholder="搜索标题、描述、标签、作者,或发布里的书签…"
            leftSection={<IconSearch size={14} stroke={1.5} />}
            w={360}
            onChange={(e) => setDraft(e.currentTarget.value)}
            styles={{ input: { height: '34px', fontSize: '13px' } }}
          />
          <SegmentedControl
            size="xs"
            value={tab}
            onChange={(v) => setTab(v as PlazaTab)}
            data={[
              { label: '全部', value: 'all' },
              { label: '我的发布', value: 'mine' },
            ]}
            styles={{ root: { backgroundColor: tokens.hoverBg } }}
          />
        </Group>

        <Group gap="sm" mb={16} wrap="nowrap">
          <NativeSelect
            size="xs"
            w={150}
            value={tag}
            onChange={(e) => setParam('tag', e.currentTarget.value)}
            data={[
              { value: '', label: '全部标签' },
              ...(facets?.tags ?? []).map((t) => ({ value: t, label: t })),
            ]}
          />
          <NativeSelect
            size="xs"
            w={150}
            value={publisher}
            onChange={(e) => setParam('publisher', e.currentTarget.value)}
            data={[
              { value: '', label: '全部作者' },
              ...(facets?.publishers ?? []).map((p) => ({ value: p, label: p })),
            ]}
          />
          <NativeSelect
            size="xs"
            w={130}
            value={sort}
            onChange={(e) => setParam('sort', e.currentTarget.value)}
            data={[
              { value: 'updated', label: '最近更新' },
              { value: 'published', label: '最新发布' },
              { value: 'title', label: '按标题' },
            ]}
          />
          {filtered && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="coolGray"
              onClick={() => {
                setDraft('');
                setParams(tab === 'mine' ? { mine: '1' } : {});
              }}
            >
              清除筛选
            </Button>
          )}
          <Text fz={12} c="dimmed">
            {isLoading ? '加载中…' : `${publications.length} / ${total}`}
          </Text>
        </Group>

        {isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <div className={plazaGrid}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={118} radius={8} />
            ))}
          </div>
        ) : publications.length === 0 ? (
          <EmptyPlaza hasQuery={filtered} onPublish={() => setPublishOpen(true)} />
        ) : (
          <>
            <div className={plazaGrid}>
              {publications.map((pub) => (
                <PublicationCard key={pub.id} pub={pub} onClick={() => navigate(`/plaza/${pub.id}`)} />
              ))}
            </div>
            {hasNextPage && (
              <Group justify="center" mt="md">
                <Button
                  size="compact-sm"
                  variant="default"
                  loading={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  加载更多（还有 {Math.max(total - publications.length, 0)} 条）
                </Button>
              </Group>
            )}
          </>
        )}
      </div>

      <PublishModal
        opened={publishOpen}
        onClose={() => setPublishOpen(false)}
        spaces={spaces}
        onPublished={() => setTab('mine')}
      />
    </>
  );
}

function PublicationCard({ pub, onClick }: { pub: PublicationSummary; onClick: () => void }) {
  return (
    <button className={pubCard} onClick={onClick} aria-label={`查看发布 ${pub.title}`}>
      <Group justify="space-between" gap={8}>
        <span className={pubCardTitle}>{pub.title}</span>
        {pub.visibility === 'private' && (
          <Badge variant="light" color="coolGray" styles={{ root: { fontWeight: 400 } }}>
            私有
          </Badge>
        )}
      </Group>
      <span className={pubCardMeta}>{pub.publisher}</span>
      <span className={pubCardMeta}>
        {pub.bookmark_count} 个书签 · {pub.folder_count} 个文件夹
      </span>
      {pub.matches && pub.matches.length > 0 && (
        <span className={pubCardMeta} style={{ color: tokens.accent }}>
          {pub.matches.map((path) => `命中：${path}`).join(' · ')}
        </span>
      )}
      {pub.tags.length > 0 && (
        <Group gap={4} mt={2}>
          {pub.tags.map((t) => (
            <span key={t} className={pubTag}>
              {t}
            </span>
          ))}
        </Group>
      )}
      <span className={pubCardMeta} style={{ marginTop: 4 }}>
        v{pub.version} · 更新于 {formatRelativeTime(pub.updated_at)}
      </span>
    </button>
  );
}

function EmptyPlaza({ hasQuery, onPublish }: { hasQuery: boolean; onPublish: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 260,
        color: tokens.textSecondary,
        gap: 8,
      }}
    >
      <Text fz="sm">{hasQuery ? '没有匹配的发布' : '广场还没有内容'}</Text>
      <Text fz="xs" c="dimmed">
        {hasQuery
          ? '换个关键词,或清除标签与作者筛选试试。'
          : '把自己的书签合集发布到这里,供其他人导入。'}
      </Text>
      {!hasQuery && (
        <Button size="compact-sm" variant="subtle" mt={4} leftSection={<IconPlus size={14} stroke={1.5} />} onClick={onPublish}>
          发布
        </Button>
      )}
    </div>
  );
}

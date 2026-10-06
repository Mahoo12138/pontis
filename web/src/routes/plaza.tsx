import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Group, SegmentedControl, Skeleton, Text, TextInput } from '@mantine/core';
import { IconSearch, IconPlus } from '@tabler/icons-react';
import type { PublicationSummary } from '@pontis/api';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import PublishModal from '../components/plaza/PublishModal';
import { contentRegion } from '../styles/app-shell.css';
import { pagePad } from '../styles/management.css';
import { plazaGrid, pubCard, pubCardTitle, pubCardMeta, pubTag } from '../styles/plaza.css';
import { tokens } from '../styles/semantic-tokens.css';
import { usePlazaPublications } from '../hooks/use-plaza';
import { useSpaces } from '../hooks/use-spaces';
import { formatRelativeTime } from '../lib/format';

type PlazaTab = 'all' | 'mine';

export default function PlazaPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [tab, setTab] = useState<PlazaTab>('all');
  const [publishOpen, setPublishOpen] = useState(false);

  const { data: spacesData } = useSpaces();
  const spaces = spacesData?.spaces ?? [];

  const { data, isLoading, isError, refetch } = usePlazaPublications(q);
  const publications = useMemo(() => {
    const list = data?.publications ?? [];
    return tab === 'mine' ? list.filter((p) => p.is_mine) : list;
  }, [data, tab]);

  return (
    <>
      <Header
        breadcrumb="广场"
        primaryAction={{ label: '发布', icon: <IconPlus size={14} stroke={1.5} />, onClick: () => setPublishOpen(true) }}
      />
      <div className={`${contentRegion} ${pagePad}`}>
        <Group gap="sm" mb={16}>
          <TextInput
            value={q}
            placeholder="搜索发布的标题、描述、标签或作者…"
            leftSection={<IconSearch size={14} stroke={1.5} />}
            w={360}
            onChange={(e) => setParams({ q: e.currentTarget.value })}
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

        {isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : isLoading ? (
          <div className={plazaGrid}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={118} radius={8} />
            ))}
          </div>
        ) : publications.length === 0 ? (
          <EmptyPlaza
            hasQuery={!!q}
            onPublish={() => setPublishOpen(true)}
          />
        ) : (
          <div className={plazaGrid}>
            {publications.map((pub) => (
              <PublicationCard
                key={pub.id}
                pub={pub}
                onClick={() => navigate(`/plaza/${pub.id}`)}
              />
            ))}
          </div>
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
      {pub.tags.length > 0 && (
        <Group gap={4} mt={2}>
          {pub.tags.map((tag) => (
            <span key={tag} className={pubTag}>
              {tag}
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
        {hasQuery ? '换个关键词试试。' : '把自己的书签合集发布到这里,供其他人导入。'}
      </Text>
      {!hasQuery && (
        <Button size="compact-sm" variant="subtle" mt={4} leftSection={<IconPlus size={14} stroke={1.5} />} onClick={onPublish}>
          发布
        </Button>
      )}
    </div>
  );
}

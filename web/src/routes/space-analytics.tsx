import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Group, SegmentedControl } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import type { LinkStatusClass } from '@pontis/api';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import { DomainPanel, LinksPanel, OverviewPanel, StructurePanel, TimePanel } from '../components/analytics/panels';
import type { DomainData, LinksData, OverviewData, StructureData, TimeData } from '../components/analytics/panels';
import type { BarItem, PathItem } from '../components/analytics/parts';
import { contentRegion } from '../styles/app-shell.css';
import { pagePad } from '../styles/management.css';
import { tokens } from '../styles/semantic-tokens.css';
import { useNodes } from '../hooks/use-nodes';
import { useSpaces } from '../hooks/use-spaces';
import { useDuplicates, useLinkCheckResults } from '../hooks/use-organizer';
import { buildTreeIndex } from '../features/explorer';
import {
  binByMonth,
  binByYear,
  dateCoverage,
  datedBookmarks,
  depthHistogram,
  dormantFolders,
  duplicateFolderNames,
  emptyFolders,
  hostCounts,
  largestFolders,
  peakBucket,
  perFolderBuckets,
  placeholderTitles,
  rootOrphans,
  schemeMix,
  scriptSplit,
  singletonFolders,
  spanOf,
  structureSummary,
  titleLengthBuckets,
  topShare,
  topTitleTokens,
  trackingParamCount,
  unparseableUrlCount,
  urlLengthBuckets,
} from '../features/analytics';

type Tab = 'overview' | 'structure' | 'domains' | 'links' | 'time';

const STATUS_LABELS: Record<LinkStatusClass, string> = {
  ok_2xx: '正常',
  client_4xx: '4xx',
  server_5xx: '5xx',
  timeout: '超时',
  network_error: '网络不可达',
};

/** How many monthly bars to draw — a decade of months is not a chart. */
const MONTH_WINDOW = 24;

export default function SpaceAnalyticsPage() {
  const { spaceId } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('overview');

  const { data: spacesData } = useSpaces();
  const { data: nodesData, isLoading, isError, error, refetch } = useNodes(spaceId);
  const duplicates = useDuplicates(spaceId);
  const linkCheck = useLinkCheckResults(spaceId);

  const spaceName = spacesData?.spaces?.find((s) => s.id === spaceId)?.name ?? '空间';
  const nodes = useMemo(() => nodesData?.nodes ?? [], [nodesData]);
  const index = useMemo(() => buildTreeIndex(nodes), [nodes]);

  const overview = useMemo<OverviewData>(() => {
    const summary = structureSummary(nodes, index);
    const hosts = hostCounts(nodes);
    const groups = duplicates.data?.groups ?? [];
    const broken = (linkCheck.data?.results ?? []).filter((r) => r.status_class !== 'ok_2xx');
    return {
      readout: [
        { label: '书签', value: summary.bookmarks },
        { label: '文件夹', value: summary.folders },
        { label: '站点', value: hosts.length },
        { label: '最深层级', value: summary.maxDepth },
        { label: '未分类', value: summary.unfiled },
        { label: '重复组', value: groups.length },
        { label: '无法访问', value: broken.length },
      ],
      titleLength: titleLengthBuckets(nodes),
      script: scriptSplit(nodes),
      placeholders: placeholderTitles(nodes),
      tokens: topTitleTokens(nodes, 15),
    };
  }, [nodes, index, duplicates.data, linkCheck.data]);

  const structure = useMemo<StructureData>(() => {
    const empty = emptyFolders(index);
    return {
      depth: depthHistogram(index).map((bucket) => ({
        label: `${bucket.depth}`,
        count: bucket.folders + bucket.bookmarks,
      })),
      perFolder: perFolderBuckets(index),
      largest: largestFolders(index, 8).map((stat) => ({
        label: stat.path.join(' / '),
        value: stat.bookmarks,
        title: stat.path.join(' / '),
      })),
      empty,
      singleton: singletonFolders(index),
      collisions: duplicateFolderNames(index),
    };
  }, [index]);

  const domains = useMemo<DomainData>(() => {
    const all = hostCounts(nodes);
    const hosted = all.reduce((sum, h) => sum + h.count, 0);
    const top = all.slice(0, 10);
    const rest = all.slice(10);
    const scheme = schemeMix(nodes);
    const longest: BarItem[] = nodes
      .filter((n) => n.type === 'bookmark' && n.url)
      .sort((a, b) => (b.url ?? '').length - (a.url ?? '').length)
      .slice(0, 6)
      .map((n) => ({
        label: n.title || n.url || '',
        value: (n.url ?? '').length,
        note: '字符',
        title: n.url ?? undefined,
      }));
    return {
      top,
      restHosts: rest.length,
      restBookmarks: rest.reduce((sum, h) => sum + h.count, 0),
      concentration: topShare(nodes, 10),
      scheme,
      hosted,
      tracking: trackingParamCount(nodes),
      unparseable: unparseableUrlCount(nodes),
      urlLength: urlLengthBuckets(nodes),
      longest,
    };
  }, [nodes]);

  const links = useMemo<LinksData>(() => {
    const groups = duplicates.data?.groups ?? [];
    const run = linkCheck.data;
    const byClass = new Map<LinkStatusClass, number>();
    for (const result of run?.results ?? []) {
      if (result.status_class === 'ok_2xx') continue;
      byClass.set(result.status_class, (byClass.get(result.status_class) ?? 0) + 1);
    }
    return {
      exactGroups: groups.filter((g) => g.kind === 'exact').length,
      suspectedGroups: groups.filter((g) => g.kind === 'suspected').length,
      involved: groups.reduce((sum, g) => sum + g.items.length, 0),
      checked: !!run && run.total > 0,
      broken: (run?.results ?? []).filter((r) => r.status_class !== 'ok_2xx').length,
      byStatus: [...byClass.entries()]
        .map(([status, count]) => ({ label: STATUS_LABELS[status], value: count }))
        .sort((a, b) => b.value - a.value),
      runTotal: run?.total ?? 0,
      runDone: run?.done ?? 0,
    };
  }, [duplicates.data, linkCheck.data]);

  const time = useMemo<TimeData>(() => {
    const dated = datedBookmarks(nodes);
    const months = binByMonth(dated);
    const peak = peakBucket(months);
    const span = spanOf(dated);
    const dormant: PathItem[] = dormantFolders(index, dated, 12).slice(0, 12).map((entry) => ({
      key: entry.node.id,
      primary: entry.node.title,
      path: entry.path.slice(0, -1),
      note: `${Math.round(entry.idleDays / 30)} 个月前`,
    }));
    const coverage = dateCoverage(nodes);
    return {
      coverage,
      byYear: binByYear(dated),
      byMonth: months.slice(-MONTH_WINDOW),
      spanText: span
        ? `${new Date(span.earliest).getFullYear()}–${new Date(span.latest).getFullYear()}，约 ${Math.round(
            span.days / 365,
          )} 年`
        : null,
      peakText: peak?.label ?? null,
      dormant,
      undated: coverage.total - dated.length,
    };
  }, [nodes, index]);

  return (
    <>
      <Header breadcrumb={`${spaceName} / 分析`} />
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
            onChange={(v) => setTab(v as Tab)}
            data={[
              { label: '概览', value: 'overview' },
              { label: '结构', value: 'structure' },
              { label: '域名', value: 'domains' },
              { label: '链接', value: 'links' },
              { label: '时间', value: 'time' },
            ]}
            styles={{ root: { backgroundColor: tokens.hoverBg } }}
          />
        </Group>

        {isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              maxWidth: 860,
              opacity: isLoading ? 0.5 : 1,
            }}
          >
            {tab === 'overview' ? <OverviewPanel data={overview} /> : null}
            {tab === 'structure' ? <StructurePanel data={structure} /> : null}
            {tab === 'domains' ? <DomainPanel data={domains} /> : null}
            {tab === 'links' ? (
              <LinksPanel data={links} onOpenOrganizer={() => navigate(`/spaces/${spaceId}/organizer`)} />
            ) : null}
            {tab === 'time' ? <TimePanel data={time} /> : null}
          </div>
        )}
      </div>
    </>
  );
}

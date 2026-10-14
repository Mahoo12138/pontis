/**
 * The five analytics panels.
 *
 * Every panel is a pure render of numbers computed in features/analytics, so
 * the arithmetic stays unit-testable in node — `web` has no jsdom, and a
 * computation living inside a component would be untestable.
 */
import { Button, Group, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import type { CountBucket } from '../../features/analytics/buckets';
import type { BarItem, PathItem, ReadoutItem } from './parts';
import { BarList, Caveat, EmptyState, Histogram, PathList, Readout, Section, SectionBody } from './parts';
import { row } from '../../styles/analytics.css';
import { tokens } from '../../styles/semantic-tokens.css';
import { mono } from '../../styles/management.css';
import { placeholderLabel } from '../../features/analytics/titles';
import type { Placeholder } from '../../features/analytics/titles';
import type { FolderStat, NameCollision } from '../../features/analytics/structure';
import type { SchemeMix } from '../../features/analytics/urls';
import type { HostCount } from '../../features/analytics/urls';
import type { TokenCount } from '../../features/analytics/tokens';
import type { ScriptSplit } from '../../features/analytics/titles';

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%');

const pathsOf = (stats: FolderStat[]): PathItem[] =>
  stats.map((stat) => ({
    key: stat.node.id,
    primary: stat.node.title,
    path: stat.path.slice(0, -1),
    note: `${stat.bookmarks}`,
  }));

export interface OverviewData {
  readout: ReadoutItem[];
  titleLength: CountBucket[];
  script: ScriptSplit;
  placeholders: Placeholder[];
  tokens: TokenCount[];
}

export function OverviewPanel({ data }: { data: OverviewData }) {
  const scriptTotal = Math.max(data.script.total, 1);
  const placeholderItems: PathItem[] = data.placeholders.slice(0, 12).map((p) => ({
    key: p.node.id,
    primary: p.node.title || '(空)',
    path: [],
    note: placeholderLabel(p.reason),
  }));

  return (
    <>
      <Section title="总量">
        <SectionBody>
          <Readout items={data.readout} />
        </SectionBody>
      </Section>

      <Section title="标题长度" hint="字符数，含中日韩按字计">
        <Histogram buckets={data.titleLength} unitLabel="标题长度分布" />
      </Section>

      <Section title="标题用字" hint="按标题中占多的文字统计">
        <BarList
          items={[
            { label: '中文 / 日文', value: data.script.cjk, note: pct(data.script.cjk, scriptTotal) },
            { label: '拉丁字母', value: data.script.latin, note: pct(data.script.latin, scriptTotal) },
            { label: '其他文字', value: data.script.other, note: pct(data.script.other, scriptTotal) },
          ].filter((item) => item.value > 0)}
          emptyText="没有含文字的标题"
        />
      </Section>

      <Section title="标题高频词" hint="出现在 2 个以上标题中的词">
        {data.tokens.length === 0 ? (
          <EmptyState text="没有重复出现的标题词" />
        ) : (
          <>
            <BarList items={data.tokens.map((t) => ({ label: t.token, value: t.count }))} />
            <SectionBody>
              <Caveat>
                这些是标题里反复出现的字串，不是主题分析 —— Pontis 只保存浏览器给出的标题，不读取页面内容。
                中文按相邻两字组合统计，因此词表里可能出现跨词的组。
              </Caveat>
            </SectionBody>
          </>
        )}
      </Section>

      <Section title="没有信息量的标题" hint={`${data.placeholders.length} 条`}>
        <PathList items={placeholderItems} emptyText="所有标题都带了内容" />
      </Section>
    </>
  );
}

export interface StructureData {
  depth: CountBucket[];
  perFolder: CountBucket[];
  largest: BarItem[];
  empty: FolderStat[];
  singleton: FolderStat[];
  collisions: NameCollision[];
}

export function StructurePanel({ data }: { data: StructureData }) {
  const collisionItems: PathItem[] = data.collisions.flatMap((group) =>
    group.items.map(({ node, path }) => ({
      key: node.id,
      primary: node.title,
      path: path.slice(0, -1),
      note: '同名',
    })),
  );

  return (
    <>
      <Section title="层级深度" hint="每层有多少节点">
        <Histogram buckets={data.depth} unitLabel="层级深度分布" />
      </Section>

      <Section title="每个文件夹的直接书签数">
        <Histogram buckets={data.perFolder} unitLabel="文件夹书签数分布" />
      </Section>

      <Section title="最大的文件夹" hint="按子树内书签总数">
        <BarList items={data.largest} emptyText="还没有文件夹" />
      </Section>

      <Section title="只有一个子项的文件夹" hint="多层单链通常可以直接合并">
        <PathList items={pathsOf(data.singleton)} emptyText="没有单链文件夹" />
      </Section>

      <Section title="空文件夹">
        <PathList items={pathsOf(data.empty)} emptyText="没有空文件夹" />
      </Section>

      <Section title="同一父级下重名" hint="只在兄弟节点之间比较">
        <PathList items={collisionItems} emptyText="没有重名的兄弟文件夹" />
      </Section>
    </>
  );
}

export interface DomainData {
  top: HostCount[];
  restHosts: number;
  restBookmarks: number;
  concentration: number;
  scheme: SchemeMix;
  hosted: number;
  tracking: number;
  unparseable: number;
  urlLength: CountBucket[];
  longest: BarItem[];
}

export function DomainPanel({ data }: { data: DomainData }) {
  const items: BarItem[] = data.top.map((host) => ({
    label: host.host,
    value: host.count,
    note: pct(host.count, Math.max(data.hosted, 1)),
  }));
  if (data.restHosts > 0) {
    items.push({
      label: `其余 ${data.restHosts} 个站点`,
      value: data.restBookmarks,
      note: pct(data.restBookmarks, Math.max(data.hosted, 1)),
    });
  }

  const schemeTotal = Math.max(data.scheme.https + data.scheme.http + data.scheme.other, 1);
  const otherLabel = data.scheme.otherSchemes
    .slice(0, 4)
    .map((s) => `${s.scheme} ${s.count}`)
    .join(' · ');

  return (
    <>
      <Section title="常用站点" hint="子域名与 www 已合并到同一站点">
        <BarList items={items} emptyText="没有可解析的链接" />
      </Section>

      <Section title="协议">
        <BarList
          items={[
            { label: 'https', value: data.scheme.https, note: pct(data.scheme.https, schemeTotal) },
            { label: 'http', value: data.scheme.http, note: pct(data.scheme.http, schemeTotal) },
            {
              label: '其他',
              value: data.scheme.other,
              note: pct(data.scheme.other, schemeTotal),
              title: otherLabel || undefined,
            },
          ].filter((item) => item.value > 0)}
          emptyText="没有书签"
        />
        {data.scheme.other > 0 && otherLabel ? (
          <SectionBody>
            <Caveat>其他协议明细：{otherLabel}</Caveat>
          </SectionBody>
        ) : null}
      </Section>

      <Section title="链接形态">
        <SectionBody>
          <Readout
            items={[
              { label: '前 10 个站点占比', value: pct(data.concentration * 100, 100) },
              { label: '带跟踪参数', value: `${data.tracking} 条` },
              { label: '无主机名', value: `${data.unparseable} 条` },
            ]}
          />
        </SectionBody>
      </Section>

      <Section title="链接长度分布">
        <Histogram buckets={data.urlLength} unitLabel="链接长度分布" />
      </Section>

      <Section title="最长的链接" hint="过长通常是会话参数被写进了地址">
        <BarList items={data.longest} emptyText="没有书签" />
      </Section>
    </>
  );
}

export interface LinksData {
  exactGroups: number;
  suspectedGroups: number;
  involved: number;
  checked: boolean;
  broken: number;
  byStatus: BarItem[];
  runTotal: number;
  runDone: number;
}

export function LinksPanel({
  data,
  onOpenOrganizer,
}: {
  data: LinksData;
  onOpenOrganizer: () => void;
}) {
  return (
    <>
      <Section title="重复链接" hint="由服务端判定，与整理页同一份结果">
        <SectionBody>
          <Readout
            items={[
              { label: '完全相同', value: `${data.exactGroups} 组` },
              { label: '疑似相同', value: `${data.suspectedGroups} 组` },
              { label: '涉及书签', value: `${data.involved} 条` },
            ]}
          />
        </SectionBody>
        <Group gap="xs" style={{ padding: '0 14px 12px' }}>
          <Button
            size="compact-xs"
            variant="subtle"
            color="coolGray"
            leftSection={<IconExternalLink size={13} stroke={1.5} />}
            onClick={onOpenOrganizer}
          >
            到整理页处理
          </Button>
        </Group>
      </Section>

      <Section title="可访问性" hint="按最近一次链接检查">
        {!data.checked ? (
          <EmptyState text="这个空间还没有跑过链接检查" />
        ) : (
          <>
            {data.runDone < data.runTotal ? (
              <div className={row}>
                <Text span fz={13} c={tokens.textSecondary}>
                  检查进行中
                </Text>
                <Text span fz={12} className={mono} ml="auto">
                  {data.runDone} / {data.runTotal}
                </Text>
              </div>
            ) : null}
            <BarList items={data.byStatus} emptyText="没有发现无法访问的链接" />
          </>
        )}
      </Section>
    </>
  );
}

export interface TimeData {
  coverage: { dated: number; total: number };
  byYear: CountBucket[];
  byMonth: CountBucket[];
  spanText: string | null;
  peakText: string | null;
  dormant: PathItem[];
  undated: number;
}

export function TimePanel({ data }: { data: TimeData }) {
  const { dated, total } = data.coverage;
  if (dated === 0) {
    return (
      <Section title="收录时间">
        <EmptyState
          text={
            total === 0
              ? '这个空间还没有书签'
              : '还没有书签带真实收藏日期。收藏日期来自浏览器，需要设备同步一次后才会出现。'
          }
        />
      </Section>
    );
  }

  return (
    <>
      <Section title="收录时间" hint="按浏览器记录的实际收藏时刻">
        <SectionBody>
          <Readout
            items={[
              { label: '有日期', value: `${dated} / ${total}` },
              { label: '跨度', value: data.spanText ?? '—' },
              { label: '最集中的月份', value: data.peakText ?? '—' },
            ]}
          />
        </SectionBody>
        {data.undated > 0 ? (
          <SectionBody>
            <Caveat>另有 {data.undated} 条书签没有收藏日期，未计入下面的图。</Caveat>
          </SectionBody>
        ) : null}
      </Section>

      <Section title="按年" hint="没有收藏的年份会留空，以显示间断">
        <Histogram buckets={data.byYear} unitLabel="按年收藏量" />
      </Section>

      <Section title="按月">
        <Histogram buckets={data.byMonth} unitLabel="按月收藏量" />
      </Section>

      <Section title="很久没新增的文件夹" hint="子树内最新一条书签已超过 12 个月">
        <PathList items={data.dormant} emptyText="所有有内容的文件夹都还在被使用" />
      </Section>
    </>
  );
}

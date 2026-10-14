/**
 * Presentational parts for the analytics view.
 *
 * Grouped in one file rather than five because they are all under twenty lines
 * and share the same vocabulary (a row, a bar, a label). The precedent is
 * components/explorer/node-modals.tsx.
 */
import type { ReactNode } from 'react';
import { Text } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';
import type { CountBucket } from '../../features/analytics/buckets';
import {
  barFill,
  barFillLead,
  barLabel,
  barNote,
  barRow,
  barTrack,
  barValue,
  caveat,
  emptyState,
  histogram,
  histogramAxis,
  histogramBar,
  histogramBarLead,
  histogramColumn,
  histogramCount,
  histogramCountEmpty,
  histogramLabel,
  pathText,
  readout,
  readoutItem,
  readoutLabel,
  readoutValue,
  row,
  section,
  sectionBody,
  sectionHeader,
} from '../../styles/analytics.css';
import { tokens } from '../../styles/semantic-tokens.css';
import { mono, sectionHint, sectionTitle } from '../../styles/management.css';

/** A titled region. One box; nothing inside it is another box. */
export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={section} aria-label={title}>
      <header className={sectionHeader}>
        <h3 className={sectionTitle}>{title}</h3>
        {hint ? <span className={sectionHint}>{hint}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** Padding for non-row content inside a section. */
export function SectionBody({ children }: { children: ReactNode }) {
  return <div className={sectionBody}>{children}</div>;
}

export interface ReadoutItem {
  label: string;
  value: ReactNode;
}

/**
 * Headline numbers as one dense strip.
 *
 * Deliberately not a card grid: docs/23 §21 rejects the KPI array and
 * DESIGN.md:234 caps the type scale, so the totals read as a sentence rather
 * than as five hero metrics.
 */
export function Readout({ items }: { items: ReadoutItem[] }) {
  return (
    <div className={readout}>
      {items.map((item) => (
        <span key={item.label} className={readoutItem}>
          <span className={readoutLabel}>{item.label}</span>
          <span className={readoutValue}>{item.value}</span>
        </span>
      ))}
    </div>
  );
}

export interface BarItem {
  label: string;
  value: number;
  /** Secondary text on the right, e.g. a percentage. */
  note?: string;
  /** Tooltip / accessible description when the label is truncated. */
  title?: string;
}

/**
 * Horizontal ranking bars, rendered as divs rather than an SVG chart.
 *
 * Label, bar and value share one line with a fixed label column, so every bar
 * starts at the same x — bars beginning at different offsets cannot be
 * compared by length, and comparison is the only job a ranking bar has.
 */
export function BarList({ items, emptyText }: { items: BarItem[]; emptyText?: string }) {
  if (items.length === 0) return <EmptyState text={emptyText ?? '没有数据'} />;
  const max = Math.max(...items.map((item) => item.value), 1);
  // One leader, even when several tie for the top: the accent is a budget of
  // exactly one per surface.
  const leadIndex = items.findIndex((item) => item.value === max);
  return (
    <div>
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} className={barRow} title={item.title ?? item.label}>
          <div className={barLabel}>{item.label}</div>
          <div className={barTrack}>
            <div
              className={`${barFill} ${index === leadIndex ? barFillLead : ''}`}
              style={{ width: `${Math.max((item.value / max) * 100, 1.5)}%` }}
            />
          </div>
          <div className={barValue}>
            {item.value.toLocaleString('zh-CN')}
            {item.note ? <span className={barNote}> {item.note}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Tallest bar in pixels; the rest of the plot height belongs to its count. */
const PLOT_MAX = 108;

/**
 * Vertical distribution.
 *
 * Every band is drawn, including empty ones, but an empty band gets no bar —
 * just the baseline and a disabled zero. A stub used to stand in for zero,
 * which reads as "a very small amount" and is the one thing a distribution
 * must not misreport.
 */
export function Histogram({ buckets, unitLabel }: { buckets: CountBucket[]; unitLabel?: string }) {
  const peak = Math.max(...buckets.map((b) => b.count), 1);
  const leadIndex = buckets.findIndex((b) => b.count === peak);
  return (
    <SectionBody>
      <div role="img" aria-label={`${unitLabel ?? '分布'}，最大值 ${peak}`}>
        <div className={histogram}>
          {buckets.map((bucket, index) => (
            <div key={bucket.label} className={histogramColumn}>
              <div className={`${histogramCount} ${bucket.count === 0 ? histogramCountEmpty : ''}`}>
                {bucket.count}
              </div>
              {bucket.count > 0 ? (
                <div
                  className={`${histogramBar} ${index === leadIndex ? histogramBarLead : ''}`}
                  style={{ height: `${Math.round((bucket.count / peak) * PLOT_MAX)}px` }}
                  title={`${bucket.label}: ${bucket.count}`}
                />
              ) : null}
            </div>
          ))}
        </div>
        <div className={histogramAxis}>
          {buckets.map((bucket) => (
            <div key={bucket.label} className={histogramLabel}>
              {bucket.label}
            </div>
          ))}
        </div>
      </div>
    </SectionBody>
  );
}

export interface PathItem {
  key: string;
  primary: string;
  path: string[];
  note?: string;
}

/** A list of tree locations, each showing its path so it can be found. */
export function PathList({ items, emptyText }: { items: PathItem[]; emptyText?: string }) {
  if (items.length === 0) return <EmptyState text={emptyText ?? '没有符合条件的条目'} />;
  return (
    <div>
      {items.map((item) => (
        <div key={item.key} className={row}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.primary}
          </span>
          <span className={pathText}>{item.path.join(' / ')}</span>
          {item.note ? <span className={`${mono}`} style={{ marginLeft: 'auto' }}>{item.note}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className={emptyState}>
      <IconInbox size={22} stroke={1.3} style={{ color: tokens.textDisabled }} />
      <div>{text}</div>
    </div>
  );
}

/** A limit on what a number means. Used wherever a chart could over-claim. */
export function Caveat({ children }: { children: ReactNode }) {
  return (
    <Text component="p" className={caveat}>
      {children}
    </Text>
  );
}

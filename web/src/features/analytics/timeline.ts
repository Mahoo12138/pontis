/**
 * Time analysis over real bookmark creation dates.
 *
 * Reads `date_added` — the browser's own creation timestamp, carried through
 * the sync pipeline. It never falls back to `created_at`, which is the moment
 * the server record was written: for an imported collection every bookmark
 * shares one day, and plotting that would produce a spike that looks like data
 * while describing the import, not the user.
 */
import type { Node } from '@pontis/api';
import type { TreeIndex } from '../explorer/tree';
import { folderStats } from './structure';

/**
 * `date_added` is not on the `Node` contract yet, and declaring it there
 * before the server emits it would be worse than absent: `record()` throws on
 * a missing declared key (packages/api/src/validate.ts:99-113), so every node
 * in every space would fail to parse. Read it optionally until the server side
 * lands, then replace this with `node.date_added`.
 */
export function dateAddedOf(node: Node): string | null | undefined {
  return (node as { date_added?: string | null }).date_added ?? null;
}

export interface DatedBookmark {
  node: Node;
  /** Epoch milliseconds. */
  at: number;
}

/**
 * Bookmarks carrying a parseable date.
 *
 * An unparseable or absent value is *unknown*, not the epoch: coercing it to
 * 0 would plant a bar in 1970 and silently move the reported span.
 */
export function datedBookmarks(nodes: Node[]): DatedBookmark[] {
  const out: DatedBookmark[] = [];
  for (const node of nodes) {
    if (node.type !== 'bookmark') continue;
    const at = parseDate(dateAddedOf(node));
    if (at !== null) out.push({ node, at });
  }
  return out;
}

export function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export interface Coverage {
  dated: number;
  total: number;
}

/**
 * How much of the space actually has a real date.
 *
 * Rendered permanently rather than as a one-time empty state: a space whose
 * device has not synced since the field landed legitimately has nothing to
 * report, and "no data" has to stay distinguishable from "no bookmarks".
 */
export function dateCoverage(nodes: Node[]): Coverage {
  const bookmarks = nodes.filter((n) => n.type === 'bookmark').length;
  return { dated: datedBookmarks(nodes).length, total: bookmarks };
}

export interface TimeBucket {
  key: string;
  label: string;
  count: number;
}

const MONTH_LABEL = (year: number, month: number) => `${year}-${String(month + 1).padStart(2, '0')}`;

/**
 * Counts per calendar bucket, with empty buckets filled in.
 *
 * Gaps are the point: a year with nothing collected must show as a gap rather
 * than being skipped, or the shape of the collection reads as continuous
 * attention it never had.
 */
export function binByMonth(dated: DatedBookmark[], now = Date.now()): TimeBucket[] {
  if (dated.length === 0) return [];
  const counts = new Map<string, number>();
  let min = Infinity;
  let max = -Infinity;
  for (const { at } of dated) {
    const d = new Date(at);
    const key = MONTH_LABEL(d.getFullYear(), d.getMonth());
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (at < min) min = at;
    if (at > max) max = at;
  }
  const buckets: TimeBucket[] = [];
  const cursor = new Date(min);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(Math.max(max, now));
  while (cursor.getTime() <= end.getTime()) {
    const key = MONTH_LABEL(cursor.getFullYear(), cursor.getMonth());
    buckets.push({ key, label: key, count: counts.get(key) ?? 0 });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return buckets;
}

/** Counts per calendar year, years with no bookmarks included as gaps. */
export function binByYear(dated: DatedBookmark[]): TimeBucket[] {
  if (dated.length === 0) return [];
  const counts = new Map<string, number>();
  for (const { at } of dated) {
    const key = String(new Date(at).getFullYear());
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const years = [...counts.keys()].sort();
  const first = Number(years[0]);
  const last = Number(years[years.length - 1]);
  const buckets: TimeBucket[] = [];
  for (let year = first; year <= last; year += 1) {
    const key = String(year);
    buckets.push({ key, label: key, count: counts.get(key) ?? 0 });
  }
  return buckets;
}

/** Running total across ordered buckets — the collection's growth curve. */
export function cumulative(buckets: TimeBucket[]): TimeBucket[] {
  let running = 0;
  return buckets.map((bucket) => {
    running += bucket.count;
    return { ...bucket, count: running };
  });
}

export interface Span {
  earliest: number;
  latest: number;
  /** Calendar days between the two, inclusive of partial days. */
  days: number;
}

export function spanOf(dated: DatedBookmark[]): Span | null {
  if (dated.length === 0) return null;
  let earliest = Infinity;
  let latest = -Infinity;
  for (const { at } of dated) {
    if (at < earliest) earliest = at;
    if (at > latest) latest = at;
  }
  return { earliest, latest, days: Math.round((latest - earliest) / 86_400_000) };
}

export function peakBucket(buckets: TimeBucket[]): TimeBucket | null {
  let best: TimeBucket | null = null;
  for (const bucket of buckets) {
    if (bucket.count > 0 && (!best || bucket.count > best.count)) best = bucket;
  }
  return best;
}

export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * When in the week bookmarks get collected, as a 7×24 matrix.
 *
 * `date_added` carries a time of day, so this is real signal rather than an
 * inference — the weekday/weekend and working-hours shape of a collection.
 */
export function rhythm(dated: DatedBookmark[]): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const { at } of dated) {
    const d = new Date(at);
    // getDay() is 0=Sunday; the chart is labelled Monday-first.
    const row = grid[(d.getDay() + 6) % 7];
    if (row) row[d.getHours()] = (row[d.getHours()] ?? 0) + 1;
  }
  return grid;
}

export interface DormantFolder {
  node: Node;
  path: string[];
  /** Days since the newest bookmark in the subtree. */
  idleDays: number;
  bookmarks: number;
}

/**
 * Folders whose newest content is older than `months`.
 *
 * Uses the subtree maximum rather than the folder's own timestamp, so a folder
 * still receiving bookmarks into a nested child is not falsely flagged.
 */
export function dormantFolders(
  index: TreeIndex,
  dated: DatedBookmark[],
  months = 12,
  now = Date.now(),
): DormantFolder[] {
  const newest = new Map<string, number>();
  const byId = new Map(dated.map((entry) => [entry.node.id, entry.at]));

  for (const stat of folderStats(index)) {
    let max = -Infinity;
    const visit = (nodeId: string) => {
      const at = byId.get(nodeId);
      if (at !== undefined && at > max) max = at;
      for (const child of index.childrenOf(nodeId)) visit(child.id);
    };
    visit(stat.node.id);
    if (max !== -Infinity) newest.set(stat.node.id, max);
  }

  const cutoff = now - months * 30 * 86_400_000;
  const out: DormantFolder[] = [];
  for (const stat of folderStats(index)) {
    if (stat.bookmarks === 0) continue;
    const at = newest.get(stat.node.id);
    if (at === undefined || at >= cutoff) continue;
    out.push({
      node: stat.node,
      path: stat.path,
      idleDays: Math.round((now - at) / 86_400_000),
      bookmarks: stat.bookmarks,
    });
  }
  return out.sort((a, b) => b.idleDays - a.idleDays);
}

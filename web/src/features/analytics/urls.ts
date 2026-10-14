/**
 * URL-derived analysis: which sites a space actually points at, how it got
 * there, and how much query noise is attached.
 */
import type { Node } from '@pontis/api';
import type { CountBucket } from './buckets';
import { bandCounts } from './buckets';
import { registrableHost, schemeGroup, schemeOf, hasTrackingParam } from './host';

/** Bookmarks only — folders carry no url and contribute nothing here. */
function bookmarkUrls(nodes: Node[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === 'bookmark' && node.url) out.push(node.url);
  }
  return out;
}

export interface HostCount {
  host: string;
  count: number;
}

/**
 * Sites by bookmark count, descending.
 *
 * Grouped by registrable host, so `blog.github.com` and `www.github.com` are
 * one bar. URLs with no host (`mailto:`, `javascript:`) are dropped rather
 * than bucketed under an empty label.
 */
export function hostCounts(nodes: Node[]): HostCount[] {
  const counts = new Map<string, number>();
  for (const url of bookmarkUrls(nodes)) {
    const host = registrableHost(url);
    if (!host) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

/** Share of all hosted bookmarks held by the top N sites. */
export function topShare(nodes: Node[], n = 10): number {
  const all = hostCounts(nodes);
  const total = all.reduce((sum, h) => sum + h.count, 0);
  if (total === 0) return 0;
  const top = all.slice(0, n).reduce((sum, h) => sum + h.count, 0);
  return top / total;
}

export interface SchemeMix {
  https: number;
  http: number;
  other: number;
  /** Exact schemes behind `other`, so `file:` can be named rather than hidden. */
  otherSchemes: { scheme: string; count: number }[];
}

export function schemeMix(nodes: Node[]): SchemeMix {
  const other = new Map<string, number>();
  const mix: SchemeMix = { https: 0, http: 0, other: 0, otherSchemes: [] };
  for (const url of bookmarkUrls(nodes)) {
    const group = schemeGroup(url);
    if (group === 'https') mix.https += 1;
    else if (group === 'http') mix.http += 1;
    else {
      mix.other += 1;
      const scheme = schemeOf(url);
      other.set(scheme, (other.get(scheme) ?? 0) + 1);
    }
  }
  mix.otherSchemes = [...other.entries()]
    .map(([scheme, count]) => ({ scheme, count }))
    .sort((a, b) => b.count - a.count);
  return mix;
}

/** Bookmarks carrying at least one tracking parameter. */
export function trackingParamCount(nodes: Node[]): number {
  return bookmarkUrls(nodes).filter(hasTrackingParam).length;
}

const LENGTH_EDGES = [40, 80, 150, 300];
const LENGTH_LABELS = ['≤40', '41–80', '81–150', '151–300', '>300'];

/**
 * URL length distribution. Long URLs are usually a session token or a
 * redirect chain baked into the address, both of which age badly.
 */
export function urlLengthBuckets(nodes: Node[]): CountBucket[] {
  return bandCounts(
    bookmarkUrls(nodes).map((url) => url.length),
    LENGTH_EDGES,
    LENGTH_LABELS,
  );
}

/** URLs whose host could not be resolved at all. */
export function unparseableUrlCount(nodes: Node[]): number {
  return bookmarkUrls(nodes).filter((url) => registrableHost(url) === null).length;
}

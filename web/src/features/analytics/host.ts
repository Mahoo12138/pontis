/**
 * Coarse host grouping for the domain analysis.
 *
 * This is deliberately NOT the same policy as the organizer's duplicate
 * detection, which refuses to treat `www.` or `http`/`https` as equal
 * (server/internal/organizer/organizer.go:514). Grouping "which sites do I
 * actually use" wants the opposite: `blog.github.com` and `www.github.com`
 * are one site to a person reading this list.
 */

/**
 * Multi-part public suffixes worth keeping as part of the registrable label.
 *
 * A full public-suffix table is a ~40KB dependency, which is far too much to
 * spend on a bar chart. This covers the suffixes that actually split a host
 * wrongly in this collection — without them `news.sina.com.cn` collapses to
 * `com.cn` and every Chinese site merges into one bar.
 */
const MULTI_PART_SUFFIXES = new Set([
  'com.cn',
  'org.cn',
  'net.cn',
  'gov.cn',
  'edu.cn',
  'ac.cn',
  'com.tw',
  'com.hk',
  'com.mo',
  'co.uk',
  'org.uk',
  'ac.uk',
  'me.uk',
  'com.au',
  'net.au',
  'co.jp',
  'or.jp',
  'ne.jp',
  'co.kr',
  'com.br',
  'co.in',
  'co.nz',
  'com.sg',
  'com.my',
]);

/** IPv4 literal, or a bracketed IPv6 literal. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || host.startsWith('[');
}

/**
 * The site key for a URL, or null when the URL has no host at all
 * (`mailto:`, `data:`, `javascript:`) or cannot be parsed.
 *
 * Lowercased, port-free, `www.` stripped, subdomains collapsed. A host that
 * is already at or below the registrable length is returned unchanged, so
 * `localhost` and intranet names survive as their own bars.
 */
export function registrableHost(url: string): string | null {
  let host: string;
  try {
    // `hostname` (not `host`) so the port is already gone; `extractHost` in
    // lib/format.ts uses `.host` and would fold :3000 and :8080 together
    // only by accident.
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host) return null;

  host = host.toLowerCase().replace(/\.$/, '');
  if (isIpLiteral(host)) return host;

  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 1) return labels[0] ?? null;

  const first = labels[0];
  const rest = labels.slice(1);
  // Strip `www.` only when something remains, so a bare `www` host is not
  // reduced to the empty string.
  if (first === 'www' && rest.length > 0) return joinRegistrable(rest);
  return joinRegistrable(labels);
}

function joinRegistrable(labels: string[]): string {
  if (labels.length <= 2) return labels.join('.');
  const tail2 = labels.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(tail2)) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

export type SchemeGroup = 'https' | 'http' | 'other';

/**
 * URL scheme bucketed the way the scheme-mix chart wants it. The exact
 * scheme is reported separately by `schemeOf`, so `file:` / `javascript:` /
 * `chrome://` can be named instead of hiding in a faceless bucket.
 */
export function schemeGroup(url: string): SchemeGroup | null {
  const index = url.indexOf(':');
  if (index <= 0) return null;
  const scheme = url.slice(0, index).toLowerCase();
  if (scheme === 'https') return 'https';
  if (scheme === 'http') return 'http';
  return 'other';
}

/** The exact scheme string, for listing what is inside `other`. */
export function schemeOf(url: string): string {
  const index = url.indexOf(':');
  return index > 0 ? url.slice(0, index).toLowerCase() : '(无协议)';
}

/**
 * Query keys the organizer strips when it calls two URLs "suspected
 * duplicates" (organizer.go:522). Kept as one list so the analytics count and
 * the duplicate report agree about what counts as tracking noise.
 */
export const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
];

/** True when the URL carries at least one tracking parameter. */
export function hasTrackingParam(url: string): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return false;
  }
  for (const key of params.keys()) {
    if (TRACKING_PARAMS.includes(key)) return true;
    // `utm_` in general: browsers and SDKs invent variants (utm_campaign_id),
    // and the organizer's exact-key list would miss them.
    if (key.toLowerCase().startsWith('utm_')) return true;
  }
  return false;
}

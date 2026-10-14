/**
 * Title-text analysis.
 *
 * The honest limit, stated in the UI as well as here: Pontis stores the title
 * the browser was given and nothing else. It never fetches or reads page
 * content, so every "topic" from this module is a *title* token, not a subject
 * the bookmark is about. Presenting it as anything more would be invented.
 */
import type { Node } from '@pontis/api';
import type { CountBucket } from './buckets';
import { bandCounts } from './buckets';
import { registrableHost } from './host';

interface TitledBookmark {
  node: Node;
  title: string;
  url: string;
}

export function titledBookmarks(nodes: Node[]): TitledBookmark[] {
  const out: TitledBookmark[] = [];
  for (const node of nodes) {
    if (node.type !== 'bookmark' || !node.url) continue;
    out.push({ node, title: node.title ?? '', url: node.url });
  }
  return out;
}

const TITLE_EDGES = [10, 30, 80, 200];
const TITLE_LABELS = ['≤10', '11–30', '31–80', '81–200', '>200'];

/** Title length distribution, counted in code points rather than UTF-16 units. */
export function titleLengthBuckets(nodes: Node[]): CountBucket[] {
  return bandCounts(
    titledBookmarks(nodes).map(({ title }) => [...title.trim()].length),
    TITLE_EDGES,
    TITLE_LABELS,
  );
}

/** Lengths where a title was almost certainly truncated by whatever wrote it. */
const TRUNCATED_LENGTHS = new Set([200, 255]);

export type PlaceholderReason = 'empty' | 'generic' | 'is-host' | 'looks-like-url' | 'truncated';

export interface Placeholder {
  node: Node;
  reason: PlaceholderReason;
}

export function placeholderLabel(reason: PlaceholderReason): string {
  return PLACEHOLDER_LABELS[reason];
}

const PLACEHOLDER_LABELS: Record<PlaceholderReason, string> = {
  empty: '空标题',
  generic: '浏览器默认标题',
  'is-host': '标题就是域名',
  'looks-like-url': '以 http 开头',
  truncated: '长度疑似被截断',
};

/** Titles that carry no information the address does not already carry. */
export function placeholderTitles(nodes: Node[]): Placeholder[] {
  const out: Placeholder[] = [];
  for (const { node, title, url } of titledBookmarks(nodes)) {
    const trimmed = title.trim();
    const lower = trimmed.toLowerCase();
    let reason: PlaceholderReason | null = null;

    if (!trimmed) reason = 'empty';
    else if (/^https?:\/\//i.test(trimmed)) reason = 'looks-like-url';
    else if (isGenericTitle(lower)) reason = 'generic';
    else {
      const host = registrableHost(url);
      // A title that is only the site name adds nothing to the address.
      if (host && (lower === host || lower === host.split('.')[0])) reason = 'is-host';
      else if (TRUNCATED_LENGTHS.has([...trimmed].length)) reason = 'truncated';
    }

    if (reason) out.push({ node, reason });
  }
  return out;
}

/**
 * Titles a browser writes when the user never named the bookmark. Matching is
 * exact-or-prefixed ("新标签页 - Google") rather than substring, so a page
 * genuinely about Google is not swept up by the "google" entry.
 */
const GENERIC_TITLE_WORDS = [
  '未命名',
  '新标签页',
  '新标签',
  '关于此页面',
  '百度一下',
  'google',
  'untitled',
  'no title',
  'without title',
  'home page',
  'homepage',
];

function isGenericTitle(lower: string): boolean {
  for (const word of GENERIC_TITLE_WORDS) {
    if (lower === word || lower.startsWith(word + ' - ') || lower === word + ' -') return true;
  }
  return false;
}

export interface ScriptSplit {
  cjk: number;
  latin: number;
  other: number;
  total: number;
}

// Unicode property escapes rather than literal ranges: a CJK character written
// straight into a source file cannot be reviewed, and an inverted range fails
// at runtime rather than at a glance.
const HAN = /\p{Script=Han}/u;
const KANA = /\p{Script=Hiragana}|\p{Script=Katakana}/u;
const HANGUL = /\p{Script=Hangul}/u;
const LATIN = /\p{Script=Latin}/u;

const isCjk = (char: string) => HAN.test(char) || KANA.test(char);

/**
 * How many titles are written in Chinese/Japanese script versus Latin script.
 *
 * Counts, not a persona. A title mixing both (the common `Go 语言教程` shape)
 * goes to whichever script has more letters.
 */
export function scriptSplit(nodes: Node[]): ScriptSplit {
  const split: ScriptSplit = { cjk: 0, latin: 0, other: 0, total: 0 };
  for (const { title } of titledBookmarks(nodes)) {
    const chars = [...title].filter((c) => /\p{L}/u.test(c));
    if (chars.length === 0) continue;
    split.total += 1;
    const cjk = chars.filter(isCjk).length;
    const latin = chars.filter((c) => LATIN.test(c)).length;
    const hangul = chars.filter((c) => HANGUL.test(c)).length;
    if (cjk >= latin && cjk >= hangul) split.cjk += 1;
    else if (latin >= hangul) split.latin += 1;
    else split.other += 1;
  }
  return split;
}

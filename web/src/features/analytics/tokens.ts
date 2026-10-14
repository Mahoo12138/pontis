/**
 * Title tokenization.
 *
 * There is no segmenter in the dependency tree, and pulling one in (jieba
 * bindings, a word dictionary) is far too heavy for a bar chart of title
 * words. So Chinese is handled with character bigrams, the standard cheap
 * approach: a run like 「语言学习」 yields 语言 / 言学 / 学习, so meaningful
 * pairs survive while single characters — which are mostly grammar — never
 * become tokens at all.
 *
 * The consequence to state in the UI: these are *frequent title strings*, not
 * topics. A bigram chart is a fact about how the titles were written.
 */
import type { Node } from '@pontis/api';
import { titledBookmarks } from './titles';

/**
 * Two-character Chinese function words and filler. An unfiltered bigram chart
 * is dominated by exactly these, which is why the table exists.
 */
const CJK_STOPWORDS = new Set([
  '一个', '一些', '我们', '这是', '什么', '怎么', '如何', '可以', '需要',
  '使用', '相关', '以及', '但是', '因为', '所以', '如果', '关于', '对于',
  '通过', '进行', '这个', '那个', '这些', '那些', '一下', '还有', '只是',
  '已经', '应该', '自己', '没有',
]);

/**
 * English function words, including every common two-letter combination.
 *
 * The minimum token length is 2 rather than 3 because the terms most worth
 * seeing in this collection are short proper nouns — Go, UI, AI, OS — and a
 * three-letter floor would drop them. That makes the stopword list carry the
 * noise instead.
 */
const LATIN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'you', 'your', 'are',
  'was', 'were', 'have', 'has', 'not', 'but', 'all', 'can', 'will', 'blog',
  'com', 'www', 'http', 'https', 'page', 'new', 'one', 'how', 'why', 'what',
  'use', 'using', 'guide', 'more', 'than', 'into', 'about',
  'a', 'an', 'as', 'at', 'be', 'by', 'do', 'he', 'if', 'in', 'is', 'it', 'me',
  'my', 'no', 'of', 'on', 'or', 'so', 'to', 'us', 'we',
]);

// Han runs: CJK Unified Ideographs plus Extension A. Written as escapes
// because the literal characters cannot be reviewed in a diff.
const HAN_RUN = new RegExp('[\\u4e00-\\u9fff\\u3400-\\u4dbf]+', 'g');

/**
 * Tokens for one title: lowercase Latin words of 2+ letters, plus bigrams over
 * each contiguous Han run.
 *
 * Runs are bigrammed separately so two unrelated words sitting next to each
 * other cannot manufacture a third token across the boundary.
 */
export function tokenizeTitle(title: string): string[] {
  const out: string[] = [];

  for (const word of title.split(/[^A-Za-z]+/)) {
    const lower = word.toLowerCase();
    if (lower.length >= 2 && !LATIN_STOPWORDS.has(lower)) out.push(lower);
  }

  for (const run of title.match(HAN_RUN) ?? []) {
    const chars = [...run];
    if (chars.length < 2) continue;
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const gram = (chars[i] as string) + (chars[i + 1] as string);
      if (!CJK_STOPWORDS.has(gram)) out.push(gram);
    }
  }

  return out;
}

export interface TokenCount {
  token: string;
  /** Titles containing it, not occurrences — one shouty title should not win. */
  count: number;
}

/** Most frequent title tokens across a space, appearing in 2+ titles. */
export function topTitleTokens(nodes: Node[], limit = 15): TokenCount[] {
  const counts = new Map<string, number>();
  for (const { title } of titledBookmarks(nodes)) {
    for (const token of new Set(tokenizeTitle(title))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token))
    .slice(0, limit);
}

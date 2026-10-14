// There is no segmenter in the dependency tree, so Chinese is handled with
// character bigrams. These tests pin what that can and cannot claim: the pairs
// are frequent title strings, not topics the bookmark is about.

import { describe, expect, it } from 'vitest';
import { mkNode } from './fixtures';
import { tokenizeTitle, topTitleTokens } from './tokens';

describe('tokenizeTitle', () => {
  it('keeps Latin words of two letters or more, lowercased', () => {
    expect(tokenizeTitle('Advanced Go Concurrency')).toEqual(['advanced', 'go', 'concurrency']);
  });

  it('drops Latin function words', () => {
    expect(tokenizeTitle('the guide for the use of something')).not.toContain('the');
  });

  it('splits Chinese on bigrams', () => {
    const tokens = tokenizeTitle('语言学习');
    expect(tokens).toContain('语言');
    expect(tokens).toContain('言学');
    expect(tokens).toContain('学习');
  });

  it('filters the two-character filler that would otherwise own the chart', () => {
    expect(tokenizeTitle('这是一个关于测试的内容')).not.toContain('这是');
  });

  it('never emits a single Han character', () => {
    expect(tokenizeTitle('书')).toEqual([]);
  });

  it('does not bridge a bigram across non-Han characters', () => {
    // 「学习 Go 语言」 must not manufacture a token joining 学习 and 语言.
    const tokens = tokenizeTitle('学习 Go 语言');
    expect(tokens).not.toContain('习语');
    expect(tokens).toContain('语言');
  });

  it('handles a mixed title without losing either script', () => {
    const tokens = tokenizeTitle('Go 语言教程');
    expect(tokens).toContain('go');
    expect(tokens).toContain('语言');
  });
});

describe('topTitleTokens', () => {
  const titled = (id: string, title: string) => mkNode({ id, title, url: 'https://example.com/p' });

  it('counts titles containing a token, not occurrences', () => {
    const nodes = [
      titled('a', 'Go 语言 入门'),
      titled('b', 'Go 语言 进阶'),
      titled('c', 'Go 语言 实战'),
    ];
    expect(topTitleTokens(nodes).find((t) => t.token === 'go')?.count).toBe(3);
  });

  it('ignores a token that appears in only one title', () => {
    const nodes = [titled('a', 'Rust lifetime'), titled('b', 'Go generics')];
    expect(topTitleTokens(nodes).map((t) => t.token)).not.toContain('lifetime');
  });

  it('respects the limit', () => {
    const nodes = [0, 1, 2, 3, 4, 5].flatMap((i) => [
      titled(`a${i}`, 'common token here'),
      titled(`b${i}`, 'common token here'),
    ]);
    expect(topTitleTokens(nodes, 2).length).toBeLessThanOrEqual(2);
  });

  it('is empty for a space with no bookmarks', () => {
    expect(topTitleTokens([])).toEqual([]);
  });
});

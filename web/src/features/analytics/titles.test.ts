// Title quality is reported as a list of specific, checkable defects. The
// tempting version — one "organization score" — is not falsifiable, so the
// detection rules below are the product.

import { describe, expect, it } from 'vitest';
import { mkNode } from './fixtures';
import { placeholderLabel, placeholderTitles, scriptSplit, titleLengthBuckets } from './titles';

const titled = (id: string, title: string, url = 'https://example.com/p') => mkNode({ id, title, url });

describe('placeholderTitles', () => {
  it('flags an empty or whitespace title', () => {
    expect(placeholderTitles([titled('a', '   ')]).map((p) => p.reason)).toEqual(['empty']);
  });

  it('flags the titles a browser writes for an unnamed bookmark', () => {
    const nodes = [titled('a', '新标签页'), titled('b', '新标签页 - Google 搜索'), titled('c', 'Untitled')];
    const found = placeholderTitles(nodes);
    expect(found).toHaveLength(3);
    expect(found.every((p) => p.reason === 'generic')).toBe(true);
  });

  it('does not flag a real page that merely mentions google', () => {
    expect(placeholderTitles([titled('a', 'Google SRE 手册')])).toEqual([]);
  });

  it('flags a title that is only the site name', () => {
    const nodes = [
      titled('a', 'example.com', 'https://example.com/x'),
      titled('b', 'example', 'https://example.com/y'),
    ];
    expect(placeholderTitles(nodes).map((p) => p.reason)).toEqual(['is-host', 'is-host']);
  });

  it('flags a title that is a bare url', () => {
    expect(placeholderTitles([titled('a', 'https://example.com/q?x=1')])[0]?.reason).toBe('looks-like-url');
  });

  it('flags the lengths a truncated writer leaves behind', () => {
    const nodes = [titled('a', 'x'.repeat(255)), titled('b', 'y'.repeat(200))];
    expect(placeholderTitles(nodes).map((p) => p.reason)).toEqual(['truncated', 'truncated']);
  });

  it('labels every reason in Chinese, because the UI shows these', () => {
    for (const reason of ['empty', 'generic', 'is-host', 'looks-like-url', 'truncated'] as const) {
      expect(placeholderLabel(reason).length).toBeGreaterThan(1);
    }
  });
});

describe('titleLengthBuckets', () => {
  it('counts code points, so a CJK title is not double-weighted by UTF-16', () => {
    // Five characters, ten UTF-16 code units.
    expect(titleLengthBuckets([titled('a', '语言学习笔')])[0]).toEqual({ label: '≤10', count: 1 });
  });

  it('measures the trimmed title', () => {
    expect(titleLengthBuckets([titled('a', '  hi  ')])[0]?.count).toBe(1);
  });
});

describe('scriptSplit', () => {
  it('separates Chinese/Japanese titles from Latin ones', () => {
    const nodes = [titled('a', '语言学习'), titled('b', 'Advanced Go Concurrency'), titled('c', 'Rust Book')];
    const split = scriptSplit(nodes);
    expect(split.cjk).toBe(1);
    expect(split.latin).toBe(2);
    expect(split.total).toBe(3);
  });

  it('gives a mixed title to whichever script has more letters', () => {
    const nodes = [titled('a', 'Go 语言教程'), titled('b', 'Go')];
    expect(scriptSplit(nodes).cjk).toBe(1);
    expect(scriptSplit(nodes).latin).toBe(1);
  });

  it('excludes titles with no letters at all from the denominator', () => {
    expect(scriptSplit([titled('a', '12345 ---')]).total).toBe(0);
  });

  it('does not fold Korean into the Chinese/Japanese count', () => {
    const split = scriptSplit([titled('a', '고급 프로그래밍')]);
    expect(split.cjk).toBe(0);
    expect(split.other).toBe(1);
  });
});

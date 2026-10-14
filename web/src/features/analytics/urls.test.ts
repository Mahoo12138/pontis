// The URL charts group by site. Grouping by raw host instead would spread one
// site across `www.`, `blog.` and `docs.` rows and make the top-ten list a
// study in redundancy.

import { describe, expect, it } from 'vitest';
import { mkBookmark, mkFolder } from './fixtures';
import {
  hostCounts,
  schemeMix,
  topShare,
  trackingParamCount,
  unparseableUrlCount,
  urlLengthBuckets,
} from './urls';

const at = (id: string, url: string) => mkBookmark(id, url);

describe('hostCounts', () => {
  it('folds subdomains into one bar and sorts by size', () => {
    const nodes = [
      at('a', 'https://www.github.com/x'),
      at('b', 'https://blog.github.com/y'),
      at('c', 'https://gist.github.com/z'),
      at('d', 'https://rust-lang.org/'),
    ];
    expect(hostCounts(nodes)).toEqual([
      { host: 'github.com', count: 3 },
      { host: 'rust-lang.org', count: 1 },
    ]);
  });

  it('ignores folders, which have no url', () => {
    const nodes = [mkFolder('f', null), at('a', 'https://x.test')];
    expect(hostCounts(nodes)).toEqual([{ host: 'x.test', count: 1 }]);
  });

  it('drops hostless urls rather than labelling them empty', () => {
    expect(hostCounts([at('a', 'mailto:me@x.test')])).toEqual([]);
  });

  it('breaks count ties by host so the order is stable', () => {
    const nodes = [at('a', 'https://b.test'), at('b', 'https://a.test')];
    expect(hostCounts(nodes).map((h) => h.host)).toEqual(['a.test', 'b.test']);
  });
});

describe('topShare', () => {
  it('reports the fraction held by the top N sites', () => {
    const nodes = [
      ...Array.from({ length: 8 }, (_, i) => at(`m${i}`, `https://a.test/${i}`)),
      ...Array.from({ length: 2 }, (_, i) => at(`o${i}`, `https://b${i}.test`)),
    ];
    expect(topShare(nodes, 1)).toBeCloseTo(0.8);
  });

  it('is 0 for an empty space rather than NaN', () => {
    expect(topShare([])).toBe(0);
  });
});

describe('schemeMix', () => {
  it('separates https, http and everything else', () => {
    const nodes = [
      at('a', 'https://x.test'),
      at('b', 'http://y.test'),
      at('c', 'file:///tmp/z'),
      at('d', 'https://w.test'),
    ];
    const mix = schemeMix(nodes);
    expect({ https: mix.https, http: mix.http, other: mix.other }).toEqual({
      https: 2,
      http: 1,
      other: 1,
    });
  });

  it('names the schemes hiding in the other bucket', () => {
    const mix = schemeMix([at('a', 'file:///tmp/z'), at('b', 'chrome://settings')]);
    expect(mix.otherSchemes.map((s) => s.scheme).sort()).toEqual(['chrome', 'file']);
  });
});

describe('trackingParamCount', () => {
  it('counts bookmarks, not parameters', () => {
    const nodes = [
      at('a', 'https://x.test/p?utm_source=t&fbclid=2'),
      at('b', 'https://x.test/q?utm_medium=news'),
      at('c', 'https://x.test/r?id=5'),
    ];
    expect(trackingParamCount(nodes)).toBe(2);
  });
});

describe('urlLengthBuckets', () => {
  it('always returns every band, including the empty ones', () => {
    const buckets = urlLengthBuckets([at('a', 'https://x.test')]);
    expect(buckets).toHaveLength(5);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });

  it('sorts a long url into the tail band', () => {
    const long = 'https://x.test/' + 'q'.repeat(400);
    expect(urlLengthBuckets([at('a', long)])[4]).toEqual({ label: '>300', count: 1 });
  });
});

describe('unparseableUrlCount', () => {
  it('counts hostless urls so the chart can admit what it dropped', () => {
    const nodes = [at('a', 'mailto:me@x.test'), at('b', 'https://ok.test')];
    expect(unparseableUrlCount(nodes)).toBe(1);
  });
});

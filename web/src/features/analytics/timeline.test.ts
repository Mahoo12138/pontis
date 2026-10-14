// Time bucketing is where an analytics view can silently lie, so the tests
// pin the failure modes: a year with nothing collected must still appear (a
// skipped gap reads as continuous attention), an unparseable date must not
// become 1970, and folders must never be counted as dated bookmarks.

// `rhythm` buckets by *local* weekday and hour, which is the only meaningful
// reading of "when do I collect bookmarks". Pin the zone so the assertions do
// not depend on the machine running them.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'UTC';

import { afterAll, describe, expect, it } from 'vitest';
import { buildTreeIndex } from '../explorer/tree';
import { mkDated, mkFolder } from './fixtures';
import {
  binByMonth,
  binByYear,
  cumulative,
  dateCoverage,
  datedBookmarks,
  dormantFolders,
  parseDate,
  peakBucket,
  rhythm,
  spanOf,
} from './timeline';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('parseDate', () => {
  it('treats null, empty and garbage as unknown rather than the epoch', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('yesterday')).toBeNull();
  });

  it('parses RFC3339', () => {
    expect(parseDate('2021-07-02T08:30:00Z')).toBe(Date.UTC(2021, 6, 2, 8, 30));
  });
});

describe('datedBookmarks', () => {
  it('skips folders, which have no browser creation date', () => {
    const nodes = [mkFolder('f', null), mkDated('b', '2021-01-01T00:00:00Z')];
    expect(datedBookmarks(nodes).map((d) => d.node.id)).toEqual(['b']);
  });

  it('skips undated bookmarks without inventing a date', () => {
    const nodes = [mkDated('a', null), mkDated('b', '2021-01-01T00:00:00Z')];
    expect(datedBookmarks(nodes).map((d) => d.node.id)).toEqual(['b']);
  });
});

describe('dateCoverage', () => {
  it('reports how much of the space has a real date', () => {
    const nodes = [mkDated('a', '2021-01-01T00:00:00Z'), mkDated('b', null), mkFolder('f', null)];
    expect(dateCoverage(nodes)).toEqual({ dated: 1, total: 2 });
  });
});

describe('binByYear', () => {
  it('fills years with nothing collected, so the gap is visible', () => {
    const dated = datedBookmarks([
      mkDated('a', '2019-05-01T00:00:00Z'),
      mkDated('b', '2023-02-01T00:00:00Z'),
    ]);
    expect(binByYear(dated)).toEqual([
      { key: '2019', label: '2019', count: 1 },
      { key: '2020', label: '2020', count: 0 },
      { key: '2021', label: '2021', count: 0 },
      { key: '2022', label: '2022', count: 0 },
      { key: '2023', label: '2023', count: 1 },
    ]);
  });

  it('is empty when nothing is dated', () => {
    expect(binByYear([])).toEqual([]);
  });
});

describe('binByMonth', () => {
  it('labels buckets YYYY-MM and stops at the requested now', () => {
    const dated = datedBookmarks([
      mkDated('a', '2021-01-15T00:00:00Z'),
      mkDated('b', '2021-03-15T00:00:00Z'),
    ]);
    const buckets = binByMonth(dated, Date.UTC(2021, 3, 1));
    expect(buckets.map((b) => b.key)).toEqual(['2021-01', '2021-02', '2021-03', '2021-04']);
    expect(buckets.map((b) => b.count)).toEqual([1, 0, 1, 0]);
  });

  it('buckets by the local month of a UTC-stamped date', () => {
    // TZ is pinned to UTC above, so 23:00Z on the 31st is still the 31st.
    const dated = datedBookmarks([mkDated('a', '2021-01-31T23:00:00Z')]);
    expect(binByMonth(dated, Date.UTC(2021, 0, 31))[0]?.key).toBe('2021-01');
  });
});

describe('cumulative', () => {
  it('turns per-bucket counts into a growth curve', () => {
    const buckets = binByYear(
      datedBookmarks([
        mkDated('a', '2019-01-01T00:00:00Z'),
        mkDated('b', '2020-01-01T00:00:00Z'),
        mkDated('c', '2020-06-01T00:00:00Z'),
      ]),
    );
    expect(cumulative(buckets).map((b) => b.count)).toEqual([1, 3]);
  });
});

describe('spanOf', () => {
  it('measures the distance between the first and last dated bookmark', () => {
    const span = spanOf(
      datedBookmarks([mkDated('a', '2020-01-01T00:00:00Z'), mkDated('b', '2020-02-10T00:00:00Z')]),
    );
    expect(span?.days).toBe(40);
  });

  it('is null rather than a zero-length span when nothing is dated', () => {
    expect(spanOf([])).toBeNull();
  });
});

describe('peakBucket', () => {
  it('finds the busiest bucket', () => {
    const buckets = binByYear(
      datedBookmarks([
        mkDated('a', '2019-01-01T00:00:00Z'),
        mkDated('b', '2020-01-01T00:00:00Z'),
        mkDated('c', '2020-02-01T00:00:00Z'),
      ]),
    );
    expect(peakBucket(buckets)?.key).toBe('2020');
  });

  it('is null when there is nothing to peak at', () => {
    expect(peakBucket([])).toBeNull();
  });
});

describe('rhythm', () => {
  it('is a Monday-first 7x24 grid', () => {
    const grid = rhythm(datedBookmarks([mkDated('a', '2026-05-18T14:00:00Z')]));
    expect(grid).toHaveLength(7);
    expect(grid[0]).toHaveLength(24);
    expect(grid.flat().reduce((sum, n) => sum + n, 0)).toBe(1);
  });

  it('maps Sunday to the last row, not the first', () => {
    // 2026-05-17 is a Sunday.
    const grid = rhythm(datedBookmarks([mkDated('a', '2026-05-17T09:00:00Z')]));
    expect(grid[6]?.[9]).toBe(1);
    expect(grid[0]?.[9]).toBe(0);
  });

  it('is all zeros when nothing is dated', () => {
    expect(rhythm([]).flat().every((n) => n === 0)).toBe(true);
  });
});

describe('dormantFolders', () => {
  it('judges a folder by the newest bookmark anywhere in its subtree', () => {
    const nodes = [
      mkFolder('dev', null),
      mkFolder('go', 'dev'),
      mkDated('stale', '2021-01-01T00:00:00Z', 'https://stale.test', 'dev'),
    ];
    const index = buildTreeIndex(nodes);
    const dormant = dormantFolders(index, datedBookmarks(nodes), 12, Date.UTC(2026, 0, 1));
    // `go` holds nothing so it is not dormant; `dev` is, via its stale child.
    expect(dormant.map((d) => d.node.id)).toEqual(['dev']);
    expect(dormant[0]?.idleDays).toBeGreaterThan(1800);
  });

  it('does not flag a folder that received a recent bookmark', () => {
    const nodes = [mkFolder('dev', null), mkDated('fresh', '2026-01-01T00:00:00Z', 'https://fresh.test', 'dev')];
    const index = buildTreeIndex(nodes);
    expect(dormantFolders(index, datedBookmarks(nodes), 12, Date.UTC(2026, 2, 1))).toEqual([]);
  });

  it('reports the path, so a long idle list is still navigable', () => {
    const nodes = [
      mkFolder('dev', null),
      mkFolder('old', 'dev'),
      mkDated('stale', '2020-01-01T00:00:00Z', 'https://stale.test', 'old'),
    ];
    const index = buildTreeIndex(nodes);
    const dormant = dormantFolders(index, datedBookmarks(nodes), 12, Date.UTC(2026, 0, 1));
    expect(dormant.map((d) => d.path.join(' / '))).toEqual(['dev / old', 'dev']);
  });
});

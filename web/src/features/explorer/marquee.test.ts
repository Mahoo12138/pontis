import { describe, expect, it } from 'vitest';
import { isDragStart, rowsInMarquee } from './marquee';
import type { RowBand } from './marquee';

const band = (id: string, top: number): RowBand => ({ id, top, bottom: top + 38, left: 0, right: 800 });
const bands = [band('a', 0), band('b', 38), band('c', 76), band('d', 114)];

describe('rowsInMarquee', () => {
  it('picks the rows the rectangle touches, in list order', () => {
    expect(rowsInMarquee(bands, { x0: 10, y0: 40, x1: 300, y1: 100 })).toEqual(['b', 'c']);
  });

  it('normalizes a drag drawn upwards', () => {
    expect(rowsInMarquee(bands, { x0: 10, y0: 100, x1: 300, y1: 40 })).toEqual(['b', 'c']);
  });

  it('sweeps rows on a drag that only moves vertically', () => {
    expect(rowsInMarquee(bands, { x0: 10, y0: 40, x1: 10, y1: 90 })).toEqual(['b', 'c']);
  });

  it('ignores rows outside the horizontal span', () => {
    const narrow: RowBand[] = [
      { id: 'left', top: 0, bottom: 38, left: 0, right: 40 },
      { id: 'right', top: 0, bottom: 38, left: 500, right: 600 },
    ];
    expect(rowsInMarquee(narrow, { x0: 450, y0: 0, x1: 600, y1: 20 })).toEqual(['right']);
  });

  it('grabs everything the rectangle spans', () => {
    expect(rowsInMarquee(bands, { x0: 0, y0: -50, x1: 900, y1: 200 })).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('isDragStart', () => {
  it('stays quiet for a click and wakes up on a drag', () => {
    expect(isDragStart(100, 100, 102, 101)).toBe(false);
    expect(isDragStart(100, 100, 100, 96)).toBe(true);
    expect(isDragStart(100, 100, 120, 100)).toBe(true);
  });
});

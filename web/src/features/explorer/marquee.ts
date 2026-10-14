/** Rubber-band (marquee) geometry for the explorer list. */

/** Drag rectangle in viewport coordinates, corners unnormalized. */
export interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One row's box in the same coordinate space. */
export interface RowBand {
  id: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Rows the marquee touches, in list order.
 *
 * Intersection rather than containment: a row lights up as soon as the
 * rectangle reaches any part of it, which is what a file manager does and
 * what makes a short drag across a tall subtree feel immediate. The
 * horizontal test is inclusive so a drag that only moves vertically — the
 * common way to sweep a list — still selects.
 */
export function rowsInMarquee(bands: RowBand[], marquee: MarqueeRect): string[] {
  const left = Math.min(marquee.x0, marquee.x1);
  const right = Math.max(marquee.x0, marquee.x1);
  const top = Math.min(marquee.y0, marquee.y1);
  const bottom = Math.max(marquee.y0, marquee.y1);

  return bands
    .filter((band) => band.top < bottom && band.bottom > top && band.left <= right && band.right >= left)
    .map((band) => band.id);
}

/** Movement below this is a click, not a drag. */
export const MARQUEE_THRESHOLD = 3;

export function isDragStart(x0: number, y0: number, x1: number, y1: number): boolean {
  return Math.abs(x1 - x0) >= MARQUEE_THRESHOLD || Math.abs(y1 - y0) >= MARQUEE_THRESHOLD;
}

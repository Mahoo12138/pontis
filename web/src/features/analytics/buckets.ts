/** Shared histogram banding for the analytics buckets. */

export interface CountBucket {
  label: string;
  count: number;
}

/**
 * Tally numbers into labelled bands given by inclusive upper bounds.
 *
 * A value above every bound lands in the trailing open-ended band, so
 * `labels.length` must be `edges.length + 1`.
 *
 * Extracted because the three distribution charts (bookmarks per folder, URL
 * length, title length) are the same operation, and writing them out by hand
 * repeats the `?? 0` dance that `noUncheckedIndexedAccess` forces on indexed
 * writes.
 */
export function bandCounts(values: number[], edges: number[], labels: string[]): CountBucket[] {
  const counts = labels.map(() => 0);
  for (const value of values) {
    const found = edges.findIndex((upper) => value <= upper);
    const slot = found === -1 ? labels.length - 1 : found;
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return labels.map((label, i) => ({ label, count: counts[i] ?? 0 }));
}

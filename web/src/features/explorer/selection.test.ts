// Issue #1: inside a space you could not hold a nested folder and its bookmarks
// in one selection long enough to delete them together. The rule that broke it
// is here, so it is tested without a DOM.

import { describe, expect, it } from 'vitest';
import { keepThroughPress, pressSelection, pruneSelection, rangeTo, shouldRecordPress, deleteTargets } from './selection';

const plain = { shiftKey: false, metaKey: false, ctrlKey: false };
const cmd = { shiftKey: false, metaKey: true, ctrlKey: false };

const ids = (s: Set<string>) => [...s].sort();

describe('what is allowed to drop a selection', () => {
  it('keeps rows that only went off-screen', () => {
    const selected = new Set(['main', 'example']);
    // Collapsing `main`, or filtering to 文件夹, hides `example`. Neither removes
    // the node, so neither is a reason to forget the person picked it.
    expect(ids(pruneSelection(selected, () => true))).toEqual(['example', 'main']);
  });

  it('drops a node that no longer exists', () => {
    const selected = new Set(['main', 'example']);
    const stillThere = new Set(['main']);

    expect(ids(pruneSelection(selected, (id) => stillThere.has(id)))).toEqual(['main']);
  });

  it('returns the same set when nothing left, so callers do not re-render', () => {
    const selected = new Set(['main']);
    expect(pruneSelection(selected, () => true)).toBe(selected);
  });
});

describe('what a batch delete actually sends', () => {
  // Outer > Inner > (Deep One, Deep Two), plus a root-level Sibling.
  const parent: Record<string, string | null> = {
    Inner: 'Outer',
    'Deep One': 'Inner',
    'Deep Two': 'Inner',
    Outer: null,
    Sibling: null,
  };
  const parentOf = (id: string) => parent[id] ?? null;

  it('drops descendants a selected folder already covers', () => {
    const selected = new Set(['Inner', 'Deep One']);
    expect(deleteTargets(selected, parentOf)).toEqual(['Inner']);
  });

  it('keeps siblings that no selected ancestor covers', () => {
    const selected = new Set(['Outer', 'Sibling', 'Deep Two']);
    expect(deleteTargets(selected, parentOf).sort()).toEqual(['Outer', 'Sibling']);
  });

  it('sends a leaf on its own', () => {
    expect(deleteTargets(new Set(['Deep One']), parentOf)).toEqual(['Deep One']);
  });
});

describe('press semantics', () => {
  const rowIds = ['main', 'reading', 'example', 'loose'];

  it('a plain press selects one row', () => {
    const out = pressSelection(new Set(['loose']), 'main', plain, 'loose', rowIds);
    expect(ids(out.selected)).toEqual(['main']);
    expect(out.anchorId).toBe('main');
  });

  it('⌘ extends across nesting', () => {
    const out = pressSelection(new Set(['main']), 'example', cmd, 'main', rowIds);
    expect(ids(out.selected)).toEqual(['example', 'main']);
  });

  it('⌘ on a selected row takes it back out', () => {
    const out = pressSelection(new Set(['main', 'example']), 'example', cmd, 'main', rowIds);
    expect(ids(out.selected)).toEqual(['main']);
  });

  it('shift ranges over the visible rows', () => {
    expect(ids(rangeTo(rowIds, 'reading', 'loose'))).toEqual(['example', 'loose', 'reading']);
  });
});

describe('drilling into a folder', () => {
  it('puts the batch back when the folder was already part of it', () => {
    const replaced = new Set(['main', 'loose']);
    // Double-click's first press left only `main` selected; the gesture should
    // not cost `loose`.
    expect(ids(keepThroughPress(replaced, 'main') ?? new Set())).toEqual(['loose', 'main']);
  });

  it('does not let the second press of a double-click overwrite the batch', () => {
    const batch = new Set(['main', 'loose']);
    // First click of the gesture: it replaces the batch, and that is what the
    // restore needs to remember.
    const first = pressSelection(batch, 'main', plain, 'loose', ['main', 'loose']);
    expect(shouldRecordPress(batch, 'main')).toBe(true);
    // Second click lands on the row the first one isolated. Recording here would
    // store the collapsed selection and the restore would find nothing — the
    // exact bug a browser run caught after the unit tests were already green.
    expect(shouldRecordPress(first.selected, 'main')).toBe(false);
    expect(ids(keepThroughPress(first.replaced, 'main') ?? new Set())).toEqual(['loose', 'main']);
  });

  it('leaves a lone selection alone', () => {
    expect(keepThroughPress(new Set(['main']), 'main')).toBeNull();
  });

  it('does not resurrect a row the person had not picked', () => {
    expect(keepThroughPress(new Set(['main', 'loose']), 'example')).toBeNull();
  });
});

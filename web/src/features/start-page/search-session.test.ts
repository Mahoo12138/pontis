// The rules here are the ones a reader cannot see being broken: an Enter that
// fires while an input method is still assembling candidates, a selection that
// walks off the end of the list, a mode switch that submits what was only
// meant to be re-targeted.

import { describe, expect, it } from 'vitest';
import {
  dismissed,
  enterTarget,
  idleSession,
  maySubmit,
  moveSelection,
  pick,
  withMode,
  withQuery,
  type SearchSession,
} from './search-session';

const results = ['GitHub', 'GitLab', 'MDN'];

describe('maySubmit', () => {
  it('refuses an empty or whitespace-only query', () => {
    // An empty box is not a search for "everything" (§7.1).
    expect(maySubmit({ ...idleSession('web'), query: '' })).toBe(false);
    expect(maySubmit({ ...idleSession('web'), query: '   ' })).toBe(false);
    expect(maySubmit({ ...idleSession('web'), query: 'go' })).toBe(true);
  });

  it('refuses a keypress that belongs to an input method', () => {
    // SP-18: confirming a 拼音 candidate fires keydown Enter with the raw text
    // still in the box. Submitting it would search for the letters the reader
    // typed, not the word they chose.
    const composing: SearchSession = { ...idleSession('web'), query: 'shu qian', composing: true };
    expect(maySubmit(composing)).toBe(false);
    expect(maySubmit({ ...composing, composing: false })).toBe(true);
  });
});

describe('enterTarget', () => {
  it('opens nothing in bookmark mode until a row is picked', () => {
    // §7.1: with no selection, bookmark mode does not guess a target — not
    // even the top-ranked one, which is the match the reader did not choose.
    const session = { ...idleSession('bookmarks'), query: 'git' };
    expect(enterTarget(session, results)).toBeNull();
  });

  it('opens the selected row in bookmark mode', () => {
    const session = { ...idleSession('bookmarks'), query: 'git', selected: 1 };
    expect(enterTarget(session, results)).toBe('GitLab');
  });

  it('leaves web mode to the adapter', () => {
    // Enter in web mode submits the text; there is no per-row target to open.
    const session = { ...idleSession('web'), query: 'git', selected: 2 };
    expect(enterTarget(session, results)).toBeNull();
  });

  it('opens nothing when the list has gone out from under the selection', () => {
    const session = { ...idleSession('bookmarks'), query: 'git', selected: 2 };
    expect(enterTarget(session, [])).toBeNull();
    expect(pick(session, ['only'])).toBeNull();
  });
});

describe('moveSelection', () => {
  it('starts at the first row going down and the last going up', () => {
    const idle = idleSession('bookmarks');
    expect(moveSelection(idle, 1, results.length).selected).toBe(0);
    expect(moveSelection(idle, -1, results.length).selected).toBe(results.length - 1);
  });

  it('wraps instead of running off the end', () => {
    const atEnd = { ...idleSession('bookmarks'), selected: 2 };
    expect(moveSelection(atEnd, 1, results.length).selected).toBe(0);
    expect(moveSelection(atEnd, -1, results.length).selected).toBe(1);
  });

  it('clears the selection when there is nothing to select', () => {
    // A stale index over an empty list would make Enter do nothing with no way
    // to tell why.
    expect(moveSelection({ ...idleSession('bookmarks'), selected: 4 }, 1, 0).selected).toBe(-1);
  });
});

describe('typing and switching', () => {
  it('drops the selection when the query changes', () => {
    // The row at index 1 after a different query is a different bookmark.
    const session = { ...idleSession('bookmarks'), query: 'git', selected: 1 };
    expect(withQuery(session, 'gita').selected).toBe(-1);
  });

  it('keeps the text when the mode changes, and submits nothing', () => {
    const session = { ...idleSession('web'), query: 'go 官方文档' };
    const switched = withMode(session, 'bookmarks');
    expect(switched.query).toBe('go 官方文档');
    expect(switched.mode).toBe('bookmarks');
  });

  it('leaves the result state on Escape without touching what was typed elsewhere', () => {
    const session = { ...idleSession('bookmarks'), query: 'git', selected: 1, composing: true };
    expect(dismissed(session)).toEqual(idleSession('bookmarks'));
  });
});

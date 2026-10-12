// What the search box decides, kept apart from what it renders.
//
// Three rules are worth their own tests because getting them wrong is invisible
// until someone hits it: an Enter that fires in the middle of a Chinese input
// method's candidate selection, a submission that opens a guess, and a
// selection that walks past the end of the list (start-page doc §7.1, §7.4).

export type SearchMode = 'web' | 'bookmarks';

export interface SearchSession {
  mode: SearchMode;
  query: string;
  /** Whether the reader is composing text with an input method right now. */
  composing: boolean;
  /** Index into the current result list, or -1 for "nothing picked". */
  selected: number;
}

export const idleSession = (mode: SearchMode): SearchSession => ({
  mode,
  query: '',
  composing: false,
  selected: -1,
});

/**
 * May this Enter be treated as a submission?
 *
 * A blank query is never a search, and a keypress while an input method is
 * still assembling candidates belongs to the candidate list, not to this page.
 * Chrome fires keydown for both, so the difference has to be decided here.
 */
export function maySubmit(session: SearchSession): boolean {
  if (session.composing) return false;
  return session.query.trim().length > 0;
}

/**
 * What Enter opens.
 *
 * In bookmark mode only an explicitly selected result is a target; with
 * nothing picked, Enter does nothing rather than guessing the first match —
 * the first result of a fuzzy search is not what the reader asked to visit
 * (§7.1). Web mode has no per-keypress target at all: the adapter decides.
 */
export function enterTarget<T>(session: SearchSession, results: T[]): T | null {
  if (session.mode !== 'bookmarks') return null;
  return pick(session, results);
}

/** The result the selection points at, or null. */
export function pick<T>(session: SearchSession, results: T[]): T | null {
  if (results.length === 0) return null;
  if (session.selected < 0 || session.selected >= results.length) return null;
  return results[session.selected] ?? null;
}

/**
 * Move the selection with the arrow keys.
 *
 * The cursor wraps, and it starts at the first row on the way down: a reader
 * pressing 下 from nothing has said "start walking the list". Clamping matters
 * more than wrapping — a selection past the end would make Enter do nothing
 * with no way to tell why.
 */
export function moveSelection(session: SearchSession, delta: 1 | -1, count: number): SearchSession {
  if (count === 0) return { ...session, selected: -1 };
  const current = session.selected;
  let next: number;
  if (current < 0) next = delta > 0 ? 0 : count - 1;
  else next = (current + delta + count) % count;
  return { ...session, selected: next };
}

/** Typing re-opens the list and drops a selection that no longer points at the
 * same row; keeping it would let Enter fire on a row the reader never saw. */
export function withQuery(session: SearchSession, query: string): SearchSession {
  return { ...session, query, selected: -1 };
}

/** Switching mode keeps the text — the reader may want the same words looked up
 * the other way — but never submits it (§7.1). */
export function withMode(session: SearchSession, mode: SearchMode): SearchSession {
  return { ...session, mode, selected: -1 };
}

/** Escape leaves the result state without erasing what was typed, so the reader
 * can go back to browsing the folder and come again. */
export function dismissed(session: SearchSession): SearchSession {
  return { ...session, query: '', selected: -1, composing: false };
}

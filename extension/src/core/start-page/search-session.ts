// What the search box decides, kept apart from what it renders. Mirrors
// web/src/features/start-page/search-session.ts; the two live apart until a
// third consumer justifies a shared package (start-page doc §17).
//
// The rules earn their own tests because breaking them is invisible until
// someone hits it: an Enter that fires mid-way through a Chinese input method's
// candidate selection, and a submission that opens a guess.

export type SearchMode = 'web' | 'bookmarks';

export interface SearchSession {
  mode: SearchMode;
  query: string;
  /** Whether an input method is assembling candidates right now. */
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
 * A blank query is never a search, and a keypress while an input method still
 * holds the text belongs to its candidate list. Both arrive as keydown, so the
 * difference has to be decided here (§7.4).
 */
export function maySubmit(session: SearchSession): boolean {
  if (session.composing) return false;
  return session.query.trim().length > 0;
}

/** The result the selection points at, or null. */
export function pick<T>(session: SearchSession, results: T[]): T | null {
  if (results.length === 0) return null;
  if (session.selected < 0 || session.selected >= results.length) return null;
  return results[session.selected] ?? null;
}

/**
 * What Enter opens.
 *
 * In bookmark mode only an explicitly selected row is a target; with nothing
 * picked, Enter does nothing rather than guessing the top match (§7.1). Web
 * mode has no per-row target — the adapter takes the text.
 */
export function enterTarget<T>(session: SearchSession, results: T[]): T | null {
  if (session.mode !== 'bookmarks') return null;
  return pick(session, results);
}

/** Move the selection with the arrow keys, wrapping and never leaving the end
 * of the list. */
export function moveSelection(session: SearchSession, delta: 1 | -1, count: number): SearchSession {
  if (count === 0) return { ...session, selected: -1 };
  const current = session.selected;
  const next = current < 0 ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count;
  return { ...session, selected: next };
}

/** Typing drops a selection that no longer points at the same row. */
export function withQuery(session: SearchSession, query: string): SearchSession {
  return { ...session, query, selected: -1 };
}

/** Switching mode keeps the text and submits nothing (§7.1). */
export function withMode(session: SearchSession, mode: SearchMode): SearchSession {
  return { ...session, mode, selected: -1 };
}

/** Escape leaves the result state. */
export function dismissed(session: SearchSession): SearchSession {
  return { ...session, query: '', selected: -1, composing: false };
}

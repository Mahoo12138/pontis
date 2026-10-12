// Deciding what a bookmark may do when it is clicked.
//
// Mirrors web/src/lib/safe-url.ts: the extension cannot import from the web
// app, and a shared package waits for a third consumer (start-page doc §17).

/** The protocols this page navigates to. Anything else is text to copy. */
const NAVIGABLE = new Set(['http:', 'https:']);

export interface NavigableUrl {
  /** The parsed address. Navigation uses this and never the stored string:
   * the parser is what decided it is http(s), and only its output is known to
   * be the value that was checked (§16.1). */
  href: string;
  host: string;
}

/** Parse and classify a stored bookmark URL, or say it is not openable. */
export function navigableUrl(raw: string | undefined | null): NavigableUrl | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // A tab or a newline inside a scheme is what turns "javascript:" into
  // something the browser still reads as "javascript:". Refuse the string
  // outright rather than normalising it into a decision.
  if (/[\u0000-\u001F\u007F\s]/.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!NAVIGABLE.has(parsed.protocol)) return null;
  return { href: parsed.href, host: parsed.host };
}

/** What kind of refusal this is, so the row can say why it will not open. */
export function urlKind(raw: string | undefined | null): 'navigable' | 'bookmarklet' | 'other' | 'invalid' {
  if (typeof raw !== 'string' || raw.length === 0) return 'invalid';
  if (navigableUrl(raw)) return 'navigable';
  try {
    if (new URL(raw).protocol === 'javascript:') return 'bookmarklet';
  } catch {
    return 'invalid';
  }
  return 'other';
}

/** Open according to the browser's configured target.
 *
 * Only a plain activation reaches this: a middle click or a Ctrl/Cmd-click is
 * answered by the browser from the anchor's own href, and overriding those
 * would make the modifier keys mean something else than they always did
 * (§8.1, SP-20). */
export function openNavigable(url: NavigableUrl, target: 'current-tab' | 'new-tab'): void {
  if (target === 'current-tab') {
    window.location.href = url.href;
    return;
  }
  window.open(url.href, '_blank', 'noopener,noreferrer');
}

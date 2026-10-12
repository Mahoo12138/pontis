/** URL safety utilities per Pontis security requirements. */

/** Schemes that can be opened directly in a new tab. */
const SAFE_SCHEMES = ['http:', 'https:'];

/** Schemes that require user confirmation before opening. */
const CONFIRM_SCHEMES = ['ftp:', 'ssh:', 'tel:', 'mailto:', 'magnet:'];

/**
 * Classify a URL for safe handling in the Web UI.
 * - 'safe': http/https, open normally in new tab
 * - 'confirm': custom scheme, needs user confirmation
 * - 'bookmarklet': javascript:, never execute — offer "copy code" instead
 * - 'invalid': cannot be parsed
 */
export function classifyUrl(raw: string): 'safe' | 'confirm' | 'bookmarklet' | 'invalid' {
  try {
    const url = new URL(raw);
    if (url.protocol === 'javascript:') return 'bookmarklet';
    if (SAFE_SCHEMES.includes(url.protocol)) return 'safe';
    if (CONFIRM_SCHEMES.includes(url.protocol)) return 'confirm';
    return 'confirm'; // unknown scheme
  } catch {
    return 'invalid';
  }
}

/** The parsed address a click may hand to the browser, or null when the raw
 * string is not openable.
 *
 * The parsed value is what gets opened, not the stored one: `classifyUrl`
 * decided about `new URL(raw)`, and only that object is known to be http(s).
 * Passing `raw` along would let a string the parser silently repaired — a
 * leading tab, a folded scheme — be the thing that actually navigates
 * (start-page doc §16.1). */
export function safeHref(raw: string): string | null {
  if (classifyUrl(raw) !== 'safe') return null;
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
}

/** Open a URL safely. Returns true if opened, false if blocked. */
export function openUrlSafely(raw: string): boolean {
  const href = safeHref(raw);
  if (!href) {
    // bookmarklet, confirm-scheme and unparseable are all handled by the UI
    // component, which offers copy or a confirmation instead.
    return false;
  }
  window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}

/** Extract bookmarklet code from a javascript: URL. */
export function extractBookmarkletCode(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol === 'javascript:') {
      return decodeURIComponent(url.href.replace(/^javascript:/, ''));
    }
  } catch {}
  return null;
}

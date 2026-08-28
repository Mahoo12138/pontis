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

/** Open a URL safely. Returns true if opened, false if blocked. */
export function openUrlSafely(raw: string): boolean {
  const kind = classifyUrl(raw);
  if (kind === 'safe') {
    window.open(raw, '_blank', 'noopener,noreferrer');
    return true;
  }
  // bookmarklet and confirm are handled by the UI component
  return false;
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

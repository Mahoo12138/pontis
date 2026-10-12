// The web UI renders user-supplied URLs from another machine's bookmark tree.
// A javascript: URL must never be reachable through the "open" path, and an
// unrecognized scheme must not be silently treated as safe.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { classifyUrl, extractBookmarkletCode, openWithTarget, safeHref } from './safe-url';
import { extractHost } from './format';

describe('classifyUrl', () => {
  it('treats http and https as openable', () => {
    expect(classifyUrl('https://example.com')).toBe('safe');
    expect(classifyUrl('http://example.com/a?b=1#c')).toBe('safe');
    // The URL parser lowercases the scheme.
    expect(classifyUrl('HTTPS://example.com')).toBe('safe');
  });

  it('never classifies a javascript: URL as openable', () => {
    expect(classifyUrl('javascript:alert(1)')).toBe('bookmarklet');
    expect(classifyUrl('JavaScript:alert(1)')).toBe('bookmarklet');
    // Tab and newline are stripped by the URL parser, so these still parse
    // as javascript: — they must not fall through to 'safe'.
    expect(classifyUrl('java\tscript:alert(1)')).toBe('bookmarklet');
    expect(classifyUrl('java\nscript:alert(1)')).toBe('bookmarklet');
    expect(classifyUrl('  javascript:alert(1)')).toBe('bookmarklet');
  });

  it('asks before opening a non-http scheme', () => {
    expect(classifyUrl('mailto:a@example.com')).toBe('confirm');
    expect(classifyUrl('magnet:?xt=urn:btih:abc')).toBe('confirm');
    expect(classifyUrl('ftp://example.com')).toBe('confirm');
    // An unknown scheme is not the same as a safe one.
    expect(classifyUrl('data:text/html,<script>alert(1)</script>')).toBe('confirm');
    expect(classifyUrl('file:///etc/passwd')).toBe('confirm');
  });

  it('reports a URL that cannot be parsed as invalid', () => {
    expect(classifyUrl('not a url')).toBe('invalid');
    expect(classifyUrl('')).toBe('invalid');
    expect(classifyUrl('example.com')).toBe('invalid');
  });
});

describe('extractBookmarkletCode', () => {
  it('decodes the body of a javascript: URL', () => {
    expect(extractBookmarkletCode('javascript:alert(1)')).toBe('alert(1)');
    expect(extractBookmarkletCode('javascript:%20foo%28%29')).toBe(' foo()');
  });

  it('returns null for anything that is not a bookmarklet', () => {
    expect(extractBookmarkletCode('https://example.com')).toBeNull();
    expect(extractBookmarkletCode('garbage')).toBeNull();
  });
});

describe('extractHost', () => {
  it('falls back to the raw string when there is no host', () => {
    expect(extractHost('https://example.com:8443/a')).toBe('example.com:8443');
    expect(extractHost('mailto:a@example.com')).toBe('');
    expect(extractHost('javascript:alert(1)')).toBe('');
    expect(extractHost('not a url')).toBe('not a url');
  });
});

describe('safeHref', () => {
  it('hands back the parsed address, not the string it was given', () => {
    // Whatever the classifier accepted is opened in its parsed form, so the
    // value that navigates is the value that was checked (§16.1).
    expect(safeHref('https://example.com/a/b?x=1#frag')).toBe('https://example.com/a/b?x=1#frag');
    expect(safeHref('HTTPS://EXAMPLE.COM')).toBe('https://example.com/');
  });

  it('gives nothing to a scheme that must not execute here', () => {
    for (const raw of [
      'javascript:alert(1)',
      ' data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'chrome://settings',
      'view-source:https://example.com',
      'not a url',
      '',
    ]) {
      expect(safeHref(raw)).toBeNull();
    }
  });

  it('does not let an obfuscated scheme through', () => {
    // The parser strips tabs and newlines before reading a scheme, so these
    // still mean javascript:. safeHref refuses them rather than returning the
    // original string with its whitespace intact.
    expect(safeHref('java\tscript:alert(1)')).toBeNull();
    expect(safeHref('  javascript:alert(1)')).toBeNull();
  });
});

describe('openWithTarget', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      open: vi.fn(),
      location: { href: '' },
    });
  });

  it('follows the browser preference on a plain activation', () => {
    window.open('https://example.com', '_blank');
    expect(openWithTarget('https://example.com', 'new-tab')).toBe(true);
    expect(window.open).toHaveBeenCalledWith(
      'https://example.com/',
      '_blank',
      'noopener,noreferrer',
    );

    expect(openWithTarget('https://example.com', 'current-tab')).toBe(true);
    expect(window.location.href).toBe('https://example.com/');
  });

  it('opens nothing for a URL it will not vouch for', () => {
    expect(openWithTarget('javascript:alert(1)', 'new-tab')).toBe(false);
    expect(window.open).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');
  });
});

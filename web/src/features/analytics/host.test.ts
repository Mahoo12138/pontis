// The domain chart answers "which sites do I actually use", which requires
// folding subdomains together. Counting raw hosts instead would spend most of
// the list on `www.` / `blog.` / `docs.` variants of the same five sites.

import { describe, expect, it } from 'vitest';
import {
  registrableHost,
  schemeGroup,
  schemeOf,
  hasTrackingParam,
  isIpLiteral,
  TRACKING_PARAMS,
} from './host';

describe('registrableHost', () => {
  it('collapses subdomains into the site', () => {
    expect(registrableHost('https://blog.github.com/posts')).toBe('github.com');
    expect(registrableHost('https://docs.rust-lang.org/')).toBe('rust-lang.org');
  });

  it('strips www so the same site is not two bars', () => {
    expect(registrableHost('https://www.github.com')).toBe('github.com');
  });

  it('drops the port, which extractHost keeps', () => {
    expect(registrableHost('http://localhost:3000/api')).toBe('localhost');
    expect(registrableHost('http://127.0.0.1:8080/')).toBe('127.0.0.1');
  });

  it('keeps three labels for a multi-part public suffix', () => {
    // Without this, every Chinese site collapses to the bar labelled `com.cn`.
    expect(registrableHost('https://news.sina.com.cn/world')).toBe('sina.com.cn');
    expect(registrableHost('https://zhuanlan.zhihu.com/x')).toBe('zhihu.com');
    expect(registrableHost('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
  });

  it('leaves single-label and already-short hosts alone', () => {
    expect(registrableHost('http://intranet/page')).toBe('intranet');
    expect(registrableHost('https://example.com')).toBe('example.com');
  });

  it('lowercases', () => {
    expect(registrableHost('https://GitHub.COM')).toBe('github.com');
  });

  it('returns null for a url with no host rather than an empty label', () => {
    expect(registrableHost('mailto:someone@example.com')).toBeNull();
    expect(registrableHost('javascript:void(0)')).toBeNull();
    expect(registrableHost('data:text/plain,hi')).toBeNull();
    expect(registrableHost('not a url')).toBeNull();
  });

  it('does not reduce a bare www host to the empty string', () => {
    expect(registrableHost('http://www')).toBe('www');
  });

  it('treats ip literals as their own site', () => {
    expect(isIpLiteral('192.168.1.1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
    expect(registrableHost('http://10.0.0.5/')).toBe('10.0.0.5');
  });
});

describe('schemeGroup / schemeOf', () => {
  it('separates https from http, because the migration is a real story', () => {
    expect(schemeGroup('https://a.test')).toBe('https');
    expect(schemeGroup('http://a.test')).toBe('http');
    expect(schemeGroup('file:///tmp/x')).toBe('other');
    expect(schemeGroup('chrome://settings')).toBe('other');
  });

  it('names the exact scheme behind the other bucket', () => {
    expect(schemeOf('file:///tmp/x')).toBe('file');
    expect(schemeOf('chrome://settings')).toBe('chrome');
    expect(schemeOf('nonsense')).toBe('(无协议)');
  });
});

describe('hasTrackingParam', () => {
  it('detects the parameters the organizer strips', () => {
    for (const key of TRACKING_PARAMS) {
      expect(hasTrackingParam(`https://a.test/p?${key}=x`)).toBe(true);
    }
  });

  it('detects utm variants the organizer exact-key list would miss', () => {
    expect(hasTrackingParam('https://a.test/p?utm_campaign_id=7')).toBe(true);
  });

  it('ignores ordinary query parameters', () => {
    expect(hasTrackingParam('https://a.test/p?id=7&page=2')).toBe(false);
  });

  it('is false for an unparseable url instead of throwing', () => {
    expect(hasTrackingParam('not a url?utm_source=x')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  offerUpdate,
  parseExtensionRelease,
  type ExtensionReleaseWire,
} from './release';

function releaseWith(overrides: Record<string, unknown> = {}): ExtensionReleaseWire {
  return {
    release: 'v0.2.0',
    commit: 'abc',
    generated_at: '2026-10-14T00:00:00.000Z',
    server_version: '0.2.0',
    http_api_version: 'v1',
    artifacts: [
      {
        platform: 'chromium',
        variant: 'sync',
        version: '0.2.0',
        file: '/downloads/extensions/chromium/sync/v0.2.0.zip',
        sha256: 'x',
        size_bytes: 291_956,
        manifest_version: 3,
        min_server_version: '0.1.0',
        supported_browsers: ['chrome'],
        sync_protocol_versions: [1],
        ...overrides,
      },
    ],
  };
}

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    // The trap doc §7 names: a string compare puts 1.9.0 above 1.10.0.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  });

  it('treats a missing component as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0.1', '1.2')).toBe(1);
  });

  it('reads a non-numeric component as zero rather than guessing', () => {
    // A suffix this build cannot order must never make it claim the release is
    // newer than the one it is looking at.
    expect(compareVersions('1.2.0-beta', '1.2.0')).toBe(0);
    expect(compareVersions('', '0.0.0')).toBe(0);
  });
});

describe('offerUpdate', () => {
  it('offers the instance package only when it is actually newer', () => {
    expect(offerUpdate(releaseWith(), { platform: 'chromium', variant: 'sync', version: '0.1.0' }))
      .toEqual({ version: '0.2.0', protocolMismatch: false });
    expect(offerUpdate(releaseWith(), { platform: 'chromium', variant: 'sync', version: '0.2.0' })).toBeNull();
    expect(offerUpdate(releaseWith(), { platform: 'chromium', variant: 'sync', version: '0.3.0' })).toBeNull();
  });

  it('never sends one package to the other one update', () => {
    // The two Chromium builds differ by whether they own the new tab. Offering
    // the takeover package to a standard install would start overriding the tab
    // on a machine that never asked it to (start-page doc §9.2), and the reverse
    // would leave a takeover install with no way to update.
    expect(offerUpdate(releaseWith(), {
      platform: 'chromium', variant: 'start-page', version: '0.1.0',
    })).toBeNull();
  });

  it('stays silent when this build has no artifact', () => {
    // A Firefox build reading a Chromium-only release list has nothing to take.
    expect(offerUpdate(releaseWith(), { platform: 'firefox', variant: 'sync', version: '0.1.0' })).toBeNull();
    expect(offerUpdate({ ...releaseWith(), artifacts: [] }, { platform: 'chromium', variant: 'sync', version: '0.1.0' }))
      .toBeNull();
  });

  it('flags a protocol the two sides do not share', () => {
    const release = releaseWith({ sync_protocol_versions: [2] });
    const offer = offerUpdate(release, {
      platform: 'chromium', variant: 'sync', version: '0.1.0', protocol: 1,
    });
    expect(offer).toEqual({ version: '0.2.0', protocolMismatch: true });
  });
});

describe('parseExtensionRelease', () => {
  it('accepts the body the server emits', () => {
    const parsed = parseExtensionRelease(releaseWith());
    expect(parsed.artifacts[0]?.version).toBe('0.2.0');
    expect(parsed.server_version).toBe('0.2.0');
  });

  it('refuses a body a hint cannot be built from', () => {
    expect(() => parseExtensionRelease(null)).toThrow(/object/);
    expect(() => parseExtensionRelease({ artifacts: null })).toThrow(/array/);
    expect(() => parseExtensionRelease({ artifacts: [{ platform: 'chromium' }] })).toThrow(/version/);
    expect(() => parseExtensionRelease({
      artifacts: [{ platform: 'chromium', version: '0.2.0', sync_protocol_versions: 'one' }],
    })).toThrow(/sync_protocol_versions/);
  });

  it('keeps an unknown extra field rather than dropping it', () => {
    // The release list may grow a field before this build learns about it; a
    // hint that ignores the new one is still a correct hint.
    const parsed = parseExtensionRelease({ ...releaseWith(), next_thing: true });
    expect(parsed.artifacts).toHaveLength(1);
  });
});

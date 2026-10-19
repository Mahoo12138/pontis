// What this instance offers the extension to upgrade to (distribution doc §10.3).
//
// The rule that shapes this file: the answer is metadata, and metadata only.
// The extension reads a version, compares it with the one it was built with,
// and points the person at the instance's install page. It never fetches a
// package and runs what is inside it — doc §1.2 refuses that outright, and a
// browser would refuse it too.
//
// The validation here is lighter than the sync parsers on purpose. A malformed
// release body costs a missing hint; a malformed sync body costs a corrupted
// replica, so only that one has to be paranoid.

import { SYNC_PROTOCOL_VERSION } from '../protocol/types';

export class ReleaseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseShapeError';
  }
}

/** One downloadable package, as the server's catalog describes it. */
export interface ReleaseArtifactWire {
  platform: string;
  /** Which package within a platform: `sync` or `start-page` for Chromium. */
  variant: string;
  version: string;
  /** The instance-relative download URL. Kept as a string: nothing here fetches it. */
  file: string;
  sha256: string;
  size_bytes: number;
  manifest_version: number;
  min_server_version: string;
  supported_browsers: string[];
  sync_protocol_versions: number[];
}

export interface ExtensionReleaseWire {
  release: string;
  commit: string;
  generated_at: string;
  server_version: string;
  http_api_version: string;
  artifacts: ReleaseArtifactWire[];
}

/**
 * Accept only a body the hint can be built from. An older server has no such
 * route at all and fails at the request, which the caller treats the same way:
 * no news, no notice.
 */
export function parseExtensionRelease(json: unknown): ExtensionReleaseWire {
  if (json === null || typeof json !== 'object') {
    throw new ReleaseShapeError(`release body must be an object, got ${JSON.stringify(json)}`);
  }
  const body = json as Record<string, unknown>;
  if (!Array.isArray(body.artifacts)) {
    throw new ReleaseShapeError(`release artifacts must be an array, got ${JSON.stringify(body.artifacts)}`);
  }
  const artifacts = (body.artifacts as unknown[]).map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new ReleaseShapeError(`release artifact must be an object, got ${JSON.stringify(entry)}`);
    }
    const a = entry as Record<string, unknown>;
    if (typeof a.platform !== 'string' || typeof a.variant !== 'string' || typeof a.version !== 'string') {
      throw new ReleaseShapeError(
        `release artifact needs a platform, a variant and a version, got ${JSON.stringify(entry)}`,
      );
    }
    if (!Array.isArray(a.sync_protocol_versions)
      || !a.sync_protocol_versions.every((v) => typeof v === 'number')) {
      throw new ReleaseShapeError(
        `release artifact ${a.platform} has no usable sync_protocol_versions, got ${JSON.stringify(a.sync_protocol_versions)}`,
      );
    }
    return {
      platform: a.platform,
      variant: a.variant,
      version: a.version,
      file: typeof a.file === 'string' ? a.file : '',
      sha256: typeof a.sha256 === 'string' ? a.sha256 : '',
      size_bytes: typeof a.size_bytes === 'number' ? a.size_bytes : 0,
      manifest_version: typeof a.manifest_version === 'number' ? a.manifest_version : 0,
      min_server_version: typeof a.min_server_version === 'string' ? a.min_server_version : '',
      supported_browsers: Array.isArray(a.supported_browsers)
        ? (a.supported_browsers as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
      sync_protocol_versions: a.sync_protocol_versions as number[],
    };
  });
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    release: text(body.release),
    commit: text(body.commit),
    generated_at: text(body.generated_at),
    server_version: text(body.server_version),
    http_api_version: text(body.http_api_version),
    artifacts,
  };
}

/**
 * Compare two dotted numeric versions component by component.
 *
 * A string compare answers `1.9.0 > 1.10.0`, which is the wrong answer in the
 * one place a wrong answer here is expensive: the upgrade that never gets
 * offered, or the "update" a person takes down to a version older than their
 * own. Doc §7 names this explicitly.
 */
export function compareVersions(a: string, b: string): number {
  const left = components(a);
  const right = components(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** A non-numeric component reads as zero, so an unexpected suffix never makes
 * this build think it is newer than the release on offer. */
function components(version: string): number[] {
  return String(version ?? '')
    .split('.')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
}

/**
 * The artifact family this build belongs to.
 *
 * Hardcoded, deliberately: V1 distributes Chromium only, and a Firefox package
 * would have to be an AMO-signed XPI before it could be installed at all
 * (distribution doc §11). Reading WXT's `import.meta.env.BROWSER` instead looked
 * forward-compatible but cost something concrete — that type only exists once
 * `wxt prepare` has generated `.wxt/types`, so `pnpm typecheck` in a fresh
 * checkout failed on it. When Firefox ships, this is the line to revisit, with a
 * real target to build for.
 */
export function platformForBuild(): string {
  return 'chromium';
}

/** Which of the two Chromium packages this copy was built from. The new tab is
 * chosen at install time and cannot be switched afterwards, so the two builds
 * differ by one manifest line and a reader cannot tell them apart from the icon
 * — an update offer has to match the variant too, or a sync install would be
 * sent to a takeover package, which is the change start-page doc §9.2 refuses.
 *
 * The define exists only in a production build; under vitest it is absent, and
 * the standard package is the honest default. */
export function variantForBuild(): string {
  return typeof __PONTIS_NEWTAB_BUILD__ !== 'undefined' && __PONTIS_NEWTAB_BUILD__
    ? 'start-page'
    : 'sync';
}

export function metadataForBuild(): { release: string; commit: string; dirty: boolean } {
  return typeof __PONTIS_BUILD_METADATA__ !== 'undefined'
    ? __PONTIS_BUILD_METADATA__
    : { release: '', commit: '', dirty: false };
}

interface ReleaseVersion { version: string; prerelease: string[] }

/** Release tags use SemVer precedence; the numeric browser manifest remains
 * unchanged. Build timestamps, commits and archive hashes cannot establish an
 * ordering. Reject unknown syntax instead of guessing an update direction. */
function parseReleaseTag(tag: string | undefined): ReleaseVersion | null {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag ?? '');
  if (!match) return null;
  const prerelease = match[2]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && /^0\d/.test(part))) return null;
  return { version: match[1]!, prerelease };
}

function comparePrereleases(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === r) continue;
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) < BigInt(r) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export interface UpdateOffer {
  version: string;
  release?: string;
  /** The offered package speaks no protocol this build does. Upgrading is
   * probably the fix, but it is not a quiet one, so the notice says so. */
  protocolMismatch: boolean;
}

/**
 * A greater numeric version retains the legacy behavior. Equal numeric versions
 * require known release identities on both sides; a dev/legacy installation has
 * insufficient evidence to order releases. Identical releases rebuilt with new
 * ZIP timestamps remain silent.
 */
export function offerUpdate(
  release: ExtensionReleaseWire,
  own: { platform: string; variant: string; version: string; release?: string; protocol?: number },
): UpdateOffer | null {
  const artifact = release.artifacts.find(
    (a) => a.platform === own.platform && a.variant === own.variant,
  );
  if (!artifact) return null;
  const validNumeric = (version: string) => /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3}$/.test(version)
    && version.split('.').every((part) => Number.isSafeInteger(Number(part)));
  if (!validNumeric(artifact.version) || !validNumeric(own.version)) return null;
  const numericOrder = compareVersions(artifact.version, own.version);
  if (numericOrder < 0) return null;
  const nextTag = parseReleaseTag(release.release);
  const ownTag = parseReleaseTag(own.release);
  const nextRelease = nextTag?.version === artifact.version ? release.release : undefined;
  if (numericOrder === 0 && (!nextRelease || !ownTag || ownTag.version !== own.version
    || comparePrereleases(nextTag!.prerelease, ownTag.prerelease) <= 0)) return null;
  return {
    version: artifact.version,
    ...(nextRelease ? { release: nextRelease } : {}),
    protocolMismatch: !artifact.sync_protocol_versions.includes(own.protocol ?? SYNC_PROTOCOL_VERSION),
  };
}

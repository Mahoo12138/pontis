// Stages the built extension packages where the Go binary embeds them.
//
// Same constraint as stage-web-dist: `go:embed` cannot reach outside its own
// package, so a release build copies the ZIPs into
// server/internal/distribution/artifacts and writes the manifest the download
// API serves (distribution doc §3, §4).
//
// It verifies rather than trusts. Whatever this script accepts is what a
// person loads as an unpacked extension and syncs real bookmarks with, so a
// wrong build — the E2E bundle with host permissions pre-granted, a source
// archive, an output half-written by a crashed build — must stop the build
// here instead of becoming a release. Every check below is one of the ways
// that happens quietly.
import { createHash } from 'node:crypto';
import { resolveBuildMetadata, verifyPackageMetadata } from './build-metadata.mjs';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What ships in this batch: two Chromium packages built from one codebase.
 *
 * Taking over the new tab cannot be a switch inside the standard extension —
 * `chrome_url_overrides` is read when the extension installs and no API changes
 * it afterwards — so it is its own artifact, and a person who wants both
 * behaviours pays two installs (start-page doc §0.2, §0.4). Firefox needs an
 * AMO-signed XPI and is out of V1: an unsigned ZIP renamed to `.xpi` is not a
 * package (doc §11).
 */
const PACKAGES = [
  {
    variant: 'sync',
    outDir: '.output',
    zipBase: 'pontis-chromium',
    manifestName: 'Pontis',
    takesOverNewTab: false,
    buildCommand: 'pnpm --filter @pontis/extension zip',
  },
  {
    variant: 'start-page',
    outDir: '.output-newtab',
    zipBase: 'pontis-chromium-newtab',
    manifestName: 'Pontis (起始页)',
    takesOverNewTab: true,
    buildCommand: 'pnpm --filter @pontis/extension zip:newtab',
  },
];

const PLATFORM = 'chromium';
const MANIFEST_VERSION = 3;
// Compared as sets. `tabs` is not on this list by design: the permission
// boundary in start-page doc §16.4 is a stated constraint, and a build that
// grew one should fail a release build rather than ship and be noticed later.
const PERMISSIONS = ['alarms', 'bookmarks', 'search', 'storage'];
// Oldest server these packages are tested against. It is a declaration, not a
// derivation: the extension compares it with `/meta`, so it changes when the
// extension stops working against an older server, not when a server releases.
const MIN_SERVER_VERSION = '0.1.0';
// Browsers these packages have been *installed in* end to end. The Chromium ZIP
// loads in Edge too, but doc §16.2 makes shared support a test result rather
// than an assumption, so Edge joins this list when someone runs it.
const SUPPORTED_BROWSERS = ['chrome'];

const artifactsDir = join(root, 'server', 'internal', 'distribution', 'artifacts');

function main() {
  const expected = extensionVersion();
  const metadata = resolveBuildMetadata({ root, version: expected });
  resetArtifactsDir();
  const artifacts = PACKAGES.map((pkg) => stagePackage(pkg, expected, metadata));

  const release = {
    release: metadata.release,
    commit: metadata.commit,
    generated_at: new Date().toISOString(),
    artifacts,
  };
  writeFileSync(join(artifactsDir, 'manifest.json'), `${JSON.stringify(release, null, 2)}\n`);
  for (const a of artifacts) {
    console.log(`staged ${a.name} (${a.size_bytes} bytes, sha256 ${a.sha256.slice(0, 16)}…)`);
  }
  console.log(`-> ${artifactsDir}`);
}

function stagePackage(pkg, expectedVersion, metadata) {
  const source = join(root, 'extension', pkg.outDir, `${pkg.zipBase}-${expectedVersion}.zip`);
  const zip = readArchive(source, pkg);
  const manifest = readEntryManifest(zip);
  verify(zip, manifest, pkg, expectedVersion);
  const rawMetadata = readEntry(zip, 'pontis-build.json');
  try {
    verifyPackageMetadata(rawMetadata ? JSON.parse(rawMetadata.toString('utf8')) : null, metadata);
  } catch (error) {
    fail(`${zip.path}: ${error.message}`);
  }

  const version = String(manifest.version);
  // The copy is what the binary carries; hashing the bytes before the copy and
  // again after is the only way the download API can mean anything when it
  // reports a digest.
  const bytes = readFileSync(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Different alpha releases (and rebuilds) may have the same numeric manifest
  // version. The digest identifies bytes in the URL; it never orders updates.
  const fileName = `pontis-${PLATFORM}-${pkg.variant}-v${version}-${sha256}.zip`;
  const url = `/downloads/extensions/${PLATFORM}/${pkg.variant}/v${version}-${sha256}.zip`;
  copyFileSync(source, join(artifactsDir, fileName));

  return {
    platform: PLATFORM,
    variant: pkg.variant,
    version,
    file: url,
    name: fileName,
    sha256,
    size_bytes: bytes.length,
    manifest_version: manifest.manifest_version,
    min_server_version: MIN_SERVER_VERSION,
    supported_browsers: [...SUPPORTED_BROWSERS],
  };
}

// --- inputs ------------------------------------------------------------------

function extensionVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'extension', 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    fail('extension/package.json carries no version');
  }
  return pkg.version;
}

// --- ZIP reading -------------------------------------------------------------
//
// Parsed directly rather than through a dependency or an `unzip` shell-out:
// the checks need the central directory (names, methods, sizes) and one
// decompressed entry, which is a few dozen lines against a format that has not
// changed, and a release build must not hinge on a binary the runner may
// not have.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function readArchive(path, pkg) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(
      `${path} is not a file — run \`${pkg.buildCommand}\` first. The name comes from ` +
        'zip.artifactTemplate in extension/wxt.config.ts.',
    );
  }
  const buffer = readFileSync(path);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === null) fail(`${path} is not a ZIP: no end-of-central-directory record`);

  const count = buffer.readUInt16LE(eocd + 10);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    fail(`${path} is a ZIP64 archive, which this reader does not parse`);
  }

  const entries = new Map();
  let cursor = offset;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      fail(`${path}: central directory entry ${i} is unreadable — truncated output?`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      fail(`${path}: ${name} is a ZIP64 entry, which this reader does not parse`);
    }
    entries.set(name, { name, method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { path, buffer, entries };
}

function findEndOfCentralDirectory(buffer) {
  // A comment may be up to 65535 bytes, so the record itself is within the last
  // 64 KiB + 22. Scanning backwards finds the real one; a forward scan can hit
  // the signature inside comment bytes.
  const floor = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return null;
}

function readEntry(zip, name) {
  const entry = zip.entries.get(name);
  if (entry === undefined) return null;
  const header = zip.buffer.readUInt32LE(entry.localOffset);
  if (header !== LOCAL_SIGNATURE) fail(`${zip.path}: ${name} has no local file header`);
  const nameLength = zip.buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = zip.buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  // Sizes come from the central directory: a streamed local header carries
  // zeros there, and trusting it would inflate a truncated stream.
  const raw = zip.buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 8) return inflateRawSync(raw);
  if (entry.method === 0) return raw;
  fail(`${zip.path}: ${name} uses unsupported compression method ${entry.method}`);
}

function readEntryManifest(zip) {
  const raw = readEntry(zip, 'manifest.json');
  if (raw === null) {
    fail(`${zip.path} has no manifest.json at its root — this is not a loadable extension package`);
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return fail(`${zip.path}: manifest.json is not valid JSON (${e.message})`);
  }
}

// --- checks ------------------------------------------------------------------

function verify(zip, manifest, pkg, expectedVersion) {
  if (manifest.manifest_version !== MANIFEST_VERSION) {
    fail(`${zip.path}: manifest_version is ${manifest.manifest_version}, expected ${MANIFEST_VERSION}`);
  }
  if (manifest.name !== pkg.manifestName) {
    fail(
      `${zip.path}: manifest name is ${JSON.stringify(manifest.name)}, expected ` +
        `${JSON.stringify(pkg.manifestName)} — the wrong variant, or the E2E build, staged as ${pkg.variant}`,
    );
  }
  if (manifest.version !== expectedVersion) {
    fail(`${zip.path}: manifest version ${manifest.version} != extension/package.json ${expectedVersion}`);
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    fail(`${zip.path}: manifest version ${JSON.stringify(manifest.version)} is not a dotted triple`);
  }

  // The one property that actually distinguishes the two packages. A sync build
  // shipped as `start-page` would quietly never take over the tab; a takeover
  // build shipped as `sync` would start owning the tab on a machine that never
  // asked it to, which is the failure start-page doc §9.2 refuses.
  const overrides = manifest.chrome_url_overrides ?? {};
  if (Boolean(overrides.newtab) !== pkg.takesOverNewTab) {
    fail(
      `${zip.path}: chrome_url_overrides.newtab is ${overrides.newtab ? 'present' : 'absent'}, but the ` +
        `${pkg.variant} package is labelled ${pkg.takesOverNewTab ? 'as taking' : 'as not taking'} over the tab`,
    );
  }
  if (pkg.takesOverNewTab && !zip.entries.has('newtab.html')) {
    fail(`${zip.path}: the manifest claims a new-tab override but the package has no newtab.html`);
  }

  const declared = [...(manifest.permissions ?? [])].sort().join(',');
  if (declared !== [...PERMISSIONS].sort().join(',')) {
    fail(
      `${zip.path}: permissions drifted\n` +
        `         expected ${JSON.stringify(PERMISSIONS)}\n` +
        `         found    ${JSON.stringify(manifest.permissions ?? [])}`,
    );
  }
  // The E2E bundle puts the server origin in host_permissions because no
  // automation can click the pairing grant. Shipping it would hand every
  // downloaded package permissions the ordinary build does not have.
  const host = manifest.host_permissions ?? [];
  if (host.length > 0) {
    fail(`${zip.path}: a release package cannot carry host_permissions (${JSON.stringify(host)})`);
  }
  if ('key' in manifest) {
    // The ID is path-derived for unpacked installs on purpose (doc §10.1); a
    // key appearing here means someone generated one without deciding where
    // its private half lives.
    fail(`${zip.path}: manifest declares a "key"; V1 pins no extension ID (doc §10.1)`);
  }

  // A directory that leaked into the archive, or an entry a caller would
  // extract outside its target, both fail here rather than at the browser.
  for (const name of zip.entries.keys()) {
    if (name.startsWith('/') || name.includes('\\') || name.includes(':')) {
      fail(`${zip.path}: entry ${JSON.stringify(name)} is not a relative path`);
    }
    const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
    // An empty segment is `a//b`, `.` is self-reference and `..` walks out: a
    // tool that unpacks this archive would write outside its target.
    if (segments.some((part) => part === '' || part === '.' || part === '..')) {
      fail(`${zip.path}: entry ${JSON.stringify(name)} is not a plain relative path`);
    }
    if (/\.(pem|p12|pfx|key)$/.test(name) || /(^|\/)\.env(\.|$)/.test(name)) {
      fail(`${zip.path}: entry ${JSON.stringify(name)} looks like a secret and must not ship`);
    }
  }
  if (!zip.entries.has('background.js')) {
    fail(`${zip.path} has no background.js — the build is incomplete`);
  }
}

// --- output ------------------------------------------------------------------

function resetArtifactsDir() {
  // Rebuilt from scratch, so nothing an earlier batch left behind can still be
  // downloaded (doc §5 step 7).
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });
  // Same placeholder as the web dist: `go:embed` needs one match in a checkout
  // that has never run a release build.
  writeFileSync(
    join(artifactsDir, '.gitkeep'),
    'Placeholder so `go build ./...` works before a release build stages the extension packages here.\n',
  );
}

function fail(message) {
  console.error(`stage-distribution: ${message}`);
  process.exit(1);
}

// Called last: the checks read constants declared below main's own body.
main();

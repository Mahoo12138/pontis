// Asserts every place a release version is written says the same thing.
//
// A tag is what triggers a release, but the version an instance reports comes
// from a Go constant, the extension's identity comes from its manifest, and the
// packages come from their package.json files. When those drift the release is
// untraceable: the download page shows one version, /meta another, and the
// update hint spends its time comparing the two. Doc §14.4 asks for exactly this
// gate — "Tag、Server Binary、Docker、Artifact Manifest 中版本来源一致且可追溯".
//
//   node scripts/assert-release-version.mjs v0.1.0
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NPM_MANIFESTS = [
  'web/package.json',
  'extension/package.json',
  'packages/api/package.json',
  'packages/i18n/package.json',
  'packages/protocol/package.json',
];

const sources = [
  ...NPM_MANIFESTS.map((file) => ({
    file,
    read: (text) => JSON.parse(text).version,
  })),
  {
    file: 'server/internal/httpapi/server.go',
    // The constant /meta reports as product_version. Anchored to the
    // declaration, so a comment that merely quotes it cannot satisfy this.
    read: (text) => /(?:^|\n)\s*const ProductVersion = "([^"]+)"/.exec(text)?.[1],
  },
];

const tag = process.argv[2] || fromGit();
if (!tag) {
  console.error('assert-release-version: pass a tag (v0.1.0) or run inside a tagged commit');
  process.exit(1);
}

const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
if (!match) {
  console.error(`assert-release-version: "${tag}" is not a v<major>.<minor>.<patch> tag`);
  process.exit(1);
}
const wanted = match[1];

const problems = [];
for (const source of sources) {
  const text = readFileSync(join(root, source.file), 'utf8');
  const found = source.read(text);
  if (found === undefined) {
    problems.push(`${source.file}: no version found where one was expected`);
  } else if (found !== wanted) {
    problems.push(`${source.file}: ${found}, tag says ${wanted}`);
  }
}

if (problems.length > 0) {
  console.error(`assert-release-version: ${tag} does not match the tree:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('Either bump them together or move the tag. A release whose version');
  console.error('depends on who is asked is worse than no release.');
  process.exit(1);
}

console.log(`${tag}: all ${sources.length} version sources agree`);

function fromGit() {
  try {
    return execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return '';
  }
}

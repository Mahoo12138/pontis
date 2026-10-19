import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuildMetadata, verifyPackageMetadata } from './build-metadata.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function fixture(git = true) {
  const root = mkdtempSync(join(tmpdir(), 'pontis-build-identity-'));
  dirs.push(root);
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git) {
    run('init', '-q');
    run('config', 'user.email', 'build@example.test');
    run('config', 'user.name', 'Build Test');
    writeFileSync(join(root, 'source'), 'first');
    run('add', '.');
    run('commit', '-qm', 'first');
  }
  const resolve = (env = {}) => resolveBuildMetadata({ root, version: '0.1.0', env });
  return { root, run, resolve };
}

test('only an exact clean tag identifies a release; descendants do not inherit it', () => {
  const f = fixture();
  assert.equal(f.resolve().release, '');
  f.run('tag', 'v0.1.0-alpha.2');
  assert.deepEqual(f.resolve(), { release: 'v0.1.0-alpha.2', commit: f.run('rev-parse', 'HEAD'), dirty: false });
  writeFileSync(join(f.root, 'source'), 'next');
  f.run('commit', '-qam', 'next');
  assert.equal(f.resolve().release, '');
});

test('tracked and untracked edits cannot masquerade as a tagged release', () => {
  const f = fixture();
  f.run('tag', 'v0.1.0-alpha.2');
  writeFileSync(join(f.root, 'source'), 'dirty');
  assert.equal(f.resolve().release, '');
  assert.equal(f.resolve().dirty, true);
  assert.throws(() => f.resolve({ PONTIS_RELEASE: 'v0.1.0-alpha.2' }), /dirty/);
  f.run('checkout', '--', 'source');
  writeFileSync(join(f.root, 'new-source'), 'untracked');
  assert.equal(f.resolve().release, '');
});

test('explicit metadata is accepted without .git for Docker and checked against Git when present', () => {
  const f = fixture(false);
  const commit = 'a'.repeat(40);
  assert.deepEqual(f.resolve({ PONTIS_RELEASE: 'v0.1.0-alpha.3', PONTIS_RELEASE_COMMIT: commit }),
    { release: 'v0.1.0-alpha.3', commit, dirty: false });
  assert.deepEqual(f.resolve(), { release: '', commit: '', dirty: false });
  const g = fixture();
  g.run('tag', 'v0.1.0-alpha.2');
  assert.throws(() => g.resolve({ PONTIS_RELEASE: 'v0.1.0-alpha.3' }), /HEAD/);
  assert.throws(() => g.resolve({ PONTIS_RELEASE: 'v0.1.0-alpha.2', PONTIS_RELEASE_COMMIT: commit }), /commit/);
  assert.equal(g.resolve({ PONTIS_RELEASE: 'v0.1.0-alpha.2', PONTIS_RELEASE_COMMIT: g.run('rev-parse', 'HEAD') }).release,
    'v0.1.0-alpha.2');
});

test('rejects invalid or inconsistent caller-supplied release metadata', () => {
  const f = fixture(false);
  for (const release of ['main', 'v0.1.0-alpha.02', 'v0.1.0-', 'v0.1.0+local', 'v0.2.0']) {
    assert.throws(() => f.resolve({ PONTIS_RELEASE: release, PONTIS_RELEASE_COMMIT: 'b'.repeat(40) }));
  }
  assert.throws(() => f.resolve({ PONTIS_RELEASE: 'v0.1.0-alpha.2' }), /commit/);
  assert.throws(() => f.resolve({ PONTIS_RELEASE_COMMIT: 'not-a-commit' }), /commit/);
});

test('multiple exact release tags need an explicit choice instead of selecting an arbitrary tag', () => {
  const f = fixture();
  f.run('tag', 'v0.1.0-alpha.2');
  f.run('tag', 'v0.1.0');
  assert.equal(f.resolve().release, '');
  assert.equal(f.resolve({ PONTIS_RELEASE: 'v0.1.0' }).release, 'v0.1.0');
});

test('stale ZIP identities cannot be relabelled by the catalog', () => {
  const metadata = { release: 'v0.1.0-alpha.3', commit: 'a'.repeat(40), dirty: false };
  assert.doesNotThrow(() => verifyPackageMetadata({ ...metadata }, metadata));
  for (const actual of [null, {}, { ...metadata, release: 'v0.1.0-alpha.2' },
    { ...metadata, commit: 'b'.repeat(40) }, { ...metadata, dirty: true }]) {
    assert.throws(() => verifyPackageMetadata(actual, metadata), /rebuild/);
  }
});

// Shared by WXT and distribution staging. A release is an exact source identity,
// not the nearest ancestor tag and not the timestamp/hash of a rebuilt ZIP.
import { execFileSync } from 'node:child_process';

const NUMBER = '(?:0|[1-9]\\d*)';
const RELEASE = new RegExp(`^v(${NUMBER}\\.${NUMBER}\\.${NUMBER})(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);

function releaseVersion(tag) {
  const match = RELEASE.exec(tag);
  if (!match || match[2]?.split('.').some((part) => /^\d+$/.test(part) && /^0\d/.test(part))) return null;
  return match[1];
}

export function resolveBuildMetadata({ root, version, env = process.env }) {
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const head = git('rev-parse', '--verify', 'HEAD') ?? '';
  const status = head ? git('status', '--porcelain', '--untracked-files=normal') : '';
  if (head && status === null) throw new Error('build metadata: cannot determine whether source is dirty');
  const dirty = Boolean(status);
  const suppliedRelease = env.PONTIS_RELEASE ?? '';
  const suppliedCommit = env.PONTIS_RELEASE_COMMIT ?? '';
  if (suppliedCommit && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(suppliedCommit)) {
    throw new Error('build metadata: commit must be a full Git object id');
  }
  const commit = suppliedCommit.toLowerCase() || head;
  if (head && suppliedCommit && commit !== head) throw new Error('build metadata: supplied commit does not match HEAD');
  const tags = head ? (git('tag', '--points-at', 'HEAD') ?? '').split('\n').filter(Boolean) : [];
  if (suppliedRelease) {
    if (releaseVersion(suppliedRelease) !== version) {
      throw new Error(`build metadata: release must be v${version}[-<prerelease>] with valid SemVer identifiers`);
    }
    if (!commit) throw new Error('build metadata: a release without Git requires an explicit full commit');
    if (dirty) throw new Error('build metadata: dirty source cannot claim a release');
    if (head && !tags.includes(suppliedRelease)) throw new Error('build metadata: release tag does not point to HEAD');
    return { release: suppliedRelease, commit, dirty: false };
  }
  const exact = tags.filter((tag) => releaseVersion(tag) === version);
  return { release: !dirty && exact.length === 1 ? exact[0] : '', commit, dirty };
}

/** Staging refuses stale or differently stamped packages before publishing a
 * catalog that would claim their runtime contains the current build identity. */
export function verifyPackageMetadata(actual, expected) {
  if (!actual || actual.release !== expected.release || actual.commit !== expected.commit || actual.dirty !== expected.dirty) {
    throw new Error('package build metadata differs from this build; rebuild both extension ZIPs');
  }
}

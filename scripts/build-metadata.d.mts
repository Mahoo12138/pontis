export interface BuildMetadata {
  release: string;
  commit: string;
  dirty: boolean;
}
export function resolveBuildMetadata(options: {
  root: string;
  version: string;
  env?: Record<string, string | undefined>;
}): BuildMetadata;
export function verifyPackageMetadata(actual: unknown, expected: BuildMetadata): void;

// Stages the compiled Web app where the Go binary embeds it.
//
// go:embed cannot reference a directory outside its own package, so a release
// build copies web/dist into server/internal/webui/dist. Only the .gitkeep
// placeholder is tracked in git; the copy here is what a release build
// produces and what the binary carries.
import { cpSync, mkdirSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'web', 'dist');
const target = join(root, 'server', 'internal', 'webui', 'dist');

if (!existsSync(source) || !statSync(join(source, 'index.html')).isFile()) {
  console.error(
    `web/dist has no index.html — run \`pnpm --filter @pontis/web build\` first (found: ${source})`,
  );
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

// The copy above deleted the directory, placeholder included. Write it back:
// it is what `go:embed` matches in a checkout that has never run this script,
// and losing it here would make the next commit break `go build ./...` for
// everyone who clones afterwards.
writeFileSync(join(target, '.gitkeep'), 'Placeholder so `go build ./...` works before a release build stages the web dist here.\n');

console.log(`staged ${source} -> ${target}`);

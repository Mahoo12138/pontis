// Keep every shipped logo derived from the editable, transparent SVG master.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const source = await readFile(resolve(root, 'assets/brand/pontis-logo.svg'), 'utf8');
// Only the graphite ribbon changes in dark mode; geometry and blue stay shared.
const dark = source.replace('#3C4349', '#D9E1EB').replace('#454D53', '#B8C5D6');
const favicon = source.replace('<defs>', `<style>
    @media (prefers-color-scheme: dark) {
      #graphite stop:first-child { stop-color: #D9E1EB; }
      #graphite stop:last-child { stop-color: #B8C5D6; }
    }
  </style>
  <defs>`);

const outputs = new Map([
  ['assets/brand/pontis-logo-dark.svg', dark],
  ...['web/public', 'extension/public'].flatMap((dir) => [
    [`${dir}/brand/pontis-logo.svg`, source],
    [`${dir}/brand/pontis-logo-dark.svg`, dark],
    [`${dir}/favicon.svg`, favicon],
  ]),
]);

// Chromium extension manifests require raster icons. Keep their alpha intact.
for (const size of [16, 32, 48, 128]) {
  outputs.set(`extension/public/icon/${size}.png`,
    new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng());
}

const stale = [];
for (const [relative, content] of outputs) {
  const path = resolve(root, relative);
  if (check) {
    const actual = await readFile(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!actual?.equals(Buffer.from(content))) stale.push(relative);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
if (stale.length) {
  console.error(`Brand assets need regeneration (pnpm brand:generate):\n${stale.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`${check ? 'Verified' : 'Generated'} ${outputs.size} brand assets from assets/brand/pontis-logo.svg`);
}

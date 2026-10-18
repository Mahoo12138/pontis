// Layout invariants for the extension's settings surfaces (issue #4).
//
// The complaint was that the pages had drifted into a mess: three different
// section-heading shapes, spacing values off the theme scale, and one tab on
// Mantine's default palette while the rest used the registered colors. Those are
// properties of the source rather than of any single render, so they are checked
// at the source: a grep guard fails where a component test would stay quiet, and
// it fails at the moment the second pattern is reintroduced.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

/** Files that make up the settings surfaces the issue is about. */
const SURFACES = [
  'entrypoints/options/App.tsx',
  'ui/StartPageSettings.tsx',
  'ui/AccountTab.tsx',
  'ui/DiagnosticsPanel.tsx',
  'ui/ResyncIntents.tsx',
  'ui/SyncTab.tsx',
  'ui/Emptyish.tsx',
  'ui/Section.tsx',
];

/**
 * Mantine spacing tokens; a bare number in these props is off the scale.
 * The leading whitespace matters: without it `step={5}` reads as `p={5}`.
 */
const OFF_SCALE_SPACING = /(?:^|\s)(?:gap|mt|mb|ml|mr|p|px|py|mx|my)=\{(?!0\b)[0-9]+\}/gm;

/**
 * Palette names Mantine ships that this app re-declares under its own tokens.
 * No trailing word boundary: the pattern ends on a quote, and `\b` after a
 * non-word character never matches — which is what made this check vacuous.
 */
const DEFAULT_PALETTE = /\b(?:color|c)="(?:blue|red|amber|gray|grey|green|orange|violet|teal)"/g;

describe('settings layout invariants', () => {
  it('uses no Divider as a section heading', () => {
    const offenders = SURFACES.filter((f) => /<Divider\s+label=/.test(read(f)));
    expect(offenders, `section headings come from Section/SectionHeading only: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps every spacing prop on the theme scale', () => {
    const found: string[] = [];
    for (const file of SURFACES) {
      for (const match of read(file).matchAll(OFF_SCALE_SPACING)) {
        found.push(`${file}: ${match[0]}`);
      }
    }
    expect(found, 'use gap="sm" / mt="xs" etc. from pontisTheme spacing').toEqual([]);
  });

  it('colors the settings surfaces with the registered palette only', () => {
    const found: string[] = [];
    for (const file of SURFACES) {
      for (const match of read(file).matchAll(DEFAULT_PALETTE)) {
        found.push(`${file}: ${match[0]}`);
      }
    }
    expect(found, 'accentBlue / errorRed / warningAmber / coolGray / healthyGreen are the theme colors').toEqual([]);
  });

  it('routes section headings through the shared Section module', () => {
    // A raw `.pontis-sectionTitle` outside Section.tsx means a second heading
    // shape has grown somewhere else.
    const strays = SURFACES.filter((f) => f !== 'ui/Section.tsx' && read(f).includes('pontis-sectionTitle'));
    expect(strays).toEqual([]);
  });
});

// The colour read out of a wallpaper ends up as the ground under every word on
// the start page, so two things have to hold: it is the picture's own colour
// rather than an artefact of how the sample was bucketed, and it never costs the
// page its legibility floor (§0.6).

import { describe, expect, it } from 'vitest';
import {
  LEGIBILITY_FLOOR,
  MUTED_TEXT,
  READING_SURFACE_COVER,
  contrastRatio,
  dominantHsl,
  groundLegibility,
  groundTints,
  hexToRgb,
  hslToHex,
  hueDistance,
  isStoredTint,
  mixOver,
  normalizeTint,
  rgbToHsl,
  tintsFromPixels,
} from './tint';

const BLUE: [number, number, number] = [58, 105, 178];
const ORANGE: [number, number, number] = [226, 129, 38];
const GREY: [number, number, number] = [128, 128, 128];

/** `count` copies of one colour, as an RGBA run of the kind a canvas hands back. */
function swatch(r: number, g: number, b: number, count: number, a = 255): number[] {
  const out = new Array<number>(count * 4);
  for (let i = 0; i < count; i++) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

function mix(...parts: number[][]): number[] {
  const out: number[] = [];
  for (const part of parts) out.push(...part);
  return out;
}

describe('rgbToHsl / hslToHex', () => {
  it('round-trips the corners of the cube', () => {
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(rgbToHsl(0, 255, 0)).toMatchObject({ h: 120, s: 1 });
    expect(rgbToHsl(0, 0, 255)).toMatchObject({ h: 240, s: 1 });
    expect(rgbToHsl(255, 255, 255)).toMatchObject({ h: 0, s: 0, l: 1 });
    expect(rgbToHsl(128, 128, 128).s).toBe(0);
    expect(rgbToHsl(128, 128, 128).l).toBeCloseTo(0.502, 2);
    expect(hslToHex({ h: 0, s: 1, l: 0.5 })).toBe('#ff0000');
    expect(hslToHex({ h: 214, s: 0, l: 1 })).toBe('#ffffff');
    expect(hslToHex({ h: 214, s: 0, l: 0 })).toBe('#000000');
  });

  it('keeps a malformed colour malformed-free', () => {
    expect(hslToHex({ h: -30, s: 1, l: 0.5 })).toBe(hslToHex({ h: 330, s: 1, l: 0.5 }));
    expect(hslToHex({ h: 10, s: 5, l: 2 })).toMatch(/^#[0-9a-f]{6}$/);
    expect(hslToHex({ h: 700, s: -1, l: -1 })).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('measures hues the short way round the wheel', () => {
    expect(hueDistance(359, 1)).toBeCloseTo(2, 5);
    expect(hueDistance(0, 180)).toBeCloseTo(180, 5);
    expect(hueDistance(216, 216.4)).toBeLessThan(0.5);
  });
});

describe('hex parsing', () => {
  it('accepts the forms a colour picker hands over and normalises them', () => {
    expect(hexToRgb('#0a1B2c')).toEqual([10, 27, 44]);
    expect(normalizeTint('#abc')).toBe('#aabbcc');
    expect(normalizeTint(' #ABC ')).toBe('#aabbcc');
    expect(normalizeTint('#AaBbCc')).toBe('#aabbcc');
  });

  it('refuses anything that is not a plain hex colour', () => {
    // A stored value is substituted into a CSS custom property that every glass
    // layer on the page reads, so a row edited by hand must not survive.
    expect(normalizeTint('red')).toBeNull();
    expect(normalizeTint('var(--pontis-workspace-bg)')).toBeNull();
    expect(normalizeTint('#ff00')).toBeNull();
    expect(normalizeTint(undefined)).toBeNull();
    expect(normalizeTint(null)).toBeNull();
    expect(isStoredTint('#aabbcc')).toBe(true);
    expect(isStoredTint('#abc')).toBe(false);
    expect(isStoredTint('aabbcc')).toBe(false);
  });
});

describe('dominantHsl', () => {
  it('answers with the colour that covers the picture', () => {
    const base = dominantHsl(mix(swatch(...BLUE, 400), swatch(...ORANGE, 40)))!;
    expect(hueDistance(base.h, rgbToHsl(...BLUE).h)).toBeLessThan(1);
  });

  it('follows the coloured part of a picture rather than its grey surround', () => {
    // The grey is the larger area. It carries almost no hue, and a background
    // taken from it would be the theme's own colour with extra steps.
    const base = dominantHsl(mix(swatch(...GREY, 300), swatch(...BLUE, 120)))!;
    expect(hueDistance(base.h, rgbToHsl(...BLUE).h)).toBeLessThan(1);
  });

  it('averages a hue that straddles zero as 359° and 1°', () => {
    const red: [number, number, number] = [235, 30, 30];
    const pink: [number, number, number] = [240, 40, 50];
    const base = dominantHsl(mix(swatch(...red, 200), swatch(...pink, 200)))!;
    // An ordinary mean of the two answers somewhere near 180°.
    expect(base.h).toBeGreaterThan(340);
    expect(hueDistance(base.h, 358)).toBeLessThan(4);
  });

  it('ignores transparent pixels and blown highlights', () => {
    const base = dominantHsl(mix(swatch(...BLUE, 200, 0), swatch(252, 252, 255, 200), swatch(...ORANGE, 120)))!;
    expect(hueDistance(base.h, rgbToHsl(...ORANGE).h)).toBeLessThan(1);
  });

  it('says nothing about a black-and-white photograph', () => {
    expect(dominantHsl(swatch(...GREY, 400))).toBeNull();
    expect(dominantHsl(mix(swatch(0, 0, 0, 200), swatch(255, 255, 255, 200)))).toBeNull();
    // One percent of the sample in coloured pixels is not a dominant colour.
    expect(dominantHsl(mix(swatch(...GREY, 990), swatch(...BLUE, 10)))).toBeNull();
    expect(dominantHsl([])).toBeNull();
    expect(dominantHsl(swatch(200, 30, 40, 300, 10))).toBeNull();
  });

  it('reads a two-colour picture as one of its two colours, not as their grey mix', () => {
    const base = dominantHsl(mix(swatch(...BLUE, 300), swatch(200, 30, 40, 300)))!;
    const blue = rgbToHsl(...BLUE).h;
    const red = rgbToHsl(200, 30, 40).h;
    expect(Math.min(hueDistance(base.h, blue), hueDistance(base.h, red))).toBeLessThan(12);
  });
});

describe('groundTints', () => {
  it('keeps the hue where it is visible, and the lightness where it is not', () => {
    const base = rgbToHsl(...BLUE);
    const tints = groundTints(base);
    const light = hexToRgb(tints.light)!;
    const dark = hexToRgb(tints.dark)!;
    // A cool picture gives two cool grounds, one at each end of the scale.
    expect(light[2]).toBeGreaterThan(light[0]);
    expect(dark[2]).toBeGreaterThan(dark[0]);
    expect(Math.min(...light)).toBeGreaterThanOrEqual(238);
    expect(Math.max(...dark)).toBeLessThanOrEqual(45);
    expect(contrastRatio(tints.light, tints.dark)).toBeGreaterThan(10);
    // The dark half carries the hue to the degree. The light half is pale by
    // order of the §0.6 floor, which leaves it three bytes wide: 8-bit storage
    // cannot hold a hue at that chroma, so what is promised of it is the side
    // of the wheel and the near-white, not the angle.
    expect(hueDistance(rgbToHsl(...dark).h, base.h)).toBeLessThan(8);
    expect(hueDistance(rgbToHsl(...light).h, base.h)).toBeLessThan(48);
  });

  it('takes the picture\'s chroma but not all of it', () => {
    const flat = groundTints({ h: 200, s: 0.02, l: 0.5 });
    const vivid = groundTints({ h: 200, s: 1, l: 0.5 });
    const vividS = rgbToHsl(...hexToRgb(vivid.light)!).s;
    const flatS = rgbToHsl(...hexToRgb(flat.light)!).s;
    expect(vividS).toBeGreaterThan(flatS);
    expect(vividS).toBeLessThan(0.3);
  });

  it('produces only values the store accepts', () => {
    for (let h = 0; h < 360; h += 15) {
      const tints = groundTints({ h, s: 0.6, l: 0.5 });
      expect(isStoredTint(tints.light)).toBe(true);
      expect(isStoredTint(tints.dark)).toBe(true);
      expect(normalizeTint(tints.light)).toBe(tints.light);
    }
  });
});

describe('tintsFromPixels', () => {
  it('is null exactly when there is no dominant colour', () => {
    expect(tintsFromPixels(swatch(...GREY, 200))).toBeNull();
    expect(tintsFromPixels(swatch(...BLUE, 200))).not.toBeNull();
  });
});

describe('legibility', () => {
  it('knows the contrast ratios it reports', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 2);
    expect(mixOver('#ffffff', '#000000', 0.82)).toBe('#d1d1d1');
    expect(contrastRatio('#808080', '#808080')).toBeCloseTo(1, 2);
  });

  // The floor the start page is specified against (§0.6): a pure black
  // photograph, full opacity, a bookmark tile laid over it at
  // --pontis-glass-surface. Sweeping every hue at full chroma is what keeps a
  // tweak to the bands above from quietly taking the page under 4.5:1.
  it('holds the floor for every hue it can derive', () => {
    for (let h = 0; h < 360; h += 5) {
      for (const s of [0.02, 0.5, 1]) {
        const tints = groundTints({ h, s, l: 0.5 });
        expect(groundLegibility(tints.light, 'light'), `h=${h} ${tints.light} light`).toBeGreaterThanOrEqual(
          LEGIBILITY_FLOOR,
        );
        expect(groundLegibility(tints.dark, 'dark'), `h=${h} ${tints.dark} dark`).toBeGreaterThanOrEqual(
          LEGIBILITY_FLOOR,
        );
      }
    }
  });

  it('says so when a hand-picked colour would break it', () => {
    // The theme's own grounds are the reference: a legible colour must pass.
    expect(groundLegibility('#ffffff', 'light')).toBeGreaterThan(LEGIBILITY_FLOOR);
    expect(groundLegibility('#17191c', 'dark')).toBeGreaterThan(LEGIBILITY_FLOOR);
    // One mid grey suits neither scheme's text.
    expect(groundLegibility('#808080', 'light')).toBeLessThan(LEGIBILITY_FLOOR);
    expect(groundLegibility('#808080', 'dark')).toBeLessThan(LEGIBILITY_FLOOR);
    expect(groundLegibility('not a colour', 'light')).toBe(1);
  });

  it('moves with how much ground the reading surface lays down', () => {
    // The same colour passes at the layer the page ships with and fails once the
    // reader dials that layer thin — which is why the settings page measures the
    // two together rather than the hue alone.
    const solid = groundLegibility('#f6f8f9', 'light');
    const thin = groundLegibility('#f6f8f9', 'light', 0.5);
    expect(solid).toBeGreaterThanOrEqual(LEGIBILITY_FLOOR);
    expect(thin).toBeLessThan(solid);
    expect(thin).toBeLessThan(LEGIBILITY_FLOOR);
  });

  it('measures against the text and the surface the page actually uses', () => {
    expect(MUTED_TEXT.light).toBe('#4b5563');
    expect(MUTED_TEXT.dark).toBe('#9ca3af');
    expect(READING_SURFACE_COVER).toBe(0.82);
  });
});

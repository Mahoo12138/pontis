// Reading one colour out of a wallpaper and pushing it to the two ends of the
// lightness scale, so the page's own background belongs to the picture sitting
// on it.
//
// Everything here is arithmetic on plain numbers; the pixels arrive from a
// canvas in appearance.ts. That split is what makes the choice of hue testable:
// vitest runs this file in node, with no browser to decode an image.

export type Hsl = { h: number; s: number; l: number };
export type GroundTints = { light: string; dark: string };
export type Scheme = 'light' | 'dark';

/** 24 bins of 15°: wide enough that a sky gradient does not split over a bin
 * edge and lose to a smaller, denser patch of colour, narrow enough that red
 * and magenta stay apart. */
const HUE_BINS = 24;
const BIN_WIDTH = 360 / HUE_BINS;

/** Outside these bands a pixel is grey, blown out or crushed: it tells you
 * about the picture's exposure, not about what it is coloured. */
const MIN_SATURATION = 0.12;
const MIN_LIGHTNESS = 0.08;
const MAX_LIGHTNESS = 0.9;

/** Below this share of the sample the picture is a black-and-white photograph.
 * There is no hue to read out of it, and one invented from rounding noise makes
 * a worse background than the theme's own colour. */
const MIN_CHROMATIC_SHARE = 0.02;

/** The two bands a derived background is pushed into. The light one is a
 * constraint, not a taste choice: a bookmark tile lays 82% of this colour over
 * whatever shows through, and at full opacity the worst case the spec allows
 * for is a pure black photograph (§0.6). The hue sweep in tint.test.ts re-checks
 * that combination, so the lightness stays within a hair of white.
 *
 * The dark band sits a step above the theme's graphite so the hue still reads
 * through a wallpaper that is doing the darkening. */
const LIGHT_SATURATION = { min: 0.08, max: 0.22 };
const LIGHT_LIGHTNESS = 0.972;
const DARK_SATURATION = { min: 0.12, max: 0.34 };
const DARK_LIGHTNESS = 0.115;

/** The reading surface's ground as a fraction of the page colour
 * (`--pontis-glass-surface`), and the two muted text colours it has to hold
 * (`--pontis-text-muted`, per scheme). */
export const READING_SURFACE_COVER = 0.82;
export const MUTED_TEXT: Record<Scheme, string> = { light: '#4b5563', dark: '#9ca3af' };

/** The floor the start-page spec measures against (§0.6). */
export const LEGIBILITY_FLOOR = 4.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The short way round a colour wheel. Hues 1° apart are neighbours, and a
 * plain difference of 359 and 1 reads as 358 apart. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h * 60 + 360) % 360, s: clamp(s, 0, 1), l };
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const text = hex.trim().replace(/^#/, '');
  const full =
    text.length === 3
      ? text
          .split('')
          .map((c) => c + c)
          .join('')
      : text;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * clamp(s, 0, 1);
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** Only a value this module produced may reach a CSS custom property. The row
 * comes back out of IndexedDB where a hand-edited value could hold anything,
 * and `--pontis-workspace-bg` is substituted into every glass layer on the
 * page. */
export function isStoredTint(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value);
}

/** Anything a user or a picker hands over, in the one form storage accepts —
 * `#rrggbb`, lower case — or null when it is not a colour at all. */
export function normalizeTint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const rgb = hexToRgb(value);
  return rgb ? rgbToHex(...rgb) : null;
}

/**
 * The picture's dominant colour, or null when there is nothing to read.
 *
 * `pixels` is a flat RGBA array — an `ImageData.data` — sampled small. Hue is
 * taken from a chroma-weighted histogram rather than an area count, because a
 * photograph's subject is usually the coloured part of it and the grey around it
 * is the larger area; the answer is a hue and a chroma, and the lightness of
 * individual pixels is deliberately not carried through.
 */
export function dominantHsl(pixels: ArrayLike<number>): Hsl | null {
  const zero = () => ({ weight: 0, sat: 0, light: 0, x: 0, y: 0, count: 0 });
  const bins = Array.from({ length: HUE_BINS }, zero);
  /** Neighbour bins are read by offset and wrap round the wheel. */
  const at = (index: number) => bins[((index % HUE_BINS) + HUE_BINS) % HUE_BINS] ?? zero();

  let seen = 0;
  let colored = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3] ?? 0;
    // A transparent pixel is not a colour in the picture: the page shows
    // through it, so it must not count as either evidence or area.
    if (a < 128) continue;
    seen++;
    const c = rgbToHsl(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
    if (c.s < MIN_SATURATION || c.l < MIN_LIGHTNESS || c.l > MAX_LIGHTNESS) continue;
    colored++;
    const bin = at(Math.floor(c.h / BIN_WIDTH));
    bin.weight += c.s;
    bin.sat += c.s;
    bin.light += c.l;
    const rad = (c.h * Math.PI) / 180;
    bin.x += c.s * Math.cos(rad);
    bin.y += c.s * Math.sin(rad);
    bin.count++;
  }

  if (seen === 0 || colored / seen < MIN_CHROMATIC_SHARE) return null;

  let best = 0;
  let top = -1;
  for (let b = 0; b < HUE_BINS; b++) {
    // A hue that lands on a bin edge splits its area between two bins, so the
    // winner is read off a smoothed histogram...
    const score = at(b - 1).weight / 2 + at(b).weight + at(b + 1).weight / 2;
    if (score > top) {
      top = score;
      best = b;
    }
  }

  // ...and the three bins that produced that score are averaged together.
  const around = [at(best - 1), at(best), at(best + 1)];
  let wx = 0;
  let wy = 0;
  let sat = 0;
  let light = 0;
  let inBins = 0;
  for (const bin of around) {
    wx += bin.x;
    wy += bin.y;
    sat += bin.sat;
    light += bin.light;
    inBins += bin.count;
  }
  // Opposing hues can cancel to no direction at all. That is a grey picture
  // wearing coloured pixels, and the answer to it is the same: no hue.
  if (inBins === 0 || Math.hypot(wx, wy) < 1e-9) return null;

  // The hue is a circular mean, not an average: the ordinary mean of 359° and
  // 1° answers 180°, the one hue a picture like that certainly is not.
  return {
    h: (Math.atan2(wy, wx) * (180 / Math.PI) + 360) % 360,
    s: clamp(sat / inBins, 0, 1),
    l: clamp(light / inBins, 0, 1),
  };
}

/** The two background colours a dominant colour becomes: same hue, one pushed
 * near white and one near black, chroma kept inside the band each end can hold
 * without putting the text on the page at risk. */
export function groundTints(base: Hsl): GroundTints {
  return {
    light: hslToHex({ h: base.h, s: clamp(base.s, LIGHT_SATURATION.min, LIGHT_SATURATION.max), l: LIGHT_LIGHTNESS }),
    dark: hslToHex({ h: base.h, s: clamp(base.s, DARK_SATURATION.min, DARK_SATURATION.max), l: DARK_LIGHTNESS }),
  };
}

export function tintsFromPixels(pixels: ArrayLike<number>): GroundTints | null {
  const base = dominantHsl(pixels);
  return base ? groundTints(base) : null;
}

/** `fg` laid over `bg` at `alpha`, as stored colours are laid over a wallpaper. */
export function mixOver(fg: string, bg: string, alpha: number): string {
  const top = hexToRgb(fg);
  const under = hexToRgb(bg);
  if (!top || !under) return fg;
  const a = clamp(alpha, 0, 1);
  const [tr, tg, tb] = top;
  const [ur, ug, ub] = under;
  return rgbToHex(tr * a + ur * (1 - a), tg * a + ug * (1 - a), tb * a + ub * (1 - a));
}

function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb;
  const linear = (v: number) => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const one = relativeLuminance(a);
  const two = relativeLuminance(b);
  const lighter = Math.max(one, two);
  const darker = Math.min(one, two);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * How readable the page's own secondary text stays on a proposed background.
 *
 * Measured the way the spec's floor is measured — at the worst case rather than
 * the average one: a pure black photograph, full opacity, and the reading
 * surface's ground over it (§0.6). `cover` is that surface's share, which the
 * reader can now set; the default is the value the layers step from. A colour
 * that answers below the floor is still the user's to choose, but the settings
 * page says what it costs.
 */
export function groundLegibility(tintHex: string, scheme: Scheme, cover = READING_SURFACE_COVER): number {
  const stored = normalizeTint(tintHex);
  if (!stored) return 1;
  return contrastRatio(MUTED_TEXT[scheme], mixOver(stored, '#000000', cover));
}
